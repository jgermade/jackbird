type FolderPickerProps = {
  onPickFolder: () => Promise<void>;
  disabled: boolean;
  loading: boolean;
};

export function FolderPicker(props: FolderPickerProps): JSX.Element {
  const { onPickFolder, disabled, loading } = props;

  return (
    <section className="panel panel-hero">
      <h1>MP3 Manager</h1>
      <p>
        Escanea tu colección local, edita metadatos ID3 y actualiza carátulas sin subir nada a ningún servidor.
      </p>
      <button className="btn btn-primary" onClick={() => void onPickFolder()} disabled={disabled}>
        {loading ? "Escaneando colección..." : "Seleccionar carpeta musical"}
      </button>
    </section>
  );
}
