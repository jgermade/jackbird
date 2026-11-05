# Using jackbird

## Browser support

jackbird works on your files where they are, through the browser's File System Access API. That
API is in Chromium-based desktop browsers: Chrome, Edge, Brave and Opera. In a browser without it,
jackbird says so when you try to open a folder.

## Opening folders

**Open folder** (on the landing page) or **Open library** (above the library) asks you to pick a
folder. The browser then asks for permission to edit the files in it: jackbird needs it to save
your changes.

Each folder you open is a **root**, shown as a tab with its number of tracks. You can keep several
open at once with **+ Folder**, switch between them with their tabs, and close one with its ×. On a
phone only the open root's tab shows, with a ⌄: tap it for the list of roots. Pick one to switch
to it, close the open one with the × beside it in the list, or open another with **Add a folder**,
at the end of the list.

jackbird reads every `.mp3` file in the folder and its subfolders. The first time, it reads all of
their tags. It then keeps what it learned in `.meta/mp3-manager.json` inside the folder, so the
next time it shows the library at once and reads only the files that are new or have changed,
in the background.

When you reload the page, the roots you had open come back by themselves, as long as the browser
still grants permission for them: each with its open folders and the folder it showed, and the
panel and scroll positions you were at. The track that was playing comes back at the same second
and plays on. A reload stops the sound for a moment, since a page cannot play through its own
reload; and if the browser does not let the page start sound by itself, the track waits, paused at
its place, and your first click or key anywhere resumes it.

## The library

The left panel lists the active root's folders and tracks. A click on a folder's triangle or
its folder glyph opens or closes it (an open folder draws an open folder). Choosing a folder shows
what it holds on the right, and choosing a track shows its folder. Until you choose one, the right panel shows the whole root.

A click on a track plays it (its folder, from that track): on a computer, a ▶ at the end of the
row shows when the pointer is over it, and the track playing shows moving bars there. Each folder
has a ❯ key at its end (on a computer, it shows when the pointer is over the row) that shows the
folder on the right; on a phone, it also takes you to the **Details** panel. The box at the left
of each track selects it (see [Selecting tracks](#selecting-tracks)).

With the keyboard, the arrows move through the tree and open and close folders, **Enter** plays
the row you are on (on a folder, from its first track), and **Space** selects or deselects the
track you are on.

On a phone, the two panels take turns: swipe between them, or use the **Library** and **Details**
keys at the top right.

### Views

The keys at the top of the library list the root in other ways; the one down is the view open, and
each folder keeps its own across visits. The number after them is how many tracks the folder has.

- **Files**: its folders, as above.
- **Playlists**: its playlist files (see [Playlists](#playlists)).
- **Artists**: each artist, opening into their tracks, by album.
- **Albums by artist**: each artist, their albums, then the tracks.
- **Albums**: each album with its artist beside it ("Various artists" when it has several). An album
  is the tracks that share the album tag in one folder, a "Disc 1" or "CD 2" folder counting as
  its album's, so a two-disc album is one.
- **Compilations**: the albums with more than one artist.
- **Songs**: every track by title, its artist beside it.

Tracks without an artist or album go under "Unknown artist" or "No album". In every view the
keyboard, the selection, ▶ and ⋮ work as in Files; choosing an artist or an album shows it on the
right, and a track plays its group (or, in Songs, the list) from it, in the order shown. A track's
⋮ also has **Go to album** and **Go to artist**, which switch to that view with the album or the
artist shown on the right.

## Playlists

A playlist is a `.m3u8` or `.m3u` file in the folder you opened, anywhere in it: jackbird lists
the ones it finds in the **Playlists** view, and other players (VLC, foobar2000, Winamp…) read the
ones jackbird writes. Each opens into its tracks, in its order, the number beside it saying how
many it has. A track the playlist names that is not in the library (moved, deleted, outside the
folder, or a web address) stays in it, dimmed, as "Not in the library".

- **Add to playlist…**, in a track's or a folder's menu, asks which playlist: one of the folder's,
  or a new one by name. A new playlist is written as `Playlists/<name>.m3u8` at the top of the
  folder; a name already used is refused.
- A playlist's ⋮: **Play**, **Play next**, **Add to queue**, **Open in Details** and **Delete
  playlist…**, which deletes its file once you confirm (its tracks stay where they are).
- A track's ⋮ in a playlist adds **Move up**, **Move down** and **Remove from playlist** (the
  file stays where it is). A track not in the library has only those three.
- **Save as playlist…**, in the queue, saves it in one of the open folders, by name (on a
  computer it opens as a sheet over the queue's list, under its head; **Escape** or a click on the
  dimmed list closes the sheet alone). A playlist can only hold tracks of its own folder, so the
  queue's tracks from other folders are left out: the dialog says how many before you save.

Playing a playlist (or a track of it) plays it in its order. Renaming tracks in jackbird updates
the playlists of their folder that name them.

jackbird writes a playlist as UTF-8 text: `#EXTM3U`, then for each track an `#EXTINF` line with
"Artist - Title" and its path relative to the playlist's folder, with forward slashes, which VLC
and other players open. It reads `#EXTINF` titles and lengths, paths with backslashes, `.m3u` files
in UTF-8 or in the older Windows-1252, and the paths other players write: relative ones with
`%20` escapes, and absolute ones or `file:///` addresses (VLC writes these), which it finds in the
folder by their end (`/home/me/Music/Jazz/So What.mp3` is `Jazz/So What.mp3` in a folder opened at
`Music`). When it changes a playlist made by another player, it keeps its tracks and their titles,
writing their paths relative, but not the player's other `#` lines; a `.m3u` is written in UTF-8.

## Albums

The right panel groups the chosen folder's tracks into albums, by their artist and album tags.
Each album shows its cover, artist, year and genre (those of its first track), and its tracks in
track-number order. On a computer, the cover stays in view while a long album's tracks scroll past. An album whose files sit in folders named like `CD1`, `CD 2`, `Disc1` or
`disc-2` is split into discs.

## Playing

A click on a track, in the library or on the right, starts playback; a click on the track that is
playing pauses it, and another resumes it. In both, the end of the row shows ▶ under the pointer
(always, on a touch screen), and moving bars on the track playing (still while it is paused). On
the right, it plays the albums shown there, from that track. **Enter** does the same on the track
you are on.

At the top right, the transport keys go to the previous track, play or pause, and go to the next
one. The list key (≡) beside them opens the queue; its tooltip says where the queue comes from and
which track of it is playing. The gear key opens the preferences. On a phone these keys sit in a
bar at the bottom: the gear, the transport keys, then the list key.

### The queue

Playing a track queues its folder (or the albums on the right) from that track. The queue can hold
tracks of every open folder. The list key opens it, and closes it again; it stays down while the
queue is open. On a computer the queue is a dialog; on a phone, a panel over the library that
leaves the bottom bar in view and in use, its gear turned into **Clear upcoming** while the queue
is open.

Each track shows its cover (the stripes when it has none), the track playing a larger one, with
its bars; the ones already played are dimmed, and each folder's name follows its tracks' artist
when there is more than one folder.

- A click (or **Enter**) plays a track; on the one playing, it pauses or resumes.
- To move a track, drag it by its grip (⠿, at its left), with the mouse or a finger: a line shows
  where it will land, and the list scrolls near its edges. × takes a track out of the queue (not
  the one playing). With the keyboard: **Up**, **Down**, **Home** and **End** go through the
  tracks, **Alt+Up** and **Alt+Down** move the one you are on, and **Delete** takes it out.
- **Clear upcoming** (in the dialog's foot, or the phone's bottom bar) takes out everything after
  the track playing.
- **Save as playlist…** (in the dialog's foot, or the phone panel's head) saves it as a playlist
  (see [Playlists](#playlists)).

Tracks get into the queue from their menus (below): **Play next** puts them right after the one
playing, **Add to queue** at the end. With nothing queued, they become the queue, the first one
ready but paused: nothing starts by itself.

Closing a folder takes its tracks out of the queue, and so does removing tracks from the library;
if the one playing goes, the next one left plays. The queue comes back after a reload, without the
tracks of folders that did not reopen.

The display shows the state (▶ playing, ❚❚ paused, ■ stopped), the title and artist, the time,
and how far into the track it is.

On a screen wider than 640px, the display also has a spectrum analyser at its left: its columns move
with the music, from 40 Hz to 16 kHz, and fall still when it pauses. On a phone, three columns of it
(lows, mids, highs) take the state's place while the music plays.

A track plays straight from its file, without being loaded into memory first. Saving its tags
while it plays, or another program changing the file, does not stop it: it carries on from the
same second.

## Menus

Every track and every folder has a menu behind its ⋮ key, at the end of its row: in the library
when the pointer is over the row (always on a touch screen, and on the current, selected and
playing rows), and on each track on the right.

- **A track**: **Play next**, **Add to queue**, **Add to playlist…**, **Go to album**, **Go to
  artist**, **Edit tags…**, **Info…**, **Rename…** and
  **Remove from library…** (the selection's dialog on that tab). On the right, also **Show in library**, which
  opens the track in the tree. When the track is selected, the menu acts on the whole selection
  and says how many tracks ("Add 3 tracks to queue"); when it is not, the dialog's items make it
  the selection first.
- **A folder** (or an artist, an album): **Play** (from its first track), **Play next**, **Add to
  queue**, **Add to playlist…** (its tracks, in the order it plays them) and **Open in Details**.
- **A playlist** and its tracks: see [Playlists](#playlists).

With the keyboard, **Tab** to a ⋮ key and press **Enter**: **Up**, **Down**, **Home** and **End**
move through the menu, **Enter** chooses, **Escape** closes it. On a phone the menu opens as a
sheet at the bottom of the screen. Queueing says what it did in the library's message line.

## Selecting tracks

Click the box at the left of a track to select it, and click it again to deselect it. Clicks add
to the selection, and a **Shift**-click selects every track between the first one you ticked and
this one. With the keyboard, **Space** selects or deselects the track you are on, and
**Shift+Space** selects up to it. On the right, the box beside a disc's number of tracks selects
all of them (the whole album, when it has one disc), or deselects them when they all are; it shows
a dash when only some are. Moving through the library, or playing, leaves the selection as
it is, so tracks from several folders can be selected together. **Escape** clears it.

While tracks are selected, the right end of the tab bar shows a key with their number (✎ "3 tracks
selected"; on a phone, the number alone), and a × that clears the selection. The key opens the
selection's dialog, whose tabs are, each marked on top with its colour:

- **Info** (green): each file's relative path, name and size, its full checksum, its audio checksum
  (without the ID3 tag) and when it was last verified; for several tracks, the totals and the list.
- **Edit** (orange): the tags and the cover, below. It is the one the key opens.
- **Delete** (red): removes the tracks from the library with its **Remove** key. The files stay on
  disk, and come back the next time the folder is opened.

Switching tabs keeps what you typed in Edit. **Escape**, the dialog's × or a click outside it close it.
On a phone the dialogs rise from the bottom and take the whole width; drag one down by its top to
close it.

## Editing tags and covers

The Edit tab works on one track or on many. Its fields are **Title**, **Artist**, **Album**,
**Year**, **Genre** and **Track**.

With several tracks selected, a field they disagree on shows *(Multiple values)*, is empty, and has
an **Override** box inside it, at its right. Leave it empty and each track keeps its own value; type into it and the
box ticks itself, with a ⚠ before it: every track gets what you typed. Unticking the box empties the field again.
Ticking it on the empty field clears that tag on every track. The cover works as before: leave it
and each track keeps its own; drop or choose one and every track gets it.

For the cover, drop an image on it or use **Choose image**; **Remove** takes it away.

**Save changes** writes the tags and the cover into the MP3 files themselves. Every other tag the
files carry (album artist, disc number, comments, lyrics, ReplayGain and the like) is kept as it
was.

## Renaming files

The selection's dialog has a **Rename** tab (also **Rename…** in a track's ⋮ menu): it names each
selected file from its tags by a pattern, in the syntax of mp3tag, foobar2000 and MusicBrainz
Picard. The fields are `%title%`, `%artist%`, `%album%`, `%year%`, `%genre%`, `%track%`, `%disc%`
and `%filename%` (the current name); `%track%` is padded with zeros to the album's width ("07" of
12), so names sort as the tracks play. The select beside the pattern holds ready-made ones
(`%track% - %title%`, the first, `%artist% - %title%` and others); the last pattern used is kept for
the next time.

The preview shows each file's name now and after. Characters a file name cannot hold
(`\ / : * ? " < > |`) become `_`. A name another file already has (in the selection or in the
library, whatever its case), or a pattern that leaves a name empty, is marked, and the files are not
renamed until it is fixed; names that would not change are dimmed. Only the name changes: the file
stays in its folder and keeps its extension.

The library, `.meta/`, the selection, the queue and the track playing (which carries on) follow the
new names, so the folder reopens without reading the files again. If a file cannot be renamed (its
new name is taken on disk by a file the library does not list, say), the renaming stops there and
says which file and why; the files renamed before it stay renamed.

## Checking files in the background

A few seconds after a root is ready, jackbird goes through the tracks whose checksums are missing
or more than a day old, one at a time, and records what it finds in `.meta/`. A file changed by
another program has its tags read again.

## Appearance and language

**Preferences** (the gear key) chooses the tone, **Silver** (light) or **Graphite** (dark), and
the interface language, English or Spanish. Until you choose, both follow your system and your
browser.

## What jackbird writes

- In your folders: the tags and covers of the tracks you save, the names of the files you rename,
  the playlists you make, change or delete, and `.meta/mp3-manager.json` in each folder you open.
- In your browser: the open roots, so they can be reopened (IndexedDB), and your theme and
  language (local storage).

Nothing leaves your computer.
