import type { Translate } from "../lib/i18n";

type FolderPickerProps = {
  t: Translate;
  onPickFolder: () => Promise<void>;
  disabled: boolean;
  loading: boolean;
  hasRoots: boolean;
};

export function FolderPicker(props: FolderPickerProps): JSX.Element {
  const { t, onPickFolder, disabled, loading, hasRoots } = props;

  return (
    <button className="toolbar-add-btn" onClick={() => void onPickFolder()} disabled={disabled}>
      <span className="toolbar-add-icon">+</span>
      <span>
        {loading ? t("picker.scanning") : hasRoots ? t("picker.addRoot") : t("picker.openLibrary")}
      </span>
    </button>
  );
}
