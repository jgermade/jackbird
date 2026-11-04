# The web: the queue, a menu per track, library views, renaming, playlists

What is planned for the web app, in order. The reasoning and each step's detail live in
[RECORD/2026-11-04.github-actions-workflows.WIP.md](../../RECORD/2026-11-04.github-actions-workflows.WIP.md)
(extensions of 2026-11-04, 22:00 to 22:20). It starts once E1 of
[rust-tag-engine-and-tauri.md](rust-tag-engine-and-tauri.md) is done; playlists in the family
instance's database come with its F3 ([family-instance.md](family-instance.md)).

Dates are estimates; each step ends with its "done when" met and a walkthrough in the record.

```mermaid
gantt
  title The web: queue, menus, views, renaming, playlists
  dateFormat YYYY-MM-DD
  axisFormat %d %b
  section Small
    W1 Colours, the selection dialog's tabs     :w1, 2026-11-05, 1d
    W2 No hover on touch screens                :w2, after w1, 1d
  section Playing
    W3 The queue across roots, its dialog       :w3, after w2, 3d
    W4 The menu on each row                     :w4, after w3, 3d
    W7 The 3-column spectrum on phones          :w7, after w4, 1d
  section Library
    W5 Renaming the selected tracks             :w5, after w7, 3d
    W6 Library views                            :w6, after w5, 5d
    W8 Playlists (.m3u8 in folders)             :w8, after w6, 5d
```

| Step | Scope | Done when |
| --- | --- | --- |
| W1 Colours | the stripes in the order green, orange, red (open tab, brand stripes, splash); the selection dialog's tabs Info, Edit, Rename, Delete, each with its colour on top | the four places read green, orange, red in both tones, and the dialog's tabs are in that order with their colours |
| W2 No hover | every `:hover` inside `@media (hover: hover)`, held by `npm test`; a track's ▶ and ⋮ always shown on touch screens | on an emulated phone a tap changes nothing but the pressed state, and every track shows its ▶ and ⋮ |
| W3 The queue | queue items carry their root; play next, add to queue, remove, move, clear upcoming; the list key opens the queue's dialog (with "Show in library") | a queue from two roots plays through, survives a reload, and its dialog plays, moves and removes tracks |
| W4 The menu | a `menu.html` theme component; ⋮ on tracks and folders: play next, add to queue, go to album and artist (with W6), show in folder, edit, info, rename, remove | every item works from the mouse, the keyboard and a phone, in both languages |
| W7 Spectrum | three bands at the left of the display's title on phones, while the music plays | on a phone the columns move with the music and fall when it pauses |
| W5 Renaming | the Rename tab: a `%field%` pattern with presets, a preview with clashes flagged, renames through the VFS with the library, `.meta/`, selection and queue following | the sample library renamed with `%track% - %title%`, still playing, reopened without re-reading a file |
| W6 Views | Files, Playlists, Artists, Albums by artist, Albums, Compilations, Songs, as tree rows of the active root | each view lists the sample library correctly, plays, selects and opens in Details |
| W8 Playlists | `.m3u8` files in the folder behind one playlist interface; the Playlists view; "Add to playlist…"; the queue saved as a playlist | a playlist made in jackbird opens in VLC, and one made there opens in jackbird |

Noted, decided separately: iPod sync (a spike of its own), mp3tag's pattern functions, moving files
into folders by pattern.
