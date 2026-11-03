import type { ReactNode } from "react";
import { cx } from "./shared";
import "./Legend.css";
import "./Input.css";

export type FieldProps = {
  /** The printed label above the control. */
  label: ReactNode;
  /** The control's id. */
  htmlFor: string;
  /** A note under the control. */
  hint?: ReactNode;
  /** Replaces the hint and is announced. Mark the control `invalid` too. */
  error?: ReactNode;
  className?: string;
  children: ReactNode;
};

/** The id a Field gives its note, for the control's `aria-describedby`. */
export function fieldNoteId(htmlFor: string): string {
  return `${htmlFor}-note`;
}

/**
 * A label above a control, and a note or an error under it.
 *
 *   <Field label="Year" htmlFor="year" hint="Four digits">
 *     <TextInput id="year" numeric aria-describedby={fieldNoteId("year")} />
 *   </Field>
 */
export function Field(props: FieldProps): JSX.Element {
  const { label, htmlFor, hint, error, className, children } = props;
  const note = error ?? hint;

  return (
    <div className={cx("mm-field", className)}>
      <label className="mm-legend" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {note != null && (
        <span id={fieldNoteId(htmlFor)} className={cx("mm-field-note", error != null && "is-error")} role={error != null ? "alert" : undefined}>
          {note}
        </span>
      )}
    </div>
  );
}
