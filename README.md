# MP3 Manager

Aplicacion web cliente para gestionar metadatos ID3 y caratulas de una coleccion MP3 local.

## Objetivos

- Escanear carpetas locales con la File System Access API.
- Mostrar lista de archivos MP3 encontrados.
- Editar metadatos basicos (titulo, artista, album, ano, genero, pista).
- Editar caratula por arrastrar y soltar o seleccion local.
- Guardar cambios directamente en el archivo MP3.
- Integrar una capa VFS desacoplada para futura sincronizacion remota.

## Arquitectura (inspirada en rom-manager)

- Cliente puro, sin backend.
- UI desacoplada del acceso a ficheros.
- Capa VFS por interfaz:
  - `src/vfs/types.ts`: contrato `VfsAdapter`.
  - `src/vfs/browserVfs.ts`: implementacion local con File System Access API.
- Motor de metadata sobre bytes:
  - `src/lib/id3.ts` no depende de handles directos.
  - La lectura/escritura se hace sobre `Uint8Array` para facilitar otras VFS.

## Flujo

1. Montar VFS (`BrowserVfs.mount`).
2. Listar MP3 (`BrowserVfs.listFiles`).
3. Leer bytes por archivo (`BrowserVfs.readFile`).
4. Parsear ID3 (`readTrackMetadataFromBytes`).
5. Editar en UI.
6. Serializar ID3 (`writeTrackMetadataToBytes`).
7. Persistir (`BrowserVfs.writeFile`).
8. Registrar operacion de escritura (`getWriteOperations`).

## Requisitos

- Node.js 20+
- Navegador Chromium moderno (Chrome, Edge, Brave) para File System Access API

## Desarrollo

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm run preview
```

## Nota sobre sincronizacion futura

La UI ya consume la abstraccion `VfsAdapter`. Para sincronizar con nube o repositorio remoto, puedes crear otra implementacion (por ejemplo `RemoteSyncVfs`) sin reescribir los componentes de pantalla.
