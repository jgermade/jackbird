import { useEffect, useRef } from "react";
import type { Theme } from "../lib/ThemeService";

type PreferencesModalProps = {
  open: boolean;
  theme: Theme;
  onClose: () => void;
  onToggleTheme: () => void;
};

export function PreferencesModal(props: PreferencesModalProps): JSX.Element {
  const { open, theme, onClose, onToggleTheme } = props;
  const dialogRef = useRef<HTMLDialogElement>(null);

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
      className="preferences-modal"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      aria-labelledby="preferences-title"
    >
      <header>
        <div>
          <span className="detail-eyebrow">MP3 Manager</span>
          <h2 id="preferences-title">Preferencias</h2>
        </div>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Cerrar preferencias" title="Cerrar">
          x
        </button>
      </header>
      <section className="preferences-section">
        <div>
          <h3>Apariencia</h3>
          <p>{theme === "dark" ? "Tema oscuro activo" : "Tema claro activo"}</p>
        </div>
        <button type="button" className="btn btn-secondary" onClick={onToggleTheme}>
          Usar tema {theme === "dark" ? "claro" : "oscuro"}
        </button>
      </section>
    </dialog>
  );
}
