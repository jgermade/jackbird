type FolderPickerProps = {
  onPickFolder: () => Promise<void>;
  disabled: boolean;
  loading: boolean;
  hasRoots: boolean;
};

export function FolderPicker(props: FolderPickerProps): JSX.Element {
  const { onPickFolder, disabled, loading, hasRoots } = props;

  return (
    <button className="toolbar-add-btn" onClick={() => void onPickFolder()} disabled={disabled}>
      <span className="toolbar-add-icon">+</span>
      <span>
        {loading
          ? "Escaneando..."
          : hasRoots
            ? "Añadir root"
            : "Abrir libreria"}
      </span>
    </button>
  );
}
