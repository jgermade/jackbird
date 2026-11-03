import { useEffect, useMemo, useState } from "react";
import { getVariedFields } from "../helpers/metadata";
import type { Translate } from "../lib/i18n";
import type { EditableMetadata, Mp3Track } from "../types";
import { CoverDropzone } from "./CoverDropzone";

type MetadataEditorProps = {
  t: Translate;
  track?: Mp3Track | null;
  tracks?: Mp3Track[];
  value: EditableMetadata;
  saving: boolean;
  onChange: (next: EditableMetadata) => void;
  onSave: () => Promise<void>;
  isModal?: boolean;
};

function Field(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}): JSX.Element {
  return (
    <label className="fact field">
      <span className="fact-label">{props.label}</span>
      <input
        value={props.value}
        placeholder={props.placeholder}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

function MetadataValue(props: { label: string; value: string }): JSX.Element {
  return (
    <div className="metadata-value">
      <span>{props.label}</span>
      <strong>{props.value || "-"}</strong>
    </div>
  );
}

function TechnicalDetails(props: { track: Mp3Track; t: Translate }): JSX.Element {
  const { track, t } = props;

  return (
    <details className="technical-details">
      <summary>{t("editor.fileData")}</summary>
      <div className="technical-list">
        <div>
          <span>{t("editor.file")}</span>
          <code>{track.name}</code>
        </div>
        <div>
          <span>{t("editor.path")}</span>
          <code>{track.relativePath}</code>
        </div>
        <div>
          <span>{t("editor.size")}</span>
          <strong>{(track.size / (1024 * 1024)).toFixed(2)} MB</strong>
        </div>
        <div>
          <span>{t("editor.checksum")}</span>
          <code>{track.fullChecksum || track.checksum || t("editor.pending")}</code>
        </div>
      </div>
    </details>
  );
}

export function MetadataEditor(props: MetadataEditorProps): JSX.Element {
  const { t, track, tracks, value, saving, onChange, onSave, isModal } = props;
  const [editing, setEditing] = useState(Boolean(isModal));

  const effectiveTracks = useMemo(() => {
    if (tracks && tracks.length > 0) {
      return tracks;
    }
    return track ? [track] : [];
  }, [track, tracks]);

  const singleTrack = effectiveTracks.length === 1 ? effectiveTracks[0] : null;

  const varied = useMemo(() => getVariedFields(effectiveTracks), [effectiveTracks]);

  useEffect(() => {
    setEditing(Boolean(isModal));
  }, [singleTrack?.id, effectiveTracks.length, isModal]);

  if (effectiveTracks.length === 0) {
    return (
      <section className="panel panel-editor empty">
        <h2>{t("editor.details")}</h2>
        <p>{t("editor.empty")}</p>
      </section>
    );
  }

  const heroTitle = singleTrack
    ? value.title || singleTrack.name
    : t.n("selection.count", effectiveTracks.length);

  const heroSubtitle = singleTrack
    ? value.artist || t("album.unknownArtist")
    : varied.artist
      ? t("editor.variousArtists")
      : value.artist || t("editor.sharedArtist");

  if (!editing && !isModal) {
    return (
      <section className="panel panel-editor metadata-sheet">
        <header className="metadata-hero">
          <figure className="cover-hero">
            {value.coverDataUrl ? (
              <img className="cover-image" src={value.coverDataUrl} alt={t("editor.cover")} />
            ) : (
              <div className="cover-empty">{t("album.noCover")}</div>
            )}
          </figure>

          <div className="metadata-hero-info">
            <h2>{heroTitle}</h2>
            <p className="metadata-subtitle">{heroSubtitle}</p>
            <div className="metadata-tags">
              {value.album && <span className="tag">{value.album}</span>}
              {value.year && <span className="tag">{value.year}</span>}
              {value.genre && <span className="tag">{value.genre}</span>}
            </div>
          </div>
        </header>

        <section className="metadata-section">
          <h3>{t("editor.metadata")}</h3>
          <div className="metadata-values">
            <MetadataValue label={t("field.title")} value={value.title} />
            <MetadataValue label={t("field.artist")} value={value.artist} />
            <MetadataValue label={t("field.album")} value={value.album} />
            <MetadataValue label={t("field.year")} value={value.year} />
            <MetadataValue label={t("field.genre")} value={value.genre} />
            <MetadataValue label={t("field.track")} value={value.trackNumber} />
          </div>
        </section>

        {singleTrack && <TechnicalDetails track={singleTrack} t={t} />}

        <footer className="metadata-actions">
          <button className="btn btn-primary" type="button" onClick={() => setEditing(true)}>
            {t("editor.editMetadata")}
          </button>
        </footer>
      </section>
    );
  }

  return (
    <section className="panel panel-editor metadata-sheet">
      <header className="metadata-hero">
        <figure className="cover-hero">
          <CoverDropzone
            t={t}
            coverDataUrl={value.coverDataUrl}
            onSetCover={(coverDataUrl) => onChange({ ...value, coverDataUrl })}
            compact
          />
        </figure>

        <div className="metadata-hero-info">
          <h2>{heroTitle}</h2>
          <p className="metadata-subtitle">{heroSubtitle}</p>
          <div className="metadata-tags">
            {value.album && <span className="tag">{value.album}</span>}
            {value.year && <span className="tag">{value.year}</span>}
          </div>
        </div>
      </header>

      <section className="metadata-section">
        <h3>{t("editor.metadata")}</h3>
        <div className="metadata-values">
          <Field
            label={t("field.title")}
            value={value.title}
            onChange={(title) => onChange({ ...value, title })}
            placeholder={varied.title ? t("editor.multipleValues") : t("editor.example", { value: "Bohemian Rhapsody" })}
          />
          <Field
            label={t("field.artist")}
            value={value.artist}
            onChange={(artist) => onChange({ ...value, artist })}
            placeholder={varied.artist ? t("editor.multipleValues") : t("editor.example", { value: "Queen" })}
          />
          <Field
            label={t("field.album")}
            value={value.album}
            onChange={(album) => onChange({ ...value, album })}
            placeholder={varied.album ? t("editor.multipleValues") : t("editor.example", { value: "A Night at the Opera" })}
          />
          <Field
            label={t("field.year")}
            value={value.year}
            onChange={(year) => onChange({ ...value, year })}
            placeholder={varied.year ? t("editor.multipleValues") : "1975"}
          />
          <Field
            label={t("field.genre")}
            value={value.genre}
            onChange={(genre) => onChange({ ...value, genre })}
            placeholder={varied.genre ? t("editor.multipleValues") : "Rock"}
          />
          <Field
            label={t("field.track")}
            value={value.trackNumber}
            onChange={(trackNumber) => onChange({ ...value, trackNumber })}
            placeholder={varied.trackNumber ? t("editor.multipleValues") : "1/12"}
          />
        </div>
      </section>

      {singleTrack && <TechnicalDetails track={singleTrack} t={t} />}

      <div className="editor-actions">
        {!isModal && (
          <button className="btn btn-ghost" type="button" disabled={saving} onClick={() => setEditing(false)}>
            {t("editor.cancel")}
          </button>
        )}
        <button className="btn btn-primary" type="button" disabled={saving} onClick={() => void onSave()}>
          {saving ? t("editor.saving") : t("editor.save")}
        </button>
      </div>
    </section>
  );
}
