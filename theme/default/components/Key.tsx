import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Led } from "./Led";
import { cx, type Size } from "./shared";
import "./Key.css";

export type KeyVariant = "primary" | "secondary" | "ghost" | "danger";

export type KeyProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** `primary` is the one thing a view asks for, `secondary` the rest, `ghost` an action that
   * should not compete with content, `danger` one that loses something. */
  variant?: KeyVariant;
  size?: Size;
  /** An icon alone. Give it an `aria-label`. */
  square?: boolean;
  /** A latching key: held down while true. Sets `aria-pressed`. */
  pressed?: boolean;
  /** Show an LED that is lit while `pressed`. */
  led?: boolean;
};

/**
 * A key: the theme's button. It travels 1px down when pressed, and a latching
 * key stays down.
 *
 *   <Key variant="primary" onClick={save}>Save</Key>
 *   <Key square aria-label="Next track"><NextIcon /></Key>
 *   <Key size="sm" led pressed={shuffle} onClick={toggleShuffle}>Shuffle</Key>
 */
export const Key = forwardRef<HTMLButtonElement, KeyProps>(function Key(props, ref) {
  const { variant = "secondary", size = "md", square = false, pressed, led = false, type = "button", className, children, ...rest } = props;

  return (
    <button
      ref={ref}
      type={type}
      aria-pressed={pressed}
      className={cx("mm-key", `mm-key--${variant}`, size !== "md" && `mm-key--${size}`, square && "mm-key--square", className)}
      {...rest}
    >
      {led && <Led on={pressed === true} />}
      {children}
    </button>
  );
});
