import type { Mp3Track } from "../types";

type TrackTableProps = {
  tracks: Mp3Track[];
  selectedTrackId: string | null;
  onSelectTrack: (id: string) => void;
};

export function TrackTable(props: TrackTableProps): JSX.Element {
  const { tracks, selectedTrackId, onSelectTrack } = props;

  return (
    <section className="panel panel-list">
      <div className="panel-title-row">
        <h2>Pistas detectadas</h2>
        <span>{tracks.length}</span>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Archivo</th>
              <th>Titulo</th>
              <th>Artista</th>
              <th>Album</th>
            </tr>
          </thead>
          <tbody>
            {tracks.map((track) => {
              const selected = track.id === selectedTrackId;
              return (
                <tr
                  key={track.id}
                  className={selected ? "is-selected" : ""}
                  onClick={() => onSelectTrack(track.id)}
                >
                  <td className="mono">{track.relativePath}</td>
                  <td>{track.metadata.title || "-"}</td>
                  <td>{track.metadata.artist || "-"}</td>
                  <td>{track.metadata.album || "-"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
