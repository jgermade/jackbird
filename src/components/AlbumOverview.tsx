import type { Mp3Track } from "../types";

type AlbumOverviewProps = {
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
  discs: Map<string, Mp3Track[]>;
};

function discLabel(track: Mp3Track): string {
  const fromPath = track.relativePath.match(/(?:^|\/)(?:cd|disc)[ _-]?(\d+)(?:\/|$)/i);
  if (fromPath?.[1]) {
    return `Disco ${fromPath[1]}`;
  }

  return "Disco 1";
}

function trackOrder(track: Mp3Track): number {
  const match = track.metadata.trackNumber.match(/\d+/);
  return match ? Number(match[0]) : Number.POSITIVE_INFINITY;
}

function groupAlbums(tracks: Mp3Track[]): AlbumGroup[] {
  const groups = new Map<string, AlbumGroup>();

  for (const track of tracks) {
    const title = track.metadata.album.trim() || "Sin album";
    const artist = track.metadata.artist.trim();
    const key = `${artist.toLocaleLowerCase("es")}::${title.toLocaleLowerCase("es")}`;
    const existing = groups.get(key);
    const group = existing ?? {
      key,
      title,
      artist,
      year: track.metadata.year,
      genre: track.metadata.genre,
      coverDataUrl: track.metadata.coverDataUrl,
      discs: new Map<string, Mp3Track[]>()
    };

    const disc = discLabel(track);
    const discTracks = group.discs.get(disc) ?? [];
    discTracks.push(track);
    group.discs.set(disc, discTracks);

    if (!existing) {
      groups.set(key, group);
    }
  }

  return [...groups.values()].sort((left, right) => left.title.localeCompare(right.title, "es"));
}

export function AlbumOverview(props: AlbumOverviewProps): JSX.Element {
  const {
    rootLabel,
    tracks,
    selectedTrackIds = [],
    onSelectTrack,
    onPlayTrack,
    playingTrackId,
    isAudioPlaying = false
  } = props;
  const albums = groupAlbums(tracks);
  const selectedSet = new Set(selectedTrackIds);

  return (
    <section className="album-overview">
      <header className="album-overview-header">
        <span className="detail-eyebrow">Carpeta</span>
        <h2>{rootLabel}</h2>
        <p>{albums.length} albumes, {tracks.length} pistas</p>
      </header>

      <div className="album-overview-list">
        {albums.map((album) => (
          <article key={album.key} className="album-summary">
            <div className="album-summary-cover">
              {album.coverDataUrl ? <img src={album.coverDataUrl} alt={`Caratula de ${album.title}`} /> : <span>Sin caratula</span>}
            </div>
            <div className="album-summary-content">
              <h3>{album.title}</h3>
              <p>{album.artist || "Artista desconocido"}</p>
              <div className="metadata-tags">
                {album.year && <span className="tag">{album.year}</span>}
                {album.genre && <span className="tag">{album.genre}</span>}
              </div>
              <div className="album-discs">
                {[...album.discs.entries()].map(([disc, discTracks]) => (
                  <section key={disc} className="album-disc">
                    <header>
                      <strong>{disc}</strong>
                      <span>{discTracks.length} pistas</span>
                    </header>
                    <ol>
                      {[...discTracks]
                        .sort((left, right) => trackOrder(left) - trackOrder(right))
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
                                  aria-label={
                                    showPauseIcon
                                      ? `Pausar ${track.metadata.title || track.name}`
                                      : `Reproducir ${track.metadata.title || track.name}`
                                  }
                                  title={showPauseIcon ? "Pausar" : "Reproducir desde esta pista"}
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
