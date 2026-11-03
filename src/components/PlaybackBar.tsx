import { useEffect, useState, type RefObject } from "react";
import type { Translate } from "../lib/i18n";
import type { Mp3Track } from "../types";

type PlaybackBarProps = {
  t: Translate;
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
  onPlaybackStateChange?: (playing: boolean) => void;
  audioRef?: RefObject<HTMLAudioElement>;
};

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function PlaybackBar(props: PlaybackBarProps): JSX.Element | null {
  const {
    t,
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
    onReturnToList,
    onPlaybackStateChange,
    audioRef
  } = props;
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!track) {
      setAudioUrl(null);
      setError(null);
      onPlaybackStateChange?.(false);
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
          setError(cause instanceof Error ? cause.message : t("playback.loadFailed"));
          onPlaybackStateChange?.(false);
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
    <div className="playback-bar" aria-label={t("playback.label")}>
      <button type="button" className="playback-icon" disabled={!canGoPrevious} onClick={onPrevious} aria-label={t("playback.previous")} title={t("playback.previous")}>
        &#9664;&#9664;
      </button>
      <button type="button" className="playback-icon" disabled={!canGoNext} onClick={onNext} aria-label={t("playback.next")} title={t("playback.next")}>
        &#9654;&#9654;
      </button>
      <button
        type="button"
        className="playback-return"
        onClick={onReturnToList}
        aria-label={t("playback.returnTo", { source: sourceLabel, position: position + 1, total })}
        title={t("playback.returnTo", { source: sourceLabel, position: position + 1, total })}
      >
        &#9776;
      </button>
      {loading ? (
        <span className="playback-status">{t("playback.loading")}</span>
      ) : (
        audioUrl && (
          <audio
            ref={audioRef}
            src={audioUrl}
            controls
            autoPlay
            onPlay={() => onPlaybackStateChange?.(true)}
            onPause={() => onPlaybackStateChange?.(false)}
            onEnded={() => {
              onPlaybackStateChange?.(false);
              onNext();
            }}
          />
        )
      )}
      {error && <span className="fact-error">{error}</span>}
    </div>
  );
}
