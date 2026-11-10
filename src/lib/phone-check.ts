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
 * Background playback (E6-D1 c): plays a minute of silence on a loop, with sound (both webviews
 * pause a muted element when hidden; muted only if the webview refuses), and notes every second how
 * much it has played and whether the page is hidden, while the check sends the app to the background
 * and back (scripts/phone-check.mjs). The page says when it is hidden (a phone may take long to put
 * another app in front), and stops three seconds after it is shown again, or after 240 s; then posts
 * the samples. Where it played on while the page was hidden, playback went on in the background.
 */
async function measureBackground(config: PhoneCheck): Promise<void> {
  const { openServiceFolder } = await import("./sources/service");
  const source = await openServiceFolder(config.folder);
  const long = (await source.walk()).find((entry) => entry.path.endsWith("silence-60s.flac"));
  if (!long) return;
  const audio = new Audio();
  // As the player's element: asked for with CORS, the instance answers the app's origin.
  audio.crossOrigin = "anonymous";
  audio.loop = true;
  audio.src = (await source.openMedia(long.path)).url;
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
  const post = (phase: string, body: unknown) =>
    fetch(`${config.report}?phase=${phase}`, { method: "POST", body: JSON.stringify(body) }).catch(() => undefined);
  let wasHidden = false;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && !wasHidden) void post("hidden", {});
    wasHidden ||= document.hidden;
  });
  // How much has played, across the loop's restarts.
  let played = 0;
  let last = audio.currentTime;
  const samples: { at: number; played: number; hidden: boolean; paused: boolean }[] = [];
  const started = Date.now();
  let shownAgain: number | null = null;
  await post("playing", { muted, mediaSession });
  while (Date.now() - started < 240_000 && (shownAgain === null || Date.now() - shownAgain < 3000)) {
    const now = audio.currentTime;
    played += now >= last ? now - last : now + (audio.duration || 0) - last;
    last = now;
    samples.push({ at: Date.now() - started, played, hidden: document.hidden, paused: audio.paused });
    if (wasHidden && !document.hidden) shownAgain ??= Date.now();
    await wait(1000);
  }
  audio.pause();
  await post("background", { muted, mediaSession, samples });
}
