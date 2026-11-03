import { useEffect, useId, useRef, type ReactNode } from "react";
import { Key } from "./Key";
import { cx } from "./shared";
import "./Legend.css";
import "./Modal.css";

export type ModalProps = {
  open: boolean;
  /** Called on the close key, Escape, and a click on the backdrop. */
  onClose: () => void;
  title: ReactNode;
  /** Printed above the title. */
  eyebrow?: ReactNode;
  footer?: ReactNode;
  /** The close key's accessible name. */
  closeLabel?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
  children: ReactNode;
};

/**
 * A modal on the native <dialog>, like the app's current ones: the browser
 * handles focus, Escape and the top layer.
 *
 *   <Modal open={editing} onClose={stop} eyebrow="2 tracks" title="Edit metadata"
 *     footer={<Key variant="primary" onClick={save}>Save</Key>}>…</Modal>
 */
export function Modal(props: ModalProps): JSX.Element {
  const { open, onClose, title, eyebrow, footer, closeLabel = "Close", size = "md", className, children } = props;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (open && !dialog.open) {
      dialog.showModal();
    }
    if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className={cx("mm-modal", size !== "md" && `mm-modal--${size}`, className)}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <header className="mm-modal-head">
        <div className="mm-modal-titles">
          {eyebrow != null && <span className="mm-legend">{eyebrow}</span>}
          <h2 id={titleId} className="mm-modal-title">
            {title}
          </h2>
        </div>
        <Key variant="ghost" square aria-label={closeLabel} title={closeLabel} onClick={onClose}>
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </Key>
      </header>
      <div className="mm-modal-body">{children}</div>
      {footer != null && <footer className="mm-modal-foot">{footer}</footer>}
    </dialog>
  );
}
