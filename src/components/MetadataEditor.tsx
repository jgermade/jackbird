import { useEffect, useState } from "react";
import type { EditableMetadata, Mp3Track } from "../types";
import { CoverDropzone } from "./CoverDropzone";

type MetadataEditorProps = {
  track: Mp3Track | null;
  value: EditableMetadata;
  saving: boolean;
  onChange: (next: EditableMetadata) => void;
  onSave: () => Promise<void>;
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
          <span>Tamano</span>
          <strong>{(track.size / (1024 * 1024)).toFixed(2)} MB</strong>
        </div>
        <div>
          <span>Checksum</span>
          <code>{track.checksum || "Pendiente"}</code>
        </div>
      </div>
    </details>
  );
}

export function MetadataEditor(props: MetadataEditorProps): JSX.Element {
  const { track, value, saving, onChange, onSave } = props;
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    setEditing(false);
  }, [track?.id]);

  if (!track) {
    return (
      <section className="panel panel-editor empty">
        <h2>Detalles</h2>
        <p>Selecciona una pista para ver su ficha y editar metadatos.</p>
      </section>
    );
  }

  if (!editing) {
    return (
      <section className="panel panel-editor metadata-sheet">
        <header className="metadata-hero">
          <figure className="cover-hero">
            {value.coverDataUrl ? (
              <img className="cover-image" src={value.coverDataUrl} alt="Caratula" />
            ) : (
              <div className="cover-empty">Sin caratula</div>
            )}
          </figure>

          <div className="metadata-hero-info">
            <h2>{value.title || track.name}</h2>
            <p className="metadata-subtitle">{value.artist || "Artista desconocido"}</p>
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
            <MetadataValue label="Titulo" value={value.title} />
            <MetadataValue label="Artista" value={value.artist} />
            <MetadataValue label="Album" value={value.album} />
            <MetadataValue label="Ano" value={value.year} />
            <MetadataValue label="Genero" value={value.genre} />
            <MetadataValue label="Pista" value={value.trackNumber} />
          </div>
        </section>

        <TechnicalDetails track={track} />

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
          <h2>{value.title || track.name}</h2>
          <p className="metadata-subtitle">{value.artist || "Artista desconocido"}</p>
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
          label="Titulo"
          value={value.title}
          onChange={(title) => onChange({ ...value, title })}
          placeholder="Ej: Bohemian Rhapsody"
        />
        <Field
          label="Artista"
          value={value.artist}
          onChange={(artist) => onChange({ ...value, artist })}
          placeholder="Ej: Queen"
        />
        <Field
          label="Album"
          value={value.album}
          onChange={(album) => onChange({ ...value, album })}
          placeholder="Ej: A Night at the Opera"
        />
        <Field label="Ano" value={value.year} onChange={(year) => onChange({ ...value, year })} placeholder="1975" />
        <Field label="Genero" value={value.genre} onChange={(genre) => onChange({ ...value, genre })} placeholder="Rock" />
        <Field
          label="Pista"
          value={value.trackNumber}
          onChange={(trackNumber) => onChange({ ...value, trackNumber })}
          placeholder="1/12"
        />
        </div>
      </section>

      <TechnicalDetails track={track} />

      <div className="editor-actions">
        <button className="btn btn-ghost" type="button" disabled={saving} onClick={() => setEditing(false)}>
          Cancelar
        </button>
        <button className="btn btn-primary" type="button" disabled={saving} onClick={() => void onSave()}>
          {saving ? "Guardando..." : "Guardar cambios"}
        </button>
      </div>
    </section>
  );
}
