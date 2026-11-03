import type { HTMLAttributes, ReactNode } from "react";
import { Key } from "./Key";
import { cx, type Size } from "./shared";
import "./KeyBank.css";

export type KeyBankProps = HTMLAttributes<HTMLDivElement> & {
  /** The group's accessible name. */
  label: string;
};

/**
 * Keys set in one recess.
 *
 *   <KeyBank label="Transport"><Key square aria-label="Play">…</Key>…</KeyBank>
 */
export function KeyBank(props: KeyBankProps): JSX.Element {
  const { label, className, children, ...rest } = props;
  return (
    <div role="group" aria-label={label} className={cx("mm-bank", className)} {...rest}>
      {children}
    </div>
  );
}

export type KeySelectOption<T extends string> = {
  value: T;
  label: ReactNode;
  title?: string;
};

export type KeySelectProps<T extends string> = {
  label: string;
  options: KeySelectOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: Size;
  className?: string;
};

/**
 * A bank where exactly one key is down, with its LED lit: the function
 * selector of a deck. The theme's segmented control.
 *
 *   <KeySelect label="Library view" value={mode} onChange={setMode}
 *     options={[{ value: "flat", label: "Flat" }, { value: "wizard", label: "Wizard" }]} />
 */
export function KeySelect<T extends string>(props: KeySelectProps<T>): JSX.Element {
  const { label, options, value, onChange, size = "sm", className } = props;
  return (
    <KeyBank label={label} className={className}>
      {options.map((option) => (
        <Key
          key={option.value}
          size={size}
          led
          pressed={option.value === value}
          title={option.title}
          onClick={() => {
            if (option.value !== value) {
              onChange(option.value);
            }
          }}
        >
          {option.label}
        </Key>
      ))}
    </KeyBank>
  );
}
