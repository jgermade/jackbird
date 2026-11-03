import { useEffect, useRef } from "react";
import { formatBytes } from "../helpers/format";
import type { Translate } from "../lib/i18n";
import type { Mp3Track } from "../types";

type TrackInfoModalProps = {
  t: Translate;
  open: boolean;
  tracks: Mp3Track[];
  onClose: () => void;
};


export function TrackInfoModal(props: TrackInfoModalProps): JSX.Element {
  const { t, open, tracks, onClose } = props;
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
          <span className="detail-eyebrow">{t("info.eyebrow")}</span>
          <h2 id="info-modal-title">
            {singleTrack
              ? singleTrack.metadata.title || singleTrack.name
              : t.n("selection.count", tracks.length)}
          </h2>
        </div>
        <button type="button" className="modal-close" onClick={onClose} aria-label={t("info.close")} title={t("common.close")}>
          ✕
        </button>
      </header>
      <div className="modal-body">
        {singleTrack ? (
          <div className="track-info-detail">
            {singleTrack.metadata.coverDataUrl && (
              <div className="track-info-cover">
                <img src={singleTrack.metadata.coverDataUrl} alt={t("album.coverOf", { title: singleTrack.name })} />
              </div>
            )}
            <dl className="track-info-grid">
              <dt>{t("field.title")}</dt>
              <dd>{singleTrack.metadata.title || "-"}</dd>

              <dt>{t("field.artist")}</dt>
              <dd>{singleTrack.metadata.artist || "-"}</dd>

              <dt>{t("field.album")}</dt>
              <dd>{singleTrack.metadata.album || "-"}</dd>

              <dt>{t("field.track")}</dt>
              <dd>{singleTrack.metadata.trackNumber || "-"}</dd>

              <dt>{t("field.year")}</dt>
              <dd>{singleTrack.metadata.year || "-"}</dd>

              <dt>{t("field.genre")}</dt>
              <dd>{singleTrack.metadata.genre || "-"}</dd>

              <dt>{t("info.relativePath")}</dt>
              <dd className="mono-text">{singleTrack.relativePath}</dd>

              <dt>{t("info.fileName")}</dt>
              <dd>{singleTrack.name}</dd>

              <dt>{t("editor.size")}</dt>
              <dd>{formatBytes(singleTrack.size)}</dd>

              <dt>{t("info.fullChecksum")}</dt>
              <dd className="mono-text">{singleTrack.fullChecksum || singleTrack.checksum || "-"}</dd>

              <dt>{t("info.audioChecksum")}</dt>
              <dd className="mono-text">{singleTrack.audioChecksum || "-"}</dd>

              <dt>{t("info.lastVerified")}</dt>
              <dd>{singleTrack.lastVerifiedAt ? new Date(singleTrack.lastVerifiedAt).toLocaleString(t.language) : "-"}</dd>
            </dl>
          </div>
        ) : (
          <div className="track-info-summary">
            <p><strong>{t("info.totalFiles")}</strong> {tracks.length}</p>
            <p><strong>{t("info.totalSize")}</strong> {formatBytes(tracks.reduce((sum, track) => sum + track.size, 0))}</p>
            <ul className="track-info-list">
              {tracks.map((track) => (
                <li key={track.id}>
                  <span>{track.metadata.trackNumber ? `#${track.metadata.trackNumber}` : "-"}</span>
                  <strong>{track.metadata.title || track.name}</strong>
                  <em>{track.metadata.artist || t("album.unknownArtist")}</em>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </dialog>
  );
}
