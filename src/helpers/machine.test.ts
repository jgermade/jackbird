import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUSY_PERCENT, HOT_CELSIUS, MAX_SENSORS, clampPercent, formatCelsius, formatPercent, isMachineReading, machineTone, shownSensors } from "./machine.ts";

describe("formatPercent and formatCelsius", () => {
  it("formats in the person's language, no decimals", () => {
    assert.equal(formatPercent(23.4, "en"), "23%");
    assert.equal(formatPercent(23.6, "es").replace(/\s/g, " "), "24 %");
    assert.equal(formatCelsius(61.4, "en"), "61 °C");
    assert.equal(formatCelsius(1234, "en"), "1,234 °C");
  });

  it("keeps a load within 0–100", () => {
    assert.equal(clampPercent(100.2), 100);
    assert.equal(clampPercent(-1), 0);
    assert.equal(clampPercent(Number.NaN), 0);
    assert.equal(formatPercent(140, "en"), "100%");
  });
});

describe("machineTone", () => {
  it("is the accent when busy or hot", () => {
    assert.equal(machineTone(BUSY_PERCENT), "accent");
    assert.equal(machineTone(10, HOT_CELSIUS), "accent");
    assert.equal(machineTone(BUSY_PERCENT - 1, HOT_CELSIUS - 1), "info");
    assert.equal(machineTone(undefined, undefined), "info");
  });
});

describe("shownSensors", () => {
  it("keeps the hottest per label, the hottest first, unnamed ones left out", () => {
    assert.deepEqual(
      shownSensors([
        { label: "nvme Composite", celsius: 40 },
        { label: " k10temp Tctl ", celsius: 62 },
        { label: "nvme Composite", celsius: 45 },
        { label: "", celsius: 90 },
        { label: "acpitz", celsius: Number.NaN }
      ]),
      [
        { label: "k10temp Tctl", celsius: 62 },
        { label: "nvme Composite", celsius: 45 }
      ]
    );
  });

  it("shows at most a few", () => {
    const many = Array.from({ length: MAX_SENSORS + 3 }, (_, index) => ({ label: `core ${index}`, celsius: 40 + index }));
    const shown = shownSensors(many);
    assert.equal(shown.length, MAX_SENSORS);
    assert.equal(shown[0].label, `core ${MAX_SENSORS + 2}`);
  });
});

describe("isMachineReading", () => {
  it("takes the service's answer and nothing else", () => {
    assert.ok(isMachineReading({ cpu: { percent: 3, cores: 4 }, gpus: [], temperatures: [] }));
    assert.ok(!isMachineReading(null));
    assert.ok(!isMachineReading({ cpu: { percent: "3", cores: 4 }, gpus: [], temperatures: [] }));
    assert.ok(!isMachineReading({ cpu: { percent: 3, cores: 4 }, gpus: {}, temperatures: [] }));
    assert.ok(!isMachineReading({ error: "forbidden" }));
  });
});
