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
  relativePath?: string;
};

type TrackWizardListProps = {
  rows: WizardTreeRow[];
  selectedTrackId: string | null;
  activeRowKey: string | null;
  onSelectTrack: (id: string) => void;
  onSelectRow: (key: string) => void;
  onToggleAlbum: (album: string) => void;
  onToggleDisc: (album: string, disc: string) => void;
  onConsolidateTrack: (trackId: string) => void;
  loadingMetadata: boolean;
};

function TreeArrow(props: { expanded?: boolean }): JSX.Element {
  return <span className="tree-arrow">{props.expanded ? "▾" : "▸"}</span>;
}

export function TrackWizardList(props: TrackWizardListProps): JSX.Element {
  const {
    rows,
    selectedTrackId,
    activeRowKey,
    onSelectTrack,
    onSelectRow,
    onToggleAlbum,
    onToggleDisc,
    onConsolidateTrack,
    loadingMetadata
  } = props;

  return (
    <section className="panel panel-list">
      <div className="panel-title-row">
        <h2>Library</h2>
        <span>{rows.length}</span>
      </div>

      <div className="wizard-wrap">
        <ul className="tree-list">
          {rows.map((row) => {
            if (row.kind === "album") {
              const active = row.key === activeRowKey;
              return (
                <li key={row.key}>
                  <button
                    type="button"
                    className={active ? "tree-row tree-row-album is-active" : "tree-row tree-row-album"}
                    onClick={() => onSelectRow(row.key)}
                    onDoubleClick={() => onToggleAlbum(row.album)}
                  >
                    <TreeArrow expanded={row.expanded} />
                    <span className="tree-icon">📁</span>
                    <span className="tree-label">{row.label}</span>
                  </button>
                </li>
              );
            }

            if (row.kind === "disc") {
              const active = row.key === activeRowKey;
              return (
                <li key={row.key}>
                  <button
                    type="button"
                    className={active ? "tree-row tree-row-disc is-active" : "tree-row tree-row-disc"}
                    onClick={() => onSelectRow(row.key)}
                    onDoubleClick={() => onToggleDisc(row.album, row.disc ?? "Disco 1")}
                  >
                    <TreeArrow expanded={row.expanded} />
                    <span className="tree-icon">📁</span>
                    <span className="tree-label">{row.label}</span>
                  </button>
                </li>
              );
            }

            const selected = row.trackId === selectedTrackId;
            const active = row.key === activeRowKey;

            return (
              <li key={row.key} className="tree-item">
                <button
                  type="button"
                  className={
                    selected || active
                      ? "wizard-track-row tree-row-track is-selected"
                      : "wizard-track-row tree-row-track"
                  }
                  onClick={() => {
                    onSelectRow(row.key);
                    if (row.trackId) {
                      onSelectTrack(row.trackId);
                    }
                  }}
                >
                  <span className="tree-arrow tree-arrow-empty" />
                  <span className="tree-icon">💿</span>
                  <span className="wizard-track-number mono">{row.trackNumber || (loadingMetadata ? "..." : "-")}</span>
                  <span className="wizard-track-title">{row.label || (loadingMetadata ? "Cargando metadatos..." : "-")}</span>
                  <span className="wizard-track-path mono">{row.relativePath}</span>
                </button>
                <button
                  type="button"
                  className="tree-organize"
                  title="Consolidar (patron de nombre pendiente de definir)"
                  aria-label="Consolidar pista"
                  onClick={(event) => {
                    event.stopPropagation();
                    if (row.trackId) {
                      onConsolidateTrack(row.trackId);
                    }
                  }}
                >
                  🧩
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
