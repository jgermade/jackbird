import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function FolderPicker(props) {
    const { onPickFolder, disabled, loading } = props;
    return (_jsxs("section", { className: "panel panel-hero", children: [_jsx("h1", { children: "MP3 Manager" }), _jsx("p", { children: "Escanea tu colecci\u00F3n local, edita metadatos ID3 y actualiza car\u00E1tulas sin subir nada a ning\u00FAn servidor." }), _jsx("button", { className: "btn btn-primary", onClick: () => void onPickFolder(), disabled: disabled, children: loading ? "Escaneando colección..." : "Seleccionar carpeta musical" })] }));
}
