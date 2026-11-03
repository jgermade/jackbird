import type { CSSProperties } from "react";
import { cx } from "./shared";
import "./Meter.css";

export type MeterProps = {
  value: number;
  max?: number;
  /** How many segments the bar is cut into. */
  segments?: number;
  /** `display` inside a Display window, `chassis` as LEDs anywhere else. */
  variant?: "display" | "chassis";
  /** The accessible name: what is being measured. */
  label: string;
  /** Spoken value, e.g. "603 of 739 tracks". Defaults to the numbers. */
  valueText?: string;
  className?: string;
};

/**
 * A segmented meter: progress as lit segments, like a level meter.
 *
 *   <Meter variant="chassis" value={603} max={739} label="Reading tags" />
 */
export function Meter(props: MeterProps): JSX.Element {
  const { value, max = 1, segments = 32, variant = "chassis", label, valueText, className } = props;
  const fraction = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const lit = Math.round(fraction * segments);
  const style = { "--mm-meter-segments": segments } as CSSProperties;

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={valueText}
      className={cx("mm-meter", `mm-meter--${variant}`, className)}
      style={style}
    >
      {Array.from({ length: segments }, (_, index) => (
        <i key={index} className={index < lit ? "is-on" : undefined} />
      ))}
    </div>
  );
}
