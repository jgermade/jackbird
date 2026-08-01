import { useEffect, useState } from "react";
import type { EditableMetadata, Mp3Track } from "../types";
import { CoverDropzone } from "./CoverDropzone";
import { TrackAudioPlayer } from "./TrackAudioPlayer";

type MetadataEditorProps = {
  track: Mp3Track | null;
  value: EditableMetadata;
  saving: boolean;
  onChange: (next: EditableMetadata) => void;
  onSave: () => Promise<void>;
  onLoadAudioBytes: (track: Mp3Track) => Promise<Uint8Array>;
};

function Field(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}): JSX.Element {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        value={props.value}
        placeholder={props.placeholder}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

export function MetadataEditor(props: MetadataEditorProps): JSX.Element {
  const { track, value, saving, onChange, onSave, onLoadAudioBytes } = props;
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
      <section className="panel panel-editor">
        <div className="metadata-hero">
          <div className="cover-hero">
            {value.coverDataUrl ? (
              <img className="cover-image" src={value.coverDataUrl} alt="Caratula" />
            ) : (
              <div className="cover-empty">Sin caratula</div>
            )}
          </div>

          <div className="metadata-hero-info">
            <h2>{value.title || track.name}</h2>
            <p className="metadata-subtitle mono">{track.relativePath}</p>
            <div className="metadata-tags">
              {value.album && <span className="tag">{value.album}</span>}
              {value.artist && <span className="tag">{value.artist}</span>}
              {value.year && <span className="tag">{value.year}</span>}
            </div>
            <TrackAudioPlayer track={track} onLoadAudioBytes={onLoadAudioBytes} />
          </div>
        </div>

        <div className="details-grid">
          <div className="fact">
            <span className="fact-label">Archivo</span>
            <span className="fact-value mono">{track.name}</span>
          </div>
          <div className="fact">
            <span className="fact-label">Ruta</span>
            <span className="fact-value mono">{track.relativePath}</span>
          </div>
          <div className="fact">
            <span className="fact-label">Artista</span>
            <span className="fact-value">{value.artist || "-"}</span>
          </div>
          <div className="fact">
            <span className="fact-label">Album</span>
            <span className="fact-value">{value.album || "-"}</span>
          </div>
          <div className="fact">
            <span className="fact-label">Genero</span>
            <span className="fact-value">{value.genre || "-"}</span>
          </div>
          <div className="fact">
            <span className="fact-label">Pista</span>
            <span className="fact-value">{value.trackNumber || "-"}</span>
          </div>
          <div className="fact">
            <span className="fact-label">Tamano</span>
            <span className="fact-value">{(track.size / (1024 * 1024)).toFixed(2)} MB</span>
          </div>
          <div className="fact">
            <span className="fact-label">Checksum</span>
            <span className="fact-value mono">{track.checksum || "Pendiente"}</span>
          </div>
        </div>

        <button className="btn btn-primary" type="button" onClick={() => setEditing(true)}>
          Editar metadatos
        </button>
      </section>
    );
  }

  return (
    <section className="panel panel-editor">
      <div className="metadata-hero">
        <div className="cover-hero">
          <CoverDropzone
            coverDataUrl={value.coverDataUrl}
            onSetCover={(coverDataUrl) => onChange({ ...value, coverDataUrl })}
          />
        </div>

        <div className="metadata-hero-info">
          <h2>{value.title || track.name}</h2>
          <p className="metadata-subtitle mono">{track.relativePath}</p>
          <div className="metadata-tags">
            {value.album && <span className="tag">{value.album}</span>}
            {value.artist && <span className="tag">{value.artist}</span>}
          </div>
          <TrackAudioPlayer track={track} onLoadAudioBytes={onLoadAudioBytes} />
        </div>
      </div>

      <div className="form-grid">
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
