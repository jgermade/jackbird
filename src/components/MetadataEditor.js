import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { CoverDropzone } from "./CoverDropzone";
function Field(props) {
    return (_jsxs("label", { className: "field", children: [_jsx("span", { children: props.label }), _jsx("input", { value: props.value, placeholder: props.placeholder, onChange: (event) => props.onChange(event.target.value) })] }));
}
export function MetadataEditor(props) {
    const { track, value, saving, onChange, onSave } = props;
    if (!track) {
        return (_jsxs("section", { className: "panel panel-editor empty", children: [_jsx("h2", { children: "Editor" }), _jsx("p", { children: "Selecciona una pista para editar sus metadatos y su caratula." })] }));
    }
    return (_jsxs("section", { className: "panel panel-editor", children: [_jsxs("div", { className: "panel-title-row", children: [_jsx("h2", { children: "Editor" }), _jsx("span", { className: "mono", children: track.name })] }), _jsxs("div", { className: "form-grid", children: [_jsx(Field, { label: "Titulo", value: value.title, onChange: (title) => onChange({ ...value, title }), placeholder: "Ej: Bohemian Rhapsody" }), _jsx(Field, { label: "Artista", value: value.artist, onChange: (artist) => onChange({ ...value, artist }), placeholder: "Ej: Queen" }), _jsx(Field, { label: "Album", value: value.album, onChange: (album) => onChange({ ...value, album }), placeholder: "Ej: A Night at the Opera" }), _jsx(Field, { label: "Ano", value: value.year, onChange: (year) => onChange({ ...value, year }), placeholder: "1975" }), _jsx(Field, { label: "Genero", value: value.genre, onChange: (genre) => onChange({ ...value, genre }), placeholder: "Rock" }), _jsx(Field, { label: "Pista", value: value.trackNumber, onChange: (trackNumber) => onChange({ ...value, trackNumber }), placeholder: "1/12" })] }), _jsx(CoverDropzone, { coverDataUrl: value.coverDataUrl, onSetCover: (coverDataUrl) => onChange({ ...value, coverDataUrl }) }), _jsx("button", { className: "btn btn-primary", type: "button", disabled: saving, onClick: () => void onSave(), children: saving ? "Guardando..." : "Guardar metadatos en MP3" })] }));
}
