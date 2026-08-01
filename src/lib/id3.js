import { ID3Writer } from "browser-id3-writer";
import jsmediatags from "jsmediatags/dist/jsmediatags.min.js";
function toArrayBuffer(bytes) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
}
function bytesToDataUrl(bytes, format) {
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    const base64 = window.btoa(binary);
    return `data:${format};base64,${base64}`;
}
function parseTag(file) {
    return new Promise((resolve) => {
        jsmediatags.read(file, {
            onSuccess: (result) => {
                const tags = result.tags;
                const picture = tags.picture;
                resolve({
                    title: tags.title ?? "",
                    artist: tags.artist ?? "",
                    album: tags.album ?? "",
                    year: tags.year ?? "",
                    genre: tags.genre ?? "",
                    trackNumber: tags.track ?? "",
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
export async function readTrackMetadataFromBytes(bytes, fileName) {
    const file = new File([toArrayBuffer(bytes)], fileName, { type: "audio/mpeg" });
    return parseTag(file);
}
async function imageToBytes(dataUrl) {
    const response = await fetch(dataUrl);
    const arrayBuffer = await response.arrayBuffer();
    return new Uint8Array(arrayBuffer);
}
function guessMimeTypeFromDataUrl(dataUrl) {
    const matches = dataUrl.match(/^data:([^;]+);base64,/);
    return matches ? matches[1] : "image/jpeg";
}
export async function writeTrackMetadataToBytes(sourceBytes, metadata) {
    const writerBase = new ID3Writer(toArrayBuffer(sourceBytes));
    const writer = writerBase;
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
