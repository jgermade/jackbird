// A phone's unattended check (E6's spike, mobile.yml): a debug build made
// with VITE_JACKBIRD_PHONE_CHECK (its instance's address, a folder of that
// machine, and where to post the report) connects to the instance, opens the
// folder, lists its tracks, plays a FLAC a few seconds (muted: a page may not
// start sound by itself) and posts what it found. Nothing happens otherwise.
// See RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (E6).

import { isAudioFile } from "../helpers/formats";
import { emptyMetadata } from "../helpers/metadata";
import type { RootSource } from "../types";

/** `deviceFolder`: a folder of the phone (its `content://` address) with the fixtures in it, chosen in Android's folder picker (E6b-D9). */
type PhoneCheck = { address: string; folder: string; report: string; deviceFolder?: string };

/** The check this build was made for, if any. */
export function phoneCheck(): PhoneCheck | null {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const text = env?.VITE_JACKBIRD_PHONE_CHECK;
  if (!text) return null;
  try {
    return JSON.parse(text) as PhoneCheck;
  } catch {
    return null;
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Plays a URL a few seconds, muted; how far it got. */
async function play(url: string): Promise<{ played: number; error?: string; firstError?: string }> {
  const audio = new Audio();
  // As the player's element: asked for with CORS, the instance answers the app's origin.
  audio.crossOrigin = "anonymous";
  audio.muted = true;
  audio.src = url;
  try {
    await audio.play();
    for (let step = 0; step < 30; step += 1) await wait(100);
    return { played: audio.currentTime };
  } catch (error) {
    return { played: audio.currentTime, error: `${error} (media error ${audio.error?.code ?? "none"})` };
  } finally {
    audio.pause();
  }
}

/** Tells the check's receiver how far the page got (each step, and any error), so a check that
 * hangs says where. */
function beacon(config: PhoneCheck, step: string, detail: unknown = null): void {
  console.log(`JACKBIRD-STEP ${step} ${JSON.stringify(detail)}`);
  void fetch(`${config.report}?phase=step`, { method: "POST", body: JSON.stringify({ step, detail }) }).catch(() => undefined);
}

export async function runPhoneCheckIfBuilt(): Promise<void> {
  const config = phoneCheck();
  if (!config) return;
  beacon(config, "started", { href: location.href, userAgent: navigator.userAgent });
  window.addEventListener("error", (event) => beacon(config, "error", String(event.message)));
  window.addEventListener("unhandledrejection", (event) => beacon(config, "rejection", String(event.reason)));
  // A heartbeat: if it stops, the page's thread is stuck; if it goes on, a request is.
  const started = Date.now();
  const heartbeat = setInterval(() => beacon(config, "alive", Math.round((Date.now() - started) / 1000)), 5000);
  // Each step has 30 seconds: one that hangs is reported, not waited for.
  const within = <T>(step: string, work: Promise<T>, ms = 30_000): Promise<T> =>
    Promise.race([work, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${step}: no answer in ${ms / 1000} s`)), ms))]);
  const report: Record<string, unknown> = { userAgent: navigator.userAgent, drawn: Boolean(document.querySelector("#app")?.children.length) };
  try {
    const info = await fetch(`${config.address}/api/info`).then(
      (response) => response.status,
      (error: unknown) => String(error)
    );
    beacon(config, "info", info);
    // The instance is added as a source, as a person does (E6b-D11): "Add to the library…", its address.
    const { adding, addServer } = await import("./adding");
    await within("add the server", addServer(config.address));
    beacon(config, "server", adding.error || "added");
    const { account } = await import("./account");
    for (let step = 0; step < 200 && !account.me; step += 1) await wait(100);
    report.me = account.me ? { name: account.me.name, role: account.me.role } : null;
    beacon(config, "account", { me: report.me, error: account.error, needed: account.needed });
    const { openServiceFolder } = await import("./sources/service");
    beacon(config, "opening", config.folder);
    const source = await within("open the folder", openServiceFolder(config.folder));
    beacon(config, "folder");
    const tracks = (await within("walk", source.walk())).filter((entry) => isAudioFile(entry.path));
    report.tracks = tracks.length;
    beacon(config, "walked", tracks.length);
    const flac = tracks.find((track) => track.path.toLowerCase().endsWith(".flac"));
    if (flac) {
      const media = await within("open the media", source.openMedia(flac.path));
      // Once more on a new element if it did not play: a simulator's media request can stall and be
      // aborted with no media error (seen on iOS, 2026-11-12), which says nothing of the app.
      let played = await play(media.url);
      if (played.error || !(played.played > 0)) {
        beacon(config, "played-retry", played);
        const again = await within("open the media again", source.openMedia(flac.path));
        played = { ...(await play(again.url)), ...(played.error ? { firstError: played.error } : {}) };
      }
      report.played = { path: flac.path, ...played };
      beacon(config, "played", report.played);
    }
    if (config.deviceFolder) {
      report.device = await within("the phone's folder", checkPhoneFolder(config, config.deviceFolder), 120_000);
      beacon(config, "device", report.device);
    }

  } catch (error) {
    report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  clearInterval(heartbeat);
  console.log(`JACKBIRD-CHECK ${JSON.stringify(report)}`);
  await fetch(config.report, { method: "POST", body: JSON.stringify(report) }).catch(() => undefined);
  await measureBackground(config).catch((error: unknown) => console.log(`JACKBIRD-BACKGROUND failed: ${error}`));
}

/**
 * Background playback (E6-D1 c), as a queue plays: twenty seconds of silence with sound (both
 * webviews pause a muted element when hidden; muted only if the webview refuses), and when it ends,
 * a new media URL asked of the instance and played, again and again. Every second it notes how far
 * the queue got and whether the page is hidden, and each change of song, while the check sends the
 * app to the background and back (scripts/phone-check.mjs). The page says when it is hidden (a phone
 * may take long to put another app in front), and stops ten seconds after it is shown again, or
 * after 240 s; then posts what it saw. A change made while hidden is what a queue needs.
 */
async function measureBackground(config: PhoneCheck): Promise<void> {
  const { openServiceFolder } = await import("./sources/service");
  const source = await openServiceFolder(config.folder);
  const song = (await source.walk()).find((entry) => entry.path.endsWith("silence-20s.flac"));
  if (!song) return;
  const { phoneAudioAvailable } = await import("./phone-audio");
  if (phoneAudioAvailable) {
    await measureNativeQueue(config, () => source.openMedia(song.path).then((media) => media.url));
    return;
  }
  const audio = new Audio();
  // As the player's element: asked for with CORS, the instance answers the app's origin.
  audio.crossOrigin = "anonymous";
  audio.src = (await source.openMedia(song.path)).url;
  // The lock screen's and the notification's controls, if the webview gives the page the system's
  // media session (scripts/phone-check.mjs looks for it on Android).
  const mediaSession = "mediaSession" in navigator;
  if (mediaSession) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: "jackbird check", artist: "jackbird", album: "E6" });
    navigator.mediaSession.setActionHandler("pause", () => audio.pause());
    navigator.mediaSession.setActionHandler("play", () => void audio.play());
  }
  let muted = false;
  try {
    await audio.play();
  } catch {
    muted = true;
    audio.muted = true;
    await audio.play();
  }
  const started = Date.now();
  // The songs played to their end, and each change of song, step by step: when it ended (and
  // whether hidden), when the instance gave the next one's URL, when play() settled, and how.
  let done = 0;
  type Change = { at: number; hidden: boolean; url?: number; played?: number; started?: boolean; error?: string };
  const changes: Change[] = [];
  const now = () => Date.now() - started;
  audio.addEventListener("ended", () => {
    done += 1;
    const change: Change = { at: now(), hidden: document.hidden };
    changes.push(change);
    void source
      .openMedia(song.path)
      .then(async (media) => {
        change.url = now();
        audio.src = media.url;
        await audio.play();
        change.played = now();
        change.started = true;
      })
      .catch((error: unknown) => {
        change.played = now();
        change.started = false;
        change.error = String(error);
      });
  });
  const post = (phase: string, body: unknown) =>
    fetch(`${config.report}?phase=${phase}`, { method: "POST", body: JSON.stringify(body) }).catch(() => undefined);
  let wasHidden = false;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && !wasHidden) void post("hidden", {});
    wasHidden ||= document.hidden;
  });
  const samples: { at: number; played: number; hidden: boolean; paused: boolean }[] = [];
  let shownAgain: number | null = null;
  await post("playing", { muted, mediaSession });
  while (Date.now() - started < 240_000 && (shownAgain === null || Date.now() - shownAgain < 10_000)) {
    // How far the queue got: the songs ended, and the current one's position.
    const played = done * (audio.duration || 20) + audio.currentTime;
    samples.push({ at: now(), played, hidden: document.hidden, paused: audio.paused });
    if (wasHidden && !document.hidden) shownAgain ??= Date.now();
    await wait(1000);
  }
  audio.pause();
  await post("background", { muted, mediaSession, samples, changes });
}

/**
 * Background playback through the phone's native player (E6b-D7): a queue of five 20 s silences
 * handed to it at once, while the check sends the app away for two minutes as above. The player
 * goes through them by itself; the page notes each change of song it is told of (when, and whether
 * hidden) and samples how far the queue got. Every change made while hidden must have happened
 * (scripts/phone-check.mjs).
 */
async function measureNativeQueue(config: PhoneCheck, mediaUrl: () => Promise<string>): Promise<void> {
  const { PhoneAudio } = await import("./phone-audio");
  const audio = new PhoneAudio();
  const songs = [];
  for (let n = 1; n <= 5; n += 1) {
    songs.push({ key: `silence-${n}`, url: await mediaUrl(), title: `Silence ${n}`, artist: "jackbird check", album: "E6b" });
  }
  const started = Date.now();
  const now = () => Date.now() - started;
  const changes: { at: number; hidden: boolean; key: string; started: boolean }[] = [];
  audio.addEventListener("advance", (event) =>
    changes.push({ at: now(), hidden: document.hidden, key: (event as CustomEvent<string>).detail, started: true })
  );
  let ended: number | null = null;
  audio.addEventListener("ended", () => (ended = now()));
  const failures: unknown[] = [];
  audio.addEventListener("fallback", (event) => failures.push((event as CustomEvent).detail));
  const post = (phase: string, body: unknown) =>
    fetch(`${config.report}?phase=${phase}`, { method: "POST", body: JSON.stringify(body) }).catch(() => undefined);
  let wasHidden = false;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && !wasHidden) void post("hidden", {});
    wasHidden ||= document.hidden;
  });
  audio.open(songs[0]);
  audio.setUpcoming(songs.slice(1));
  await audio.play();
  const samples: { at: number; played: number; hidden: boolean; paused: boolean }[] = [];
  let shownAgain: number | null = null;
  await post("playing", { native: true, muted: false, mediaSession: false });
  while (Date.now() - started < 240_000 && (shownAgain === null || Date.now() - shownAgain < 10_000)) {
    // How far the queue got: 20 s for each song it left, and the current one's position.
    const played = ended !== null ? songs.length * 20 : changes.length * 20 + audio.currentTime;
    samples.push({ at: now(), played, hidden: document.hidden, paused: audio.paused });
    if (wasHidden && !document.hidden) shownAgain ??= Date.now();
    await wait(1000);
  }
  audio.removeAttribute("src");
  await post("background", { native: true, muted: false, mediaSession: false, samples, changes, ended, failures });
}

/**
 * A folder of the phone as a source (E6b-D9): Android's folder picker opened at it (the check taps
 * "Use this folder" and "Allow" in it, scripts/phone-check.mjs), its songs walked, a FLAC's tags read
 * by Rust through the file Android opens, and the FLAC played a moment by the native player from
 * its `content://` address. Then what is written there (E6b-D9's second part): a title saved in
 * place, a title saved into a file with no tags (the new tags do not fit: written beside and put
 * in its place), a rename into a folder, and a playlist written and read back.
 */
async function checkPhoneFolder(config: PhoneCheck, folder: string): Promise<Record<string, unknown>> {
  const { pickPhoneFolder } = await import("./sources/phone");
  const { PhoneAudio } = await import("./phone-audio");
  beacon(config, "picking", folder);
  const source = await pickPhoneFolder(folder);
  if (!source) return { picked: false };
  const tracks = (await source.walk()).filter((entry) => isAudioFile(entry.path));
  const flac = tracks.find((track) => track.path.toLowerCase().endsWith(".flac") && !track.path.includes("silence"));
  if (!flac) return { picked: true, tracks: tracks.length };
  // The tagged fixture (fixtures/tags/flac-full.flac, titled "Before") for the tags; the FLAC for playing.
  const tagged = tracks.find((track) => track.path === "flac-full.flac") ?? flac;
  const inspection = await source.inspect(tagged.path);
  const media = await source.openMedia(flac.path);
  const audio = new PhoneAudio();
  const failures: unknown[] = [];
  audio.addEventListener("fallback", (event) => failures.push((event as CustomEvent).detail));
  audio.open({ key: "phone-folder-flac", url: media.url, title: flac.path });
  await audio.play();
  for (let step = 0; step < 40 && audio.currentTime < 0.2; step += 1) await wait(100);
  const played = audio.currentTime;
  audio.removeAttribute("src");
  const written = await checkPhoneWrites(source, tagged.path).catch((error: unknown) => ({ error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }));
  return {
    written,
    picked: true,
    tracks: tracks.length,
    path: flac.path,
    tagged: tagged.path,
    title: inspection.metadata?.title ?? null,
    checksum: inspection.fullChecksum ?? null,
    played,
    failures
  };
}

/** Saves a title into a file of the phone's folder and reads it back: what it reads, and whether its audio is the same. */
async function saveTitle(source: RootSource, path: string, title: string): Promise<{ title: string | null; audioKept: boolean; returned: string | null }> {
  const before = await source.inspect(path);
  const previous = before.metadata ?? emptyMetadata();
  const saved = await source.save(path, previous, { ...previous, title });
  const after = await source.inspect(path);
  return { title: after.metadata?.title ?? null, audioKept: after.audioChecksum === before.audioChecksum, returned: saved.metadata?.title ?? null };
}

/** What a phone's folder is written: tags in place and beside, a rename, a playlist (E6b-D9's second part). */
async function checkPhoneWrites(source: RootSource, tagged: string): Promise<Record<string, unknown>> {
  const inPlace = await saveTitle(source, tagged, "Saved on the phone");
  // mp3-no-tag.mp3 has no tags: any title makes them longer, so the save goes beside and is put in its place.
  const bare = "mp3-no-tag.mp3";
  const beside = await saveTitle(source, bare, "Grown on the phone");
  const left = (await source.walk()).map((entry) => entry.path);
  const leftovers = left.filter((path) => path.includes(".jackbird-save"));
  const kept = left.includes(bare);
  await source.vfs.rename(bare, "renamed/Grown on the phone.mp3");
  const after = (await source.walk()).map((entry) => entry.path);
  const renamed = after.includes("renamed/Grown on the phone.mp3") && !after.includes(bare);
  const renamedTitle = renamed ? ((await source.inspect("renamed/Grown on the phone.mp3")).metadata?.title ?? null) : null;
  const text = "#EXTM3U\n#EXTINF:-1,Grown on the phone\nrenamed/Grown on the phone.mp3\n";
  await source.vfs.write("check.m3u8", new TextEncoder().encode(text));
  const playlist = new TextDecoder().decode(await source.vfs.read("check.m3u8")) === text;
  return { inPlace, beside: { ...beside, kept, leftovers }, renamed, renamedTitle, playlist };
}
