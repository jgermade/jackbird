import { cx } from "./shared";
import "./Stripes.css";

/**
 * The three stripes. `stack` is the brand mark (set its width), `band` a
 * single line split in three (set its width by its container).
 */
export function Stripes(props: { variant?: "stack" | "band"; className?: string }): JSX.Element {
  const { variant = "stack", className } = props;
  if (variant === "band") {
    return <span className={cx("mm-stripes", "mm-stripes--band", className)} aria-hidden="true" />;
  }
  return (
    <span className={cx("mm-stripes", className)} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}
