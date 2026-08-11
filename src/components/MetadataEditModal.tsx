import { useEffect, useRef } from "react";
import type { EditableMetadata, Mp3Track } from "../types";
import { MetadataEditor } from "./MetadataEditor";

type MetadataEditModalProps = {
  open: boolean;
  tracks: Mp3Track[];
  value: EditableMetadata;
  saving: boolean;
  onChange: (next: EditableMetadata) => void;
  onSave: () => Promise<void>;
  onClose: () => void;
};

export function MetadataEditModal(props: MetadataEditModalProps): JSX.Element {
  const { open, tracks, value, saving, onChange, onSave, onClose } = props;
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }

    if (open && !dialog.open) {
      dialog.showModal();
    }
    if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const titleText =
    tracks.length === 1
      ? tracks[0].metadata.title || tracks[0].name
      : tracks.length > 1
        ? `Editar ${tracks.length} pistas seleccionadas`
        : "Editar pista";

  return (
    <dialog
      ref={dialogRef}
      className="metadata-edit-modal"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      aria-labelledby="edit-modal-title"
    >
      <header className="modal-header">
        <div>
          <span className="detail-eyebrow">Edición de metadatos</span>
          <h2 id="edit-modal-title">{titleText}</h2>
        </div>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Cerrar modal de edición" title="Cerrar">
          ✕
        </button>
      </header>
      <div className="modal-body">
        {tracks.length > 0 ? (
          <MetadataEditor
            tracks={tracks}
            value={value}
            saving={saving}
            onChange={onChange}
            onSave={onSave}
            isModal
          />
        ) : (
          <p>No hay pistas seleccionadas para editar.</p>
        )}
      </div>
    </dialog>
  );
}
