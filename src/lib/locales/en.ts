// The interface's texts, in English: the source every translation follows
// and the fallback for any text a translation lacks. Keys group by screen.
// A counted text has `.one` and `.other` forms and is read with `t.n(key, count)`.
// `{name}` marks a value filled in at runtime.

export const en = {
  "app.name": "jackbird",
  "language.self": "English",

  "common.none": "-",

  "picker.scanning": "Scanning…",
  "picker.addRoot": "Add root",
  "picker.openLibrary": "Open library",

  "roots.empty": "No roots open",
  "roots.close": "Close {name}",
  "roots.fallbackName": "Root {number}",

  "landing.title": "Your library, right where it is",
  "landing.body": "Open a music folder to browse its albums, review their metadata and edit covers without uploading your files anywhere.",
  "landing.open": "Open folder",
  "landing.note": "Changes are written straight to your MP3 files.",

  "library.title": "Library",
  "library.expandAll": "Expand all",
  "library.collapseAll": "Collapse all",
  "library.restoring": "Restoring tabs…",
  "library.loadingMetadata": "Loading metadata {loaded}/{total}…",

  "tree.label": "Folders and tracks",
  "panels.label": "Panels",
  "panels.details": "Details",
  "tree.loadingLibrary": "Loading library…",
  "tree.empty": "No tracks in this root.",
  "tree.loadingMetadata": "Loading metadata…",
  "tree.renameTitle": "Rename (pattern still to be defined)",
  "tree.rename": "Rename track",

  "selection.count.one": "{count} track selected",
  "selection.count.other": "{count} tracks selected",
  "actions.showInfo": "Show info",
  "actions.edit": "Edit",
  "actions.delete": "Delete",
  "actions.clearSelection": "Clear selection",

  "detail.promptTitle": "Select an album or a track",
  "detail.promptBody": "Choose a folder in the tree to see its albums, or hold Shift while clicking tracks to review several at once.",

  "album.folder": "Folder",
  "album.count.one": "{count} album",
  "album.count.other": "{count} albums",
  "tracks.count.one": "{count} track",
  "tracks.count.other": "{count} tracks",
  "album.coverOf": "Cover of {title}",
  "album.untitled": "No album",
  "album.unknownArtist": "Unknown artist",
  "album.disc": "Disc {number}",
  "album.play": "Play {title}",

  "faceplate.transport": "Transport",
  "faceplate.play": "Play",
  "faceplate.pause": "Pause",
  "faceplate.state.stopped": "Stop",
  "faceplate.state.playing": "Play",
  "faceplate.state.paused": "Pause",
  "faceplate.state.loading": "Loading",
  "faceplate.state.error": "Error",
  "faceplate.idle": "Nothing playing",
  "faceplate.position": "Position",
  "faceplate.positionText": "{position} of {duration}",
  "faceplate.tone": "Dark tone",
  "faceplate.light": "Silver",
  "faceplate.dark": "Graphite",
  "faceplate.roots": "Open roots",

  "playback.label": "Playlist player",
  "playback.previous": "Previous track",
  "playback.next": "Next track",
  "playback.returnTo": "Back to {source}, track {position} of {total}",
  "playback.loadFailed": "Could not load the audio.",
  "playback.folderGone": "The playlist's folder is no longer available.",

  "field.title": "Title",
  "field.artist": "Artist",
  "field.album": "Album",
  "field.year": "Year",
  "field.genre": "Genre",
  "field.track": "Track",

  "editor.variousArtists": "(Various artists)",
  "editor.sharedArtist": "Shared artist",
  "editor.cover": "Cover",
  "editor.metadata": "Metadata",
  "editor.multipleValues": "(Multiple values)",
  "editor.example": "e.g. {value}",
  "editor.fileData": "File data",
  "editor.file": "File",
  "editor.path": "Path",
  "editor.size": "Size",
  "editor.checksum": "Checksum",
  "editor.pending": "Pending",
  "editor.cancel": "Cancel",
  "editor.saving": "Saving…",
  "editor.save": "Save changes",

  "editModal.eyebrow": "Metadata editing",
  "editModal.titleMany": "Edit {count} selected tracks",
  "editModal.titleOne": "Edit track",
  "editModal.close": "Close the edit dialog",
  "editModal.none": "No tracks selected to edit.",

  "cover.readFailed": "Could not read the image.",
  "cover.dropHere": "Drop an image here",
  "cover.choose": "Choose image",
  "cover.remove": "Remove",

  "info.eyebrow": "File information",
  "info.close": "Close the information dialog",
  "info.relativePath": "Relative path",
  "info.fileName": "File name",
  "info.fullChecksum": "Full checksum",
  "info.audioChecksum": "Audio checksum (without ID3)",
  "info.lastVerified": "Last verified",
  "info.totalFiles": "Total files:",
  "info.totalSize": "Total size:",

  "preferences.open": "Open preferences",
  "preferences.title": "Preferences",
  "preferences.close": "Close preferences",
  "preferences.appearance": "Appearance",
  "preferences.darkOn": "Dark theme on",
  "preferences.lightOn": "Light theme on",
  "preferences.language": "Language",
  "preferences.languageHint": "Interface language. Where a text has no translation, it is shown in English.",

  "message.noFsa": "Your browser does not support the File System Access API.",
  "message.scanFailed": "Could not scan the selected folder.",
  "message.removeConfirm.one": "Remove this track from the library?",
  "message.removeConfirm.other": "Remove the {count} selected tracks from the library?",
  "message.removed.one": "Track removed from the library.",
  "message.removed.other": "{count} tracks removed from the library.",
  "message.readFailed.one": "{count} file in {name} could not be read.",
  "message.readFailed.other": "{count} files in {name} could not be read.",
  "message.resyncing": "Resyncing root {name}…",
  "message.consolidatePending": "Consolidate: the naming pattern is still to be defined (mp3tag style). Placeholder button for now.",
  "message.saved": "Metadata saved to {target}.",
  "message.saveFailed": "Could not save the changes."
} as const satisfies Record<string, string>;

export type MessageKey = keyof typeof en;

/** The base of every counted key: `tracks.count` for `tracks.count.one` / `.other`. */
export type PluralKey = { [K in MessageKey]: K extends `${infer Base}.other` ? Base : never }[MessageKey];
