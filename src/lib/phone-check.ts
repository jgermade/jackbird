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

export async function runPhoneCheckIfBuilt(): Promise<void> {
  const config = phoneCheck();
  if (!config) return;
  const report: Record<string, unknown> = { userAgent: navigator.userAgent, drawn: Boolean(document.querySelector("#app")?.children.length) };
  try {
    const { account } = await import("./account");
    for (let step = 0; step < 200 && !account.me; step += 1) await wait(100);
    report.me = account.me ? { name: account.me.name, role: account.me.role } : null;
    const { openServiceFolder } = await import("./sources/service");
    const source = await openServiceFolder(config.folder);
    const tracks = (await source.walk()).filter((entry) => isAudioFile(entry.path));
    report.tracks = tracks.length;
    const flac = tracks.find((track) => track.path.toLowerCase().endsWith(".flac"));
    if (flac) {
      const media = await source.openMedia(flac.path);
      report.played = { path: flac.path, ...(await play(media.url)) };
    }
  } catch (error) {
    report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  console.log(`JACKBIRD-CHECK ${JSON.stringify(report)}`);
  await fetch(config.report, { method: "POST", body: JSON.stringify(report) }).catch(() => undefined);
}
