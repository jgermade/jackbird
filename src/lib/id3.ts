import { ID3Writer } from "browser-id3-writer";
import jsmediatags from "jsmediatags/dist/jsmediatags.min.js";
import { keepUneditedFrames } from "../helpers/id3v2";
import type { EditableMetadata, TrackMetadata } from "../types";

type WriterAny = {
  setFrame: (id: string, value: unknown) => WriterAny;
  addTag: () => WriterAny;
  getBlob: () => Blob;
};

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function bytesToDataUrl(bytes: number[], format: string): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const base64 = window.btoa(binary);
  return `data:${format};base64,${base64}`;
}

function parseTag(file: File): Promise<TrackMetadata> {
  return new Promise((resolve) => {
    jsmediatags.read(file, {
      onSuccess: (result: { tags: Record<string, unknown> }) => {
        const tags = result.tags;
        const picture = tags.picture as
          | { data: number[]; format: string }
          | undefined;

        resolve({
          title: (tags.title as string) ?? "",
          artist: (tags.artist as string) ?? "",
          album: (tags.album as string) ?? "",
          // jsmediatags maps the year from TYER (v2.3) only; a v2.4 tag keeps it in TDRC.
          year: (tags.year as string) ?? (tags.TDRC as { data?: string } | undefined)?.data ?? "",
          genre: (tags.genre as string) ?? "",
          trackNumber: (tags.track as string) ?? "",
          coverDataUrl: picture ? bytesToDataUrl(picture.data, picture.format) : null
        });
      },
      onError: () => {
        resolve({
          title: "",
          artist: "",
          album: "",
          year: "",
          genre: "",
          trackNumber: "",
          coverDataUrl: null
        });
      }
    });
  });
}

export async function readTrackMetadataFromBytes(bytes: Uint8Array, fileName: string): Promise<TrackMetadata> {
  const file = new File([toArrayBuffer(bytes)], fileName, { type: "audio/mpeg" });
  return parseTag(file);
}

async function imageToBytes(dataUrl: string): Promise<Uint8Array> {
  const response = await fetch(dataUrl);
  const arrayBuffer = await response.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}

function guessMimeTypeFromDataUrl(dataUrl: string): string {
  const matches = dataUrl.match(/^data:([^;]+);base64,/);
  return matches ? matches[1] : "image/jpeg";
}

export async function writeTrackMetadataToBytes(
  sourceBytes: Uint8Array,
  metadata: EditableMetadata
): Promise<Uint8Array> {
  const writerBase = new ID3Writer(toArrayBuffer(sourceBytes));
  const writer = writerBase as unknown as WriterAny;

  writer.setFrame("TIT2", metadata.title || "");
  writer.setFrame("TPE1", [metadata.artist || ""]);
  writer.setFrame("TALB", metadata.album || "");

  if (metadata.year) {
    writer.setFrame("TYER", metadata.year);
  }
  if (metadata.genre) {
    writer.setFrame("TCON", [metadata.genre]);
  }
  if (metadata.trackNumber) {
    writer.setFrame("TRCK", metadata.trackNumber);
  }

  if (metadata.coverDataUrl) {
    const imageBytes = await imageToBytes(metadata.coverDataUrl);
    writer.setFrame("APIC", {
      type: 3,
      data: imageBytes,
      description: "Cover",
      useUnicodeEncoding: false,
      mimeType: guessMimeTypeFromDataUrl(metadata.coverDataUrl)
    });
  }

  writer.addTag();
  const blob = writer.getBlob();
  // The writer drops the whole tag it found: put back the frames the editor does not manage.
  return keepUneditedFrames(sourceBytes, new Uint8Array(await blob.arrayBuffer()));
}

export function getAudioFrameSlice(bytes: Uint8Array): Uint8Array {
  let start = 0;
  let end = bytes.length;

  // Check ID3v2 header at offset 0
  if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const flags = bytes[5];
    const hasFooter = Boolean(flags & 0x10);
    const tagSize =
      ((bytes[6] & 0x7f) << 21) |
      ((bytes[7] & 0x7f) << 14) |
      ((bytes[8] & 0x7f) << 7) |
      (bytes[9] & 0x7f);
    start = 10 + tagSize + (hasFooter ? 10 : 0);
  }

  // Check ID3v1 tag at end of file (128 bytes)
  if (
    end - start > 128 &&
    bytes[end - 128] === 0x54 &&
    bytes[end - 127] === 0x41 &&
    bytes[end - 126] === 0x47
  ) {
    end -= 128;
  }

  // Check APEv2 footer at end of file (32 bytes)
  if (
    end - start > 32 &&
    bytes[end - 32] === 0x41 &&
    bytes[end - 31] === 0x50 &&
    bytes[end - 30] === 0x45 &&
    bytes[end - 29] === 0x54 &&
    bytes[end - 28] === 0x41 &&
    bytes[end - 27] === 0x47 &&
    bytes[end - 26] === 0x45 &&
    bytes[end - 25] === 0x58
  ) {
    end -= 32;
  }

  if (start >= end || start >= bytes.length) {
    return bytes;
  }

  return bytes.subarray(start, end);
}

export async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const stable = new Uint8Array(bytes.byteLength);
  stable.set(bytes);
  const digest = await crypto.subtle.digest("SHA-1", stable.buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function calculateDualChecksums(
  bytes: Uint8Array
): Promise<{ fullChecksum: string; audioChecksum: string }> {
  const fullChecksum = await sha1Hex(bytes);
  const audioSlice = getAudioFrameSlice(bytes);
  const audioChecksum = await sha1Hex(audioSlice);
  return { fullChecksum, audioChecksum };
}

