type CoverDropzoneProps = {
  coverDataUrl: string | null;
  onSetCover: (dataUrl: string | null) => void;
};

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("No se pudo leer la imagen."));
    reader.readAsDataURL(file);
  });
}

export function CoverDropzone(props: CoverDropzoneProps): JSX.Element {
  const { coverDataUrl, onSetCover } = props;

  async function useFileList(fileList: FileList | null): Promise<void> {
    if (!fileList || fileList.length === 0) {
      return;
    }
    const file = fileList[0];
    if (!file.type.startsWith("image/")) {
      return;
    }
    const dataUrl = await fileToDataUrl(file);
    onSetCover(dataUrl);
  }

  return (
    <div
      className="cover-dropzone"
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        void useFileList(event.dataTransfer.files);
      }}
    >
      {coverDataUrl ? <img src={coverDataUrl} alt="Caratula" className="cover-image" /> : <span>Arrastra una imagen aqui</span>}

      <div className="cover-actions">
        <label className="btn btn-secondary">
          Elegir imagen
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
          Quitar
        </button>
      </div>
    </div>
  );
}
