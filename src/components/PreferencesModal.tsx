import { useEffect, useRef } from "react";
import type { Translate } from "../lib/i18n";
import type { Language, Theme } from "../types";

type PreferencesModalProps = {
  t: Translate;
  open: boolean;
  theme: Theme;
  language: Language;
  /** Every language, each named in itself. */
  languages: { value: Language; label: string }[];
  onChangeLanguage: (language: Language) => void;
  onClose: () => void;
  onToggleTheme: () => void;
};

export function PreferencesModal(props: PreferencesModalProps): JSX.Element {
  const { t, open, theme, language, languages, onChangeLanguage, onClose, onToggleTheme } = props;
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
          <span className="detail-eyebrow">{t("app.name")}</span>
          <h2 id="preferences-title">{t("preferences.title")}</h2>
        </div>
        <button type="button" className="modal-close" onClick={onClose} aria-label={t("preferences.close")} title={t("common.close")}>
          x
        </button>
      </header>
      <section className="preferences-section">
        <div>
          <h3>{t("preferences.appearance")}</h3>
          <p>{theme === "dark" ? t("preferences.darkOn") : t("preferences.lightOn")}</p>
        </div>
        <button type="button" className="btn btn-secondary" onClick={onToggleTheme}>
          {theme === "dark" ? t("preferences.useLight") : t("preferences.useDark")}
        </button>
      </section>
      <section className="preferences-section">
        <div>
          <h3>
            <label htmlFor="preferences-language">{t("preferences.language")}</label>
          </h3>
          <p>{t("preferences.languageHint")}</p>
        </div>
        <select
          id="preferences-language"
          className="preferences-select"
          value={language}
          onChange={(event) => onChangeLanguage(event.target.value as Language)}
        >
          {languages.map((option) => (
            <option key={option.value} value={option.value} lang={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </section>
    </dialog>
  );
}
