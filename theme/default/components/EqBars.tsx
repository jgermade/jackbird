import { cx } from "./shared";
import "./EqBars.css";

/**
 * Three level bars that mark the current track: moving while it plays, still
 * while paused. Decorative: say "now playing" in words elsewhere.
 */
export function EqBars(props: { active?: boolean; className?: string }): JSX.Element {
  return (
    <span className={cx("mm-eq", props.active && "is-active", props.className)} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}
