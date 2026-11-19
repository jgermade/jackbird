// The server machine's load and temperatures as Preferences, Server shows them (owners): what
// `GET /api/machine` answers, its numbers formatted in the person's language, a bar's tone by how
// busy or hot, and the sensors worth showing. See RECORD/2026-11-03.deck-design-system.WIP.md
// (2026-11-19 02:32, plan D).

export type MachineGpu = { name: string; percent?: number; celsius?: number };
export type MachineSensor = { label: string; celsius: number };
export type MachineReading = {
  cpu: { percent: number; cores: number; name?: string };
  gpus: MachineGpu[];
  temperatures: MachineSensor[];
};

/** From this load (percent) or temperature (°C) on, a bar is drawn in the accent: worth a look. */
export const BUSY_PERCENT = 90;
export const HOT_CELSIUS = 80;

/** The most sensors shown: the hottest. */
export const MAX_SENSORS = 6;

/** "23 %" in the person's language, no decimals. */
export function formatPercent(percent: number, language: string): string {
  return new Intl.NumberFormat(language, { style: "percent", maximumFractionDigits: 0 }).format(clampPercent(percent) / 100);
}

/** "61 °C", no decimals. */
export function formatCelsius(celsius: number, language: string): string {
  return `${new Intl.NumberFormat(language, { maximumFractionDigits: 0 }).format(celsius)} °C`;
}

/** A load kept within 0–100 (a system may round a little past either end). */
export function clampPercent(percent: number): number {
  return Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
}

/** A bar's tone: the accent when busy or hot, otherwise `info`. */
export function machineTone(percent: number | undefined, celsius?: number): "accent" | "info" {
  return (percent ?? 0) >= BUSY_PERCENT || (celsius ?? 0) >= HOT_CELSIUS ? "accent" : "info";
}

/** The sensors worth showing: named ones, one per label (the hottest), the hottest first, at most `MAX_SENSORS`. */
export function shownSensors(sensors: readonly MachineSensor[]): MachineSensor[] {
  const hottest = new Map<string, MachineSensor>();
  for (const sensor of sensors) {
    const label = sensor.label.trim();
    if (!label || !Number.isFinite(sensor.celsius)) continue;
    const kept = hottest.get(label);
    if (!kept || sensor.celsius > kept.celsius) hottest.set(label, { label, celsius: sensor.celsius });
  }
  return [...hottest.values()].sort((a, b) => b.celsius - a.celsius).slice(0, MAX_SENSORS);
}

/** Whether an answer is one: the service's shape, so an old service's or an error page is not read. */
export function isMachineReading(value: unknown): value is MachineReading {
  const reading = value as MachineReading | null;
  return (
    !!reading &&
    typeof reading.cpu?.percent === "number" &&
    typeof reading.cpu?.cores === "number" &&
    Array.isArray(reading.gpus) &&
    Array.isArray(reading.temperatures)
  );
}
