import type { Translate } from "../lib/i18n";

type LibraryLandingProps = {
  t: Translate;
  onOpenFolder: () => void;
};

export function LibraryLanding(props: LibraryLandingProps): JSX.Element {
  const { t } = props;
  return (
    <section className="library-landing">
      <div className="library-landing-mark" aria-hidden="true">
        MP3
      </div>
      <h2>{t("landing.title")}</h2>
      <p>{t("landing.body")}</p>
      <button type="button" className="btn btn-primary" onClick={props.onOpenFolder}>
        {t("landing.open")}
      </button>
      <small>{t("landing.note")}</small>
    </section>
  );
}
