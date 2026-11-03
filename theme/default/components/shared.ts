/** The three sizes every sized component takes. */
export type Size = "sm" | "md" | "lg";

/** The tones a state can take: neutral, the signal colour, and the three states. */
export type Tone = "neutral" | "accent" | "ok" | "warn" | "bad";

/** Joins class names, skipping the falsy ones. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
