import { forwardRef, type InputHTMLAttributes } from "react";
import { cx } from "./shared";
import "./Input.css";

export type TextInputProps = InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean;
  /** Years, track numbers, durations: set in the mono face with tabular digits. */
  numeric?: boolean;
};

/** A text field set into the panel like a well. */
export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(props, ref) {
  const { invalid = false, numeric = false, type = "text", className, ...rest } = props;
  return (
    <input
      ref={ref}
      type={type}
      aria-invalid={invalid || undefined}
      className={cx("mm-input", numeric && "mm-input--numeric", className)}
      {...rest}
    />
  );
});
