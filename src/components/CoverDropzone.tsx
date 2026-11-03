import type { Translate } from "../lib/i18n";

type CoverDropzoneProps = {
  t: Translate;
  coverDataUrl: string | null;
  onSetCover: (dataUrl: string | null) => void;
  compact?: boolean;
};

async function fileToDataUrl(file: File, failure: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(failure));
    reader.readAsDataURL(file);
  });
}

export function CoverDropzone(props: CoverDropzoneProps): JSX.Element {
  const { t, coverDataUrl, onSetCover, compact = false } = props;

  async function useFileList(fileList: FileList | null): Promise<void> {
    if (!fileList || fileList.length === 0) {
      return;
    }
    const file = fileList[0];
    if (!file.type.startsWith("image/")) {
      return;
    }
    const dataUrl = await fileToDataUrl(file, t("cover.readFailed"));
    onSetCover(dataUrl);
  }

  return (
    <div
      className={compact ? "cover-dropzone cover-dropzone-compact" : "cover-dropzone"}
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        void useFileList(event.dataTransfer.files);
      }}
    >
      {coverDataUrl ? <img src={coverDataUrl} alt={t("editor.cover")} className="cover-image" /> : <span>{t("cover.dropHere")}</span>}

      {compact ? (
        <label className="cover-edit-overlay" title={t("cover.change")}>
          <span aria-hidden="true">{"\u270e"}</span>
          <span className="sr-only">{t("cover.change")}</span>
          <input
            type="file"
            accept="image/*"
            onChange={(event) => {
              void useFileList(event.target.files);
            }}
            hidden
          />
        </label>
      ) : (
        <div className="cover-actions">
          <label className="btn btn-secondary">
            {t("cover.choose")}
            <input
              type="file"
              accept="image/*"
              onChange={(event) => {
                void useFileList(event.target.files);
              }}
              hidden
            />
          </label>
          <button className="btn btn-ghost" type="button" onClick={() => onSetCover(null)}>
            {t("cover.remove")}
          </button>
        </div>
      )}
    </div>
  );
}
