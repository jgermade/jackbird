import { cx } from "./shared";
import "./Led.css";

export type LedProps = {
  on?: boolean;
  tone?: "accent" | "ok" | "warn" | "bad";
  className?: string;
};

/** A small indicator light. Decorative: what it means is said in words next to it. */
export function Led(props: LedProps): JSX.Element {
  const { on = false, tone = "accent", className } = props;
  return <span className={cx("mm-led", on && "mm-led--on", `mm-led--${tone}`, className)} aria-hidden="true" />;
}
