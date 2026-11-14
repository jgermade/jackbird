# Musikmatch

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
- Capa VFS sobre `@cloudauthn/vfs-sync`:
  - `VFSAdapter`: contrato por rutas (`list`/`read`/`write`/`rename`/`stat`, mas streaming opcional)
    que consume tambien el motor de sincronizacion.
  - `FSAAdapter`: implementacion local con File System Access API.
- Motor de metadata sobre bytes:
  - `src/lib/id3.ts` no depende de handles directos.
  - La lectura/escritura se hace sobre `Uint8Array` para facilitar otras VFS.

## Flujo

1. Abrir carpeta (`FSAAdapter.pick`).
2. Listar MP3 (`walk` de vfs-sync + filtro de extension).
3. Leer bytes por ruta (`VFSAdapter.read`).
4. Parsear ID3 (`readTrackMetadataFromBytes`).
5. Editar en UI.
6. Serializar ID3 (`writeTrackMetadataToBytes`).
7. Persistir (`VFSAdapter.write`).

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

## Nota sobre sincronizacion

La UI ya consume la abstraccion `VFSAdapter`, la misma que usa `@cloudauthn/vfs-sync` para
sincronizar carpetas entre si (motor tipo git: contenido direccionado por SHA-256, renames y
tombstones). Falta cablear la malla: hoy solo hay una raiz local por pestana y ninguna sesion de
sincronizacion activa.
