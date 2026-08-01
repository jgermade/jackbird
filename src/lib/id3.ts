import { ID3Writer } from "browser-id3-writer";
import jsmediatags from "jsmediatags/dist/jsmediatags.min.js";
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
          year: (tags.year as string) ?? "",
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
  return new Uint8Array(await blob.arrayBuffer());
}
