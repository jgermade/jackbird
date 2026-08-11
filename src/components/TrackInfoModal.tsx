import { useEffect, useRef } from "react";
import type { Mp3Track } from "../types";

type TrackInfoModalProps = {
  open: boolean;
  tracks: Mp3Track[];
  onClose: () => void;
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

export function TrackInfoModal(props: TrackInfoModalProps): JSX.Element {
  const { open, tracks, onClose } = props;
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

  const singleTrack = tracks.length === 1 ? tracks[0] : null;

  return (
    <dialog
      ref={dialogRef}
      className="track-info-modal"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      aria-labelledby="info-modal-title"
    >
      <header className="modal-header">
        <div>
          <span className="detail-eyebrow">Información del archivo</span>
          <h2 id="info-modal-title">
            {singleTrack
              ? singleTrack.metadata.title || singleTrack.name
              : `${tracks.length} pistas seleccionadas`}
          </h2>
        </div>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Cerrar modal de información" title="Cerrar">
          ✕
        </button>
      </header>
      <div className="modal-body">
        {singleTrack ? (
          <div className="track-info-detail">
            {singleTrack.metadata.coverDataUrl && (
              <div className="track-info-cover">
                <img src={singleTrack.metadata.coverDataUrl} alt={`Carátula de ${singleTrack.name}`} />
              </div>
            )}
            <dl className="track-info-grid">
              <dt>Título</dt>
              <dd>{singleTrack.metadata.title || "-"}</dd>

              <dt>Artista</dt>
              <dd>{singleTrack.metadata.artist || "-"}</dd>

              <dt>Álbum</dt>
              <dd>{singleTrack.metadata.album || "-"}</dd>

              <dt>Pista</dt>
              <dd>{singleTrack.metadata.trackNumber || "-"}</dd>

              <dt>Año</dt>
              <dd>{singleTrack.metadata.year || "-"}</dd>

              <dt>Género</dt>
              <dd>{singleTrack.metadata.genre || "-"}</dd>

              <dt>Ruta relativa</dt>
              <dd className="mono-text">{singleTrack.relativePath}</dd>

              <dt>Nombre del archivo</dt>
              <dd>{singleTrack.name}</dd>

              <dt>Tamaño</dt>
              <dd>{formatBytes(singleTrack.size)}</dd>

              <dt>Checksum Completo</dt>
              <dd className="mono-text">{singleTrack.fullChecksum || singleTrack.checksum || "-"}</dd>

              <dt>Checksum Audio (sin ID3)</dt>
              <dd className="mono-text">{singleTrack.audioChecksum || "-"}</dd>

              <dt>Última verificación</dt>
              <dd>{singleTrack.lastVerifiedAt ? new Date(singleTrack.lastVerifiedAt).toLocaleString() : "-"}</dd>
            </dl>
          </div>
        ) : (
          <div className="track-info-summary">
            <p><strong>Total de archivos:</strong> {tracks.length}</p>
            <p><strong>Tamaño total:</strong> {formatBytes(tracks.reduce((sum, t) => sum + t.size, 0))}</p>
            <ul className="track-info-list">
              {tracks.map((t) => (
                <li key={t.id}>
                  <span>{t.metadata.trackNumber ? `#${t.metadata.trackNumber}` : "-"}</span>
                  <strong>{t.metadata.title || t.name}</strong>
                  <em>{t.metadata.artist || "Artista desconocido"}</em>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </dialog>
  );
}
