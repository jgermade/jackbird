import type { FormHTMLAttributes, ReactNode } from "react";
import { cx } from "./shared";
import "./Legend.css";
import "./Panel.css";

export type PanelProps = Omit<FormHTMLAttributes<HTMLElement>, "title"> & {
  as?: "section" | "div" | "form";
  /** Printed on the chassis strip at the top. */
  title?: ReactNode;
  /** Right side of the head: a lamp, a key. */
  actions?: ReactNode;
  footer?: ReactNode;
  /** No padding around the body, for a list or a table. */
  flush?: boolean;
};

/**
 * A panel with a chassis head.
 *
 *   <Panel as="form" title="Edit metadata · 2 tracks" actions={<Lamp tone="warn">Unsaved</Lamp>}
 *     footer={<Key variant="primary" type="submit">Save</Key>} onSubmit={save}>…</Panel>
 */
export function Panel(props: PanelProps): JSX.Element {
  const { as: Tag = "section", title, actions, footer, flush = false, className, children, ...rest } = props;
  return (
    <Tag className={cx("mm-panel", flush && "mm-panel--flush", className)} {...rest}>
      {(title != null || actions != null) && (
        <header className="mm-panel-head">
          <span className="mm-legend">{title}</span>
          {actions != null && <div className="mm-panel-actions">{actions}</div>}
        </header>
      )}
      <div className="mm-panel-body">{children}</div>
      {footer != null && <footer className="mm-panel-foot">{footer}</footer>}
    </Tag>
  );
}
