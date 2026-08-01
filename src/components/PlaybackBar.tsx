import { useEffect, useState } from "react";
import type { Mp3Track } from "../types";

type PlaybackBarProps = {
  track: Mp3Track | null;
  trackKey: string | null;
  sourceLabel: string;
  position: number;
  total: number;
  canGoPrevious: boolean;
  canGoNext: boolean;
  onLoadAudioBytes: (track: Mp3Track) => Promise<Uint8Array>;
  onPrevious: () => void;
  onNext: () => void;
  onReturnToList: () => void;
};

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function PlaybackBar(props: PlaybackBarProps): JSX.Element | null {
  const {
    track,
    trackKey,
    sourceLabel,
    position,
    total,
    canGoPrevious,
    canGoNext,
    onLoadAudioBytes,
    onPrevious,
    onNext,
    onReturnToList
  } = props;
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!track) {
      setAudioUrl(null);
      setError(null);
      return;
    }

    let cancelled = false;
      setAudioUrl(null);
    setLoading(true);
    setError(null);

    void onLoadAudioBytes(track)
      .then((bytes) => {
        if (!cancelled) {
          setAudioUrl(URL.createObjectURL(new Blob([toArrayBuffer(bytes)], { type: "audio/mpeg" })));
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "No se pudo cargar el audio.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [trackKey]);

  useEffect(() => {
    return () => {
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }
    };
  }, [audioUrl]);

  if (!track) {
    return null;
  }

  return (
    <div className="playback-bar" aria-label="Reproductor de lista">
      <button type="button" className="playback-icon" disabled={!canGoPrevious} onClick={onPrevious} aria-label="Pista anterior" title="Pista anterior">
        &#9664;&#9664;
      </button>
      <button type="button" className="playback-icon" disabled={!canGoNext} onClick={onNext} aria-label="Pista siguiente" title="Pista siguiente">
        &#9654;&#9654;
      </button>
      <button
        type="button"
        className="playback-return"
        onClick={onReturnToList}
        aria-label={`Volver a ${sourceLabel}, pista ${position + 1} de ${total}`}
        title={`Volver a ${sourceLabel}, pista ${position + 1} de ${total}`}
      >
        &#9776;
      </button>
      {loading ? <span className="playback-status">Cargando...</span> : audioUrl && <audio src={audioUrl} controls autoPlay onEnded={onNext} />}
      {error && <span className="fact-error">{error}</span>}
    </div>
  );
}
