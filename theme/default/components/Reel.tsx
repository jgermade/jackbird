import { cx } from "./shared";
import "./Reel.css";

export type ReelProps = {
  /** Width and height in pixels. */
  size?: number;
  /** `fast` for work the user is waiting on (writing files), `slow` for background work. */
  speed?: "slow" | "fast";
  /** The accessible name. Without one the reel is decorative and the text beside it speaks. */
  label?: string;
  className?: string;
};

/**
 * The busy indicator: a cassette hub turning, with its six teeth and the tape
 * wound on it.
 */
export function Reel(props: ReelProps): JSX.Element {
  const { size = 24, speed = "slow", label, className } = props;
  return (
    <svg
      className={cx("mm-reel", speed === "fast" && "mm-reel--fast", className)}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <circle cx="16" cy="16" r="14" fill="none" stroke="currentColor" strokeWidth="1.5" opacity=".35" />
      <circle cx="16" cy="16" r="10.5" fill="none" stroke="currentColor" strokeWidth="3" opacity=".8" />
      <circle cx="16" cy="16" r="5" fill="none" stroke="currentColor" strokeWidth="2" />
      <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M16 11v2.4" />
        <path d="M20.33 13.5l-2.08 1.2" />
        <path d="M20.33 18.5l-2.08-1.2" />
        <path d="M16 21v-2.4" />
        <path d="M11.67 18.5l2.08-1.2" />
        <path d="M11.67 13.5l2.08 1.2" />
      </g>
    </svg>
  );
}
