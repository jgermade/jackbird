export type WizardTreeRow = {
  key: string;
  kind: "album" | "disc" | "track";
  album: string;
  label: string;
  parentKey: string | null;
  depth: number;
  disc?: string;
  expanded?: boolean;
  trackId?: string;
  trackNumber?: string;
  artist?: string;
  relativePath?: string;
};

type TrackWizardListProps = {
  rows: WizardTreeRow[];
  selectedTrackIds: string[];
  activeRowKey: string | null;
  onSelectTrack: (id: string, extendRange: boolean) => void;
  onSelectRow: (key: string) => void;
  onToggleAlbum: (album: string) => void;
  onToggleDisc: (album: string, disc: string) => void;
  onConsolidateTrack: (trackId: string) => void;
  loadingMetadata: boolean;
};

function CaretGlyph({ expanded }: { expanded?: boolean }): JSX.Element {
  return (
    <svg
      className={expanded ? "tree-glyph tree-caret-glyph is-expanded" : "tree-glyph tree-caret-glyph"}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6 3.5L11 8l-5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FolderGlyph({ open }: { open?: boolean }): JSX.Element {
  return (
    <svg className="tree-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {open ? (
        <path
          d="M1.5 4.5h4l1.2 1.2H14.5v6.3a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1V4.5zm0 0V3.8A1.3 1.3 0 0 1 2.8 2.5h2.4L6.5 3.8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M1.5 4.2V12a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V5.8a1 1 0 0 0-1-1H7.2L5.8 3.4H2.5a1 1 0 0 0-1 1z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

function TrackGlyph(): JSX.Element {
  return (
    <svg className="tree-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="6" cy="11.5" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8.2 11.5V3.6l5.3-1.1v7.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="13.5" cy="10" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function OrganizeGlyph(): JSX.Element {
  return (
    <svg className="tree-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M3 4.5h10M3 8h10M3 11.5h10M5.5 3v3M10.5 6.5v3M7.5 10v3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function TrackWizardList(props: TrackWizardListProps): JSX.Element {
  const {
    rows,
    selectedTrackIds,
    activeRowKey,
    onSelectTrack,
    onSelectRow,
    onToggleAlbum,
    onToggleDisc,
    onConsolidateTrack,
    loadingMetadata
  } = props;

  if (rows.length === 0) {
    return (
      <section className="panel panel-list">
        <div className="wizard-wrap">
          <p className="tree-empty">
            {loadingMetadata ? "Cargando biblioteca..." : "Sin pistas en este root."}
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="panel panel-list">
      <div className="wizard-wrap">
        <ul className="tree-list">
          {rows.map((row) => {
            const depthStyle = { ["--tree-depth" as string]: String(row.depth) };

            if (row.kind === "album" || row.kind === "disc") {
              const active = row.key === activeRowKey;
              const isDisc = row.kind === "disc";
              const rowClass = [
                "tree-row",
                isDisc ? "tree-row-disc" : "tree-row-album",
                active ? "is-active" : ""
              ]
                .filter(Boolean)
                .join(" ");

              return (
                <li key={row.key} className="tree-folder-item" style={depthStyle}>
                  <button
                    type="button"
                    className="tree-caret"
                    aria-label={`${row.expanded ? "Colapsar" : "Expandir"} ${row.label}`}
                    aria-expanded={row.expanded}
                    onClick={() => {
                      if (isDisc) {
                        onToggleDisc(row.album, row.disc ?? "Disco 1");
                      } else {
                        onToggleAlbum(row.album);
                      }
                    }}
                  >
                    <CaretGlyph expanded={row.expanded} />
                  </button>
                  <button type="button" className={rowClass} onClick={() => onSelectRow(row.key)}>
                    <span className="tree-icon">
                      <FolderGlyph open={row.expanded} />
                    </span>
                    <span className="tree-label">{row.label}</span>
                  </button>
                </li>
              );
            }

            const selected = Boolean(row.trackId && selectedTrackIds.includes(row.trackId));
            const active = row.key === activeRowKey;
            const trackClass = [
              "wizard-track-row",
              "tree-row-track",
              selected ? "is-selected" : "",
              active && !selected ? "is-active" : ""
            ]
              .filter(Boolean)
              .join(" ");

            return (
              <li key={row.key} className="tree-item" style={depthStyle}>
                <span className="tree-caret-spacer" aria-hidden="true" />
                <button
                  type="button"
                  className={trackClass}
                  onClick={(event) => {
                    if (row.trackId) {
                      onSelectTrack(row.trackId, event.shiftKey);
                    }
                  }}
                >
                  <span className="tree-icon">
                    <TrackGlyph />
                  </span>
                  <span className="wizard-track-number mono">
                    {row.trackNumber || (loadingMetadata ? "…" : "—")}
                  </span>
                  <span className="wizard-track-meta">
                    <span className="wizard-track-title">
                      {row.label || (loadingMetadata ? "Cargando metadatos…" : "—")}
                    </span>
                    {row.artist ? <span className="wizard-track-artist">{row.artist}</span> : null}
                  </span>
                </button>
                <button
                  type="button"
                  className="tree-organize"
                  title="Consolidar (patrón de nombre pendiente de definir)"
                  aria-label="Consolidar pista"
                  onClick={(event) => {
                    event.stopPropagation();
                    if (row.trackId) {
                      onConsolidateTrack(row.trackId);
                    }
                  }}
                >
                  <OrganizeGlyph />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
