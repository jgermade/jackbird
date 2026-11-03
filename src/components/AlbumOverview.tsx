import { inferDiscNumber, trackNumberOrder } from "../helpers/tracks";
import type { Translate } from "../lib/i18n";
import type { Mp3Track } from "../types";

type AlbumOverviewProps = {
  t: Translate;
  rootLabel: string;
  tracks: Mp3Track[];
  selectedTrackIds?: string[];
  onSelectTrack: (trackId: string, options?: { toggle?: boolean; extendRange?: boolean }) => void;
  onPlayTrack: (trackId: string) => void;
  playingTrackId: string | null;
  isAudioPlaying?: boolean;
};

type AlbumGroup = {
  key: string;
  title: string;
  artist: string;
  year: string;
  genre: string;
  coverDataUrl: string | null;
  /** Tracks by disc number. */
  discs: Map<number, Mp3Track[]>;
};

/** Albums by artist and album tag; a track with no album tag goes under `untitled`. */
function groupAlbums(tracks: Mp3Track[], untitled: string, locale: string): AlbumGroup[] {
  const groups = new Map<string, AlbumGroup>();

  for (const track of tracks) {
    const album = track.metadata.album.trim();
    const artist = track.metadata.artist.trim();
    const key = `${artist.toLocaleLowerCase(locale)}::${album.toLocaleLowerCase(locale)}`;
    const group = groups.get(key) ?? {
      key,
      title: album || untitled,
      artist,
      year: track.metadata.year,
      genre: track.metadata.genre,
      coverDataUrl: track.metadata.coverDataUrl,
      discs: new Map<number, Mp3Track[]>()
    };
    groups.set(key, group);

    const disc = inferDiscNumber(track);
    group.discs.set(disc, [...(group.discs.get(disc) ?? []), track]);
  }

  return [...groups.values()].sort((left, right) => left.title.localeCompare(right.title, locale));
}

export function AlbumOverview(props: AlbumOverviewProps): JSX.Element {
  const {
    t,
    rootLabel,
    tracks,
    selectedTrackIds = [],
    onSelectTrack,
    onPlayTrack,
    playingTrackId,
    isAudioPlaying = false
  } = props;
  const albums = groupAlbums(tracks, t("album.untitled"), t.language);
  const selectedSet = new Set(selectedTrackIds);

  return (
    <section className="album-overview">
      <header className="album-overview-header">
        <span className="detail-eyebrow">{t("album.folder")}</span>
        <h2>{rootLabel}</h2>
        <p>{t.n("album.count", albums.length)}, {t.n("tracks.count", tracks.length)}</p>
      </header>

      <div className="album-overview-list">
        {albums.map((album) => (
          <article key={album.key} className="album-summary">
            <div className="album-summary-cover">
              {album.coverDataUrl ? <img src={album.coverDataUrl} alt={t("album.coverOf", { title: album.title })} /> : <span>{t("album.noCover")}</span>}
            </div>
            <div className="album-summary-content">
              <h3>{album.title}</h3>
              <p>{album.artist || t("album.unknownArtist")}</p>
              <div className="metadata-tags">
                {album.year && <span className="tag">{album.year}</span>}
                {album.genre && <span className="tag">{album.genre}</span>}
              </div>
              <div className="album-discs">
                {[...album.discs.entries()].map(([disc, discTracks]) => (
                  <section key={disc} className="album-disc">
                    <header>
                      <strong>{t("album.disc", { number: disc })}</strong>
                      <span>{t.n("tracks.count", discTracks.length)}</span>
                    </header>
                    <ol>
                      {[...discTracks]
                        .sort((left, right) => trackNumberOrder(left) - trackNumberOrder(right))
                        .map((track) => {
                          const isSelected = selectedSet.has(track.id);
                          const isCurrentPlayback = playingTrackId === track.id;
                          const showPauseIcon = isCurrentPlayback && isAudioPlaying;
                          const rowClass = [
                            "album-track-row",
                            isSelected && "is-selected",
                            isCurrentPlayback && "is-playing"
                          ]
                            .filter(Boolean)
                            .join(" ");

                          return (
                            <li key={track.id}>
                              <div
                                className={rowClass}
                                onClick={(event) => {
                                  onSelectTrack(track.id, {
                                    toggle: !event.shiftKey,
                                    extendRange: event.shiftKey
                                  });
                                }}
                                role="button"
                                tabIndex={0}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    onSelectTrack(track.id, {
                                      toggle: !event.shiftKey,
                                      extendRange: event.shiftKey
                                    });
                                  }
                                }}
                              >
                                <div className="album-track-main">
                                  <span>{track.metadata.trackNumber || "-"}</span>
                                  <span>{track.metadata.title || track.name}</span>
                                </div>
                                <button
                                  type="button"
                                  className="album-track-play"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    onPlayTrack(track.id);
                                  }}
                                  aria-label={t(showPauseIcon ? "album.pause" : "album.play", { title: track.metadata.title || track.name })}
                                  title={showPauseIcon ? t("album.pauseShort") : t("album.playFromHere")}
                                >
                                  {showPauseIcon ? "⏸" : "▶"}
                                </button>
                              </div>
                            </li>
                          );
                        })}
                    </ol>
                  </section>
                ))}
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
