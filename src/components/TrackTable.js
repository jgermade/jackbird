import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function TrackTable(props) {
    const { tracks, selectedTrackId, onSelectTrack } = props;
    return (_jsxs("section", { className: "panel panel-list", children: [_jsxs("div", { className: "panel-title-row", children: [_jsx("h2", { children: "Pistas detectadas" }), _jsx("span", { children: tracks.length })] }), _jsx("div", { className: "table-wrap", children: _jsxs("table", { children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Archivo" }), _jsx("th", { children: "Titulo" }), _jsx("th", { children: "Artista" }), _jsx("th", { children: "Album" })] }) }), _jsx("tbody", { children: tracks.map((track) => {
                                const selected = track.id === selectedTrackId;
                                return (_jsxs("tr", { className: selected ? "is-selected" : "", onClick: () => onSelectTrack(track.id), children: [_jsx("td", { className: "mono", children: track.relativePath }), _jsx("td", { children: track.metadata.title || "-" }), _jsx("td", { children: track.metadata.artist || "-" }), _jsx("td", { children: track.metadata.album || "-" })] }, track.id));
                            }) })] }) })] }));
}
