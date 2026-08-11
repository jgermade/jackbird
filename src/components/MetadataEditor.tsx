import { useEffect, useMemo, useState } from "react";
import type { EditableMetadata, Mp3Track } from "../types";
import { CoverDropzone } from "./CoverDropzone";

type MetadataEditorProps = {
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

function TechnicalDetails(props: { track: Mp3Track }): JSX.Element {
  const { track } = props;

  return (
    <details className="technical-details">
      <summary>Datos del archivo</summary>
      <div className="technical-list">
        <div>
          <span>Archivo</span>
          <code>{track.name}</code>
        </div>
        <div>
          <span>Ruta</span>
          <code>{track.relativePath}</code>
        </div>
        <div>
          <span>Tamaño</span>
          <strong>{(track.size / (1024 * 1024)).toFixed(2)} MB</strong>
        </div>
        <div>
          <span>Checksum</span>
          <code>{track.fullChecksum || track.checksum || "Pendiente"}</code>
        </div>
      </div>
    </details>
  );
}

export function MetadataEditor(props: MetadataEditorProps): JSX.Element {
  const { track, tracks, value, saving, onChange, onSave, isModal } = props;
  const [editing, setEditing] = useState(Boolean(isModal));

  const effectiveTracks = useMemo(() => {
    if (tracks && tracks.length > 0) {
      return tracks;
    }
    return track ? [track] : [];
  }, [track, tracks]);

  const singleTrack = effectiveTracks.length === 1 ? effectiveTracks[0] : null;

  const varied = useMemo(() => {
    if (effectiveTracks.length <= 1) {
      return {
        title: false,
        artist: false,
        album: false,
        year: false,
        genre: false,
        trackNumber: false,
        coverDataUrl: false
      };
    }

    const first = effectiveTracks[0].metadata;
    return {
      title: effectiveTracks.some((t) => t.metadata.title !== first.title),
      artist: effectiveTracks.some((t) => t.metadata.artist !== first.artist),
      album: effectiveTracks.some((t) => t.metadata.album !== first.album),
      year: effectiveTracks.some((t) => t.metadata.year !== first.year),
      genre: effectiveTracks.some((t) => t.metadata.genre !== first.genre),
      trackNumber: effectiveTracks.some((t) => t.metadata.trackNumber !== first.trackNumber),
      coverDataUrl: effectiveTracks.some((t) => t.metadata.coverDataUrl !== first.coverDataUrl)
    };
  }, [effectiveTracks]);

  useEffect(() => {
    setEditing(Boolean(isModal));
  }, [singleTrack?.id, effectiveTracks.length, isModal]);

  if (effectiveTracks.length === 0) {
    return (
      <section className="panel panel-editor empty">
        <h2>Detalles</h2>
        <p>Selecciona una pista para ver su ficha y editar metadatos.</p>
      </section>
    );
  }

  const heroTitle = singleTrack
    ? value.title || singleTrack.name
    : `${effectiveTracks.length} pistas seleccionadas`;

  const heroSubtitle = singleTrack
    ? value.artist || "Artista desconocido"
    : varied.artist
      ? "(Varios artistas)"
      : value.artist || "Artista común";

  if (!editing && !isModal) {
    return (
      <section className="panel panel-editor metadata-sheet">
        <header className="metadata-hero">
          <figure className="cover-hero">
            {value.coverDataUrl ? (
              <img className="cover-image" src={value.coverDataUrl} alt="Caratula" />
            ) : (
              <div className="cover-empty">Sin carátula</div>
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
          <h3>Metadatos</h3>
          <div className="metadata-values">
            <MetadataValue label="Título" value={value.title} />
            <MetadataValue label="Artista" value={value.artist} />
            <MetadataValue label="Álbum" value={value.album} />
            <MetadataValue label="Año" value={value.year} />
            <MetadataValue label="Género" value={value.genre} />
            <MetadataValue label="Pista" value={value.trackNumber} />
          </div>
        </section>

        {singleTrack && <TechnicalDetails track={singleTrack} />}

        <footer className="metadata-actions">
          <button className="btn btn-primary" type="button" onClick={() => setEditing(true)}>
            Editar metadatos
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
        <h3>Metadatos</h3>
        <div className="metadata-values">
          <Field
            label="Título"
            value={value.title}
            onChange={(title) => onChange({ ...value, title })}
            placeholder={varied.title ? "(Varios valores)" : "Ej: Bohemian Rhapsody"}
          />
          <Field
            label="Artista"
            value={value.artist}
            onChange={(artist) => onChange({ ...value, artist })}
            placeholder={varied.artist ? "(Varios valores)" : "Ej: Queen"}
          />
          <Field
            label="Álbum"
            value={value.album}
            onChange={(album) => onChange({ ...value, album })}
            placeholder={varied.album ? "(Varios valores)" : "Ej: A Night at the Opera"}
          />
          <Field
            label="Año"
            value={value.year}
            onChange={(year) => onChange({ ...value, year })}
            placeholder={varied.year ? "(Varios valores)" : "1975"}
          />
          <Field
            label="Género"
            value={value.genre}
            onChange={(genre) => onChange({ ...value, genre })}
            placeholder={varied.genre ? "(Varios valores)" : "Rock"}
          />
          <Field
            label="Pista"
            value={value.trackNumber}
            onChange={(trackNumber) => onChange({ ...value, trackNumber })}
            placeholder={varied.trackNumber ? "(Varios valores)" : "1/12"}
          />
        </div>
      </section>

      {singleTrack && <TechnicalDetails track={singleTrack} />}

      <div className="editor-actions">
        {!isModal && (
          <button className="btn btn-ghost" type="button" disabled={saving} onClick={() => setEditing(false)}>
            Cancelar
          </button>
        )}
        <button className="btn btn-primary" type="button" disabled={saving} onClick={() => void onSave()}>
          {saving ? "Guardando..." : "Guardar cambios"}
        </button>
      </div>
    </section>
  );
}
