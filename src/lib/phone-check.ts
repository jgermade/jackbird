// A phone's unattended check (E6's spike, mobile.yml): a debug build made
// with VITE_JACKBIRD_PHONE_CHECK (its instance's address, a folder of that
// machine, and where to post the report) connects to the instance, opens the
// folder, lists its tracks, plays a FLAC a few seconds (muted: a page may not
// start sound by itself) and posts what it found. Nothing happens otherwise.
// See RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (E6).

import { isAudioFile } from "../helpers/formats";

type PhoneCheck = { address: string; folder: string; report: string };

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
async function play(url: string): Promise<{ played: number; error?: string }> {
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
  const within = <T>(step: string, work: Promise<T>): Promise<T> =>
    Promise.race([work, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${step}: no answer in 30 s`)), 30_000))]);
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
      report.played = { path: flac.path, ...(await play(media.url)) };
      beacon(config, "played", report.played);
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
