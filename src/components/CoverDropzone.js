import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
async function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("No se pudo leer la imagen."));
        reader.readAsDataURL(file);
    });
}
export function CoverDropzone(props) {
    const { coverDataUrl, onSetCover } = props;
    async function useFileList(fileList) {
        if (!fileList || fileList.length === 0) {
            return;
        }
        const file = fileList[0];
        if (!file.type.startsWith("image/")) {
            return;
        }
        const dataUrl = await fileToDataUrl(file);
        onSetCover(dataUrl);
    }
    return (_jsxs("div", { className: "cover-dropzone", onDragOver: (event) => {
            event.preventDefault();
        }, onDrop: (event) => {
            event.preventDefault();
            void useFileList(event.dataTransfer.files);
        }, children: [coverDataUrl ? _jsx("img", { src: coverDataUrl, alt: "Caratula", className: "cover-image" }) : _jsx("span", { children: "Arrastra una imagen aqui" }), _jsxs("div", { className: "cover-actions", children: [_jsxs("label", { className: "btn btn-secondary", children: ["Elegir imagen", _jsx("input", { type: "file", accept: "image/*", onChange: (event) => {
                                    void useFileList(event.target.files);
                                }, hidden: true })] }), _jsx("button", { className: "btn btn-ghost", type: "button", onClick: () => onSetCover(null), children: "Quitar" })] })] }));
}
