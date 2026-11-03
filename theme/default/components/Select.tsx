import { forwardRef, type SelectHTMLAttributes } from "react";
import { cx } from "./shared";
import "./Input.css";

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  invalid?: boolean;
};

/**
 * The native select, drawn like a TextInput with a chevron.
 *
 *   <Select id="genre" value={genre} onChange={…}><option>Jazz</option></Select>
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(props, ref) {
  const { invalid = false, className, children, ...rest } = props;
  return (
    <span className={cx("mm-select", className)}>
      <select ref={ref} aria-invalid={invalid || undefined} className="mm-input" {...rest}>
        {children}
      </select>
    </span>
  );
});
