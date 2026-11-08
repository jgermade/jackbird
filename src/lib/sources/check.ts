// The desktop app's unattended check (E4-D8, desktop.yml): when the app is
// started with JACKBIRD_CHECK_FOLDER, it opens that folder through the same
// source the app uses, inspects every track, saves a title into one of them
// and reads it back, plays one MP3 and one FLAC for a few seconds through a
// Web Audio analyser, then opens the folder in the library as a person would
// (so the session keeps it), and reports what it found as JSON; then the app
// quits. Started again with JACKBIRD_CHECK_RESTORE, it reports what the
// session reopened. Nothing happens otherwise. See RECORD/2026-08-11.musikmatch-rust-migration.WIP.md.

import { invoke } from "@tauri-apps/api/core";
import { isAudioFile } from "../../helpers/formats";
import { emptyMetadata } from "../../helpers/metadata";
import { library } from "../library";
import { hydrateRoot } from "../roots";
import { restoreSource } from "./index";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Plays a track a few seconds; how far it got and the analyser's loudest band. */
async function play(url: string): Promise<{ played: number; analyser: number; error?: string }> {
  const audio = new Audio();
  audio.crossOrigin = "anonymous";
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  context.createMediaElementSource(audio).connect(analyser);
  analyser.connect(context.destination);
  audio.src = url;
  let loudest = 0;
  try {
    await context.resume();
    await audio.play();
    const bins = new Uint8Array(analyser.frequencyBinCount);
    for (let step = 0; step < 30; step += 1) {
      await wait(100);
      analyser.getByteFrequencyData(bins);
      loudest = Math.max(loudest, ...bins);
    }
    return { played: audio.currentTime, analyser: loudest };
  } catch (error) {
    return { played: audio.currentTime, analyser: loudest, error: `${error} (media error ${audio.error?.code ?? "none"})` };
  } finally {
    audio.pause();
    void context.close();
  }
}

/** Waits until the library has its roots loaded (or 20 s). */
async function settled(): Promise<void> {
  for (let step = 0; step < 200; step += 1) {
    if (!library.restoring && library.roots.length > 0 && library.roots.every((root) => !root.loadingMetadata)) {
      return;
    }
    await wait(100);
  }
}

/** What the library holds: each root's path and how many tracks it shows. */
const holding = () => library.roots.map((root) => ({ path: root.source.saved, tracks: root.tracks.length, kind: root.source.kind }));

export async function runCheckIfAsked(): Promise<void> {
  if (await invoke<boolean>("check_restore").catch(() => false)) {
    await settled();
    await invoke("check_report", { report: JSON.stringify({ restored: holding() }) });
    return;
  }
  const folder = await invoke<string | null>("check_folder").catch(() => null);
  if (!folder) {
    return;
  }
  const report: Record<string, unknown> = { folder, userAgent: navigator.userAgent, drawn: Boolean(document.querySelector("#app")?.children.length) };
  try {
    const source = await restoreSource(folder);
    if (!source) {
      throw new Error("the folder could not be opened");
    }
    const tracks = (await source.walk()).filter((entry) => isAudioFile(entry.path));
    report.tracks = tracks.length;
    const titles: Record<string, string> = {};
    for (const track of tracks) {
      titles[track.path] = (await source.inspect(track.path)).metadata?.title ?? "";
    }
    report.titles = titles;
    const target = tracks.find((track) => /padded\.mp3$/.test(track.path)) ?? tracks[0];
    if (target) {
      const before = (await source.inspect(target.path)).metadata ?? emptyMetadata();
      const saved = await source.save(target.path, before, { ...before, title: "Checked by the desktop app" });
      const after = await source.inspect(target.path);
      report.save = { path: target.path, title: after.metadata?.title, audioKept: saved.audioChecksum === after.audioChecksum };
    }
    const played: Record<string, unknown> = {};
    for (const extension of [".mp3", ".flac"]) {
      const track = tracks.find((one) => one.path.toLowerCase().endsWith(extension));
      if (track) {
        const media = await source.openMedia(track.path);
        played[extension] = { url: media.url.split(":")[0], ...(await play(media.url)) };
      }
    }
    report.played = played;
    // As a person opens a folder: the library shows it and the session keeps it.
    await hydrateRoot(source, {});
    await settled();
    report.library = holding();
    await wait(1500);
  } catch (error) {
    report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  await invoke("check_report", { report: JSON.stringify(report) });
}
