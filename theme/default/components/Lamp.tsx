import type { HTMLAttributes } from "react";
import { cx, type Tone } from "./shared";
import "./Lamp.css";

export type LampProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: Tone;
};

/**
 * A state as a lit lamp and a word: never a colour alone.
 *
 *   <Lamp tone="warn">Unsaved</Lamp>
 */
export function Lamp(props: LampProps): JSX.Element {
  const { tone = "neutral", className, ...rest } = props;
  return <span className={cx("mm-lamp", `mm-lamp--${tone}`, className)} {...rest} />;
}
