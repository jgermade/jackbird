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
  const { track, value, saving, onChange, onSave } = props;

  if (!track) {
    return (
      <section className="panel panel-editor empty">
        <h2>Editor</h2>
        <p>Selecciona una pista para editar sus metadatos y su caratula.</p>
      </section>
    );
  }

  return (
    <section className="panel panel-editor">
      <div className="panel-title-row">
        <h2>Editor</h2>
        <span className="mono">{track.name}</span>
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

      <CoverDropzone
        coverDataUrl={value.coverDataUrl}
        onSetCover={(coverDataUrl) => onChange({ ...value, coverDataUrl })}
      />

      <button className="btn btn-primary" type="button" disabled={saving} onClick={() => void onSave()}>
        {saving ? "Guardando..." : "Guardar metadatos en MP3"}
      </button>
    </section>
  );
}
