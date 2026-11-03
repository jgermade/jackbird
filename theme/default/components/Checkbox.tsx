import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { cx } from "./shared";
import "./Checkbox.css";

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  label: ReactNode;
};

/** A checkbox with its label; checked, it fills with the signal colour. */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(props, ref) {
  const { label, className, ...rest } = props;
  return (
    <label className={cx("mm-check", className)}>
      <input ref={ref} type="checkbox" className="mm-check-box" {...rest} />
      <span>{label}</span>
    </label>
  );
});
