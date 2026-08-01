import { useEffect, useState } from "react";
import type { Mp3Track } from "../types";

type TrackAudioPlayerProps = {
  track: Mp3Track;
  onLoadAudioBytes: (track: Mp3Track) => Promise<Uint8Array>;
};

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function TrackAudioPlayer(props: TrackAudioPlayerProps): JSX.Element {
  const { track, onLoadAudioBytes } = props;
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAudioUrl(null);
    setError(null);
  }, [track.id]);

  useEffect(() => {
    return () => {
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }
    };
  }, [audioUrl]);

  async function handlePlay(): Promise<void> {
    setLoading(true);
    setError(null);

    try {
      const bytes = await onLoadAudioBytes(track);
      const blob = new Blob([toArrayBuffer(bytes)], { type: "audio/mpeg" });
      setAudioUrl(URL.createObjectURL(blob));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el audio.");
    } finally {
      setLoading(false);
    }
  }

  if (audioUrl) {
    return <audio className="track-audio-player" src={audioUrl} controls autoPlay />;
  }

  return (
    <div className="track-audio-player-placeholder">
      <button type="button" className="btn btn-secondary" disabled={loading} onClick={() => void handlePlay()}>
        {loading ? "Cargando..." : "\u25B6 Reproducir"}
      </button>
      {error && <span className="fact-error">{error}</span>}
    </div>
  );
}
