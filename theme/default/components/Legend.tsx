import type { HTMLAttributes } from "react";
import { cx } from "./shared";
import "./Legend.css";

export type LegendProps = HTMLAttributes<HTMLElement> & {
  as?: "span" | "p" | "h2" | "h3" | "h4";
  tone?: "muted" | "ink" | "accent";
};

/**
 * Printed lettering, the hardware term for the text on a faceplate: small,
 * wide and uppercase. For section heads, column heads and the name under a
 * control.
 *
 *   <Legend as="h2">Library · 739 tracks</Legend>
 */
export function Legend(props: LegendProps): JSX.Element {
  const { as: Tag = "span", tone = "muted", className, ...rest } = props;
  return <Tag className={cx("mm-legend", tone !== "muted" && `mm-legend--${tone}`, className)} {...rest} />;
}
