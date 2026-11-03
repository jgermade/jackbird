import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./shared";
import "./Display.css";

/**
 * The display window, where state is shown: what is playing, counters,
 * progress. An LCD in Silver, a VFD in Graphite. Compose it from the parts
 * below.
 *
 *   <Display aria-live="polite">
 *     <DisplayRow><DisplayLabel>▶ Play</DisplayLabel><DisplayLabel>Track <Counter size="sm">01/05</Counter></DisplayLabel></DisplayRow>
 *     <DisplayRow><DisplayTitle>So What — Miles Davis</DisplayTitle><Counter>03:12</Counter></DisplayRow>
 *     <Meter variant="display" value={192} max={562} label="Position" />
 *   </Display>
 */
export function Display(props: HTMLAttributes<HTMLDivElement>): JSX.Element {
  const { className, children, ...rest } = props;
  return (
    <div className={cx("mm-bezel", className)}>
      <div className="mm-display" {...rest}>
        {children}
      </div>
    </div>
  );
}

export function DisplayRow(props: { children: ReactNode; className?: string }): JSX.Element {
  return <div className={cx("mm-display-row", props.className)}>{props.children}</div>;
}

/** Small printed text inside the window: a state, a unit. */
export function DisplayLabel(props: { children: ReactNode; className?: string }): JSX.Element {
  return <span className={cx("mm-display-label", props.className)}>{props.children}</span>;
}

/** One line of text that ellipsises; `title` shows it whole on hover. */
export function DisplayTitle(props: { children: ReactNode; title?: string; className?: string }): JSX.Element {
  return (
    <span className={cx("mm-display-title", props.className)} title={props.title}>
      {props.children}
    </span>
  );
}

/** Digits in the dot-matrix face: times, track numbers, counts. */
export function Counter(props: { children: ReactNode; size?: "sm" | "lg"; className?: string }): JSX.Element {
  const { children, size = "lg", className } = props;
  return <span className={cx("mm-counter", `mm-counter--${size}`, className)}>{children}</span>;
}
