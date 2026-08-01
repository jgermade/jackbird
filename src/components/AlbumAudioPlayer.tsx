import { useEffect, useState } from "react";
import type { Mp3Track } from "../types";

type AlbumAudioPlayerProps = {
  tracks: Mp3Track[];
  onLoadAudioBytes: (track: Mp3Track) => Promise<Uint8Array>;
};

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function trackOrder(track: Mp3Track): number {
  const match = track.metadata.trackNumber.match(/\d+/);
  return match ? Number(match[0]) : Number.POSITIVE_INFINITY;
}

export function AlbumAudioPlayer(props: AlbumAudioPlayerProps): JSX.Element | null {
  const { tracks, onLoadAudioBytes } = props;
  const playlist = [...tracks].sort((left, right) => trackOrder(left) - trackOrder(right));
  const [trackIndex, setTrackIndex] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advancePending, setAdvancePending] = useState(false);
  const currentTrack = playlist[trackIndex] ?? null;
  const playlistKey = playlist.map((track) => track.id).join("|");

  useEffect(() => {
    setTrackIndex(0);
    setAudioUrl(null);
    setError(null);
    setAdvancePending(false);
  }, [playlistKey]);

  useEffect(() => {
    return () => {
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }
    };
  }, [audioUrl]);

  async function loadCurrentTrack(): Promise<void> {
    if (!currentTrack) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const bytes = await onLoadAudioBytes(currentTrack);
      setAudioUrl(URL.createObjectURL(new Blob([toArrayBuffer(bytes)], { type: "audio/mpeg" })));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo cargar el audio.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!advancePending) {
      return;
    }

    setAdvancePending(false);
    void loadCurrentTrack();
  }, [advancePending, trackIndex]);

  if (!currentTrack) {
    return null;
  }

  return (
    <div className="album-audio-player">
      {audioUrl ? (
        <audio
          className="track-audio-player"
          src={audioUrl}
          controls
          autoPlay
          onEnded={() => {
            if (trackIndex < playlist.length - 1) {
              setAudioUrl(null);
              setTrackIndex((index) => index + 1);
              setAdvancePending(true);
            }
          }}
        />
      ) : (
        <button type="button" className="btn btn-secondary" disabled={loading} onClick={() => void loadCurrentTrack()}>
          {loading ? "Cargando..." : "\u25B6 Reproducir album"}
        </button>
      )}
      <span>{currentTrack.metadata.title || currentTrack.name}</span>
      {error && <span className="fact-error">{error}</span>}
    </div>
  );
}
