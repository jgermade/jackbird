import { useEffect, useRef } from "react";
import type { EditableMetadata, Mp3Track } from "../types";
import { MetadataEditor } from "./MetadataEditor";

type MetadataEditModalProps = {
  open: boolean;
  track: Mp3Track | null;
  value: EditableMetadata;
  saving: boolean;
  onChange: (next: EditableMetadata) => void;
  onSave: () => Promise<void>;
  onClose: () => void;
};

export function MetadataEditModal(props: MetadataEditModalProps): JSX.Element {
  const { open, track, value, saving, onChange, onSave, onClose } = props;
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
          <h2 id="edit-modal-title">{track ? track.metadata.title || track.name : "Editar pista"}</h2>
        </div>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Cerrar modal de edición" title="Cerrar">
          ✕
        </button>
      </header>
      <div className="modal-body">
        {track ? (
          <MetadataEditor
            track={track}
            value={value}
            saving={saving}
            onChange={onChange}
            onSave={onSave}
          />
        ) : (
          <p>No hay pista seleccionada para editar.</p>
        )}
      </div>
    </dialog>
  );
}
