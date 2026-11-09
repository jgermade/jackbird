import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_OUTPUT, describeFormat, devicesFor, formatRate, parseOutputKind, settingsFor, shortFormat, type DeviceInfo } from "./output.ts";

const devices: DeviceInfo[] = [
  { id: "coreaudio:dac", name: "USB DAC", default: true, modes: ["shared", "exclusive"] },
  { id: "alsa:default", name: "Default", default: false, modes: ["shared"] },
  { id: "alsa:hw:CARD=DAC,DEV=0", name: "DAC", default: false, modes: ["exclusive"] }
];

describe("output", () => {
  it("is native and shared unless something else was chosen", () => {
    assert.equal(DEFAULT_OUTPUT, "shared");
    assert.equal(parseOutputKind(null), "shared");
    assert.equal(parseOutputKind("nonsense"), "shared");
    assert.equal(parseOutputKind("embedded"), "embedded");
    assert.equal(parseOutputKind("exclusive"), "exclusive");
  });

  it("gives the native player its settings, and none for the embedded output", () => {
    assert.equal(settingsFor("embedded", "x"), null);
    assert.deepEqual(settingsFor("shared", null), { mode: "shared", device: null });
    assert.deepEqual(settingsFor("exclusive", "alsa:hw:0,0"), { mode: "exclusive", device: "alsa:hw:0,0" });
  });

  it("lists the devices each choice can use", () => {
    assert.deepEqual(devicesFor("embedded", devices), []);
    assert.deepEqual(
      devicesFor("shared", devices).map((device) => device.name),
      ["USB DAC", "Default"]
    );
    assert.deepEqual(
      devicesFor("exclusive", devices).map((device) => device.name),
      ["USB DAC", "DAC"]
    );
  });

  it("writes rates and formats as people read them", () => {
    assert.equal(formatRate(96000), "96 kHz");
    assert.equal(formatRate(44100), "44.1 kHz");
    assert.equal(describeFormat("FLAC", { rate: 96000, channels: 2, bits: 24 }), "FLAC 24 bit · 96 kHz");
    assert.equal(describeFormat("MP3", { rate: 44100, channels: 2, bits: 24 }), "MP3 · 44.1 kHz");
    assert.equal(shortFormat("FLAC", { rate: 96000, channels: 2, bits: 24 }), "24/96");
    assert.equal(shortFormat("FLAC", { rate: 44100, channels: 2, bits: 16 }), "16/44.1");
    assert.equal(shortFormat("MP3", { rate: 44100, channels: 2, bits: 24 }), "MP3");
  });
});
