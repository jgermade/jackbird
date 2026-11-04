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
phone the tabs are a dropdown: pick a root in it, close the chosen one with the × beside it, and add
one with **+**.

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
its folder glyph opens or closes it (an open folder draws an open folder). **Expand all** and
**Collapse all** open and close every folder. Choosing a folder shows what it holds on the right, and choosing a
track shows its folder. Until you choose one, the right panel shows the whole root.

A click on a track plays it (its folder, from that track): on a computer, a ▶ at the end of the
row shows when the pointer is over it, and the track playing shows moving bars there. Each folder
has a ❯ key at its end (on a computer, it shows when the pointer is over the row) that shows the
folder on the right; on a phone, it also takes you to the **Details** panel. The box at the left
of each track selects it (see [Selecting tracks](#selecting-tracks)).

With the keyboard, the arrows move through the tree and open and close folders, **Enter** plays
the row you are on (on a folder, from its first track), and **Space** selects or deselects the
track you are on.

On a phone, the two panels take turns: the **Library** and **Details** keys at the bottom switch
between them.

## Albums

The right panel groups the chosen folder's tracks into albums, by their artist and album tags.
Each album shows its cover, artist, year and genre (those of its first track), and its tracks in
track-number order. On a computer, the cover stays in view while a long album's tracks scroll past. An album whose files sit in folders named like `CD1`, `CD 2`, `Disc1` or
`disc-2` is split into discs.

## Playing

A click on a track, in the library or on the right, starts playback; a click on the track that is
playing pauses it, and another resumes it. In both, the end of the row shows ▶ under the pointer,
and moving bars on the track playing (still while it is paused). On the right, it plays the albums shown there, from
that track. **Enter** does the same on the track you are on.

At the top right, the transport keys go to the previous track, play or pause, and go to the next
one. The list key (≡) beside them takes you back to the track that is playing, wherever you are
in the library: its folders open in the tree and the right panel shows its folder; its tooltip
says which list and which track. The gear key opens the preferences.

The display shows the state (▶ playing, ❚❚ paused, ■ stopped), the title and artist, the time,
and how far into the track it is.

On a screen wider than 900px, the display also has a spectrum analyser at its left: its columns move
with the music, and fall still when it pauses.

## Selecting tracks

Click the box at the left of a track to select it, and click it again to deselect it. Clicks add
to the selection, and a **Shift**-click selects every track between the first one you ticked and
this one. With the keyboard, **Space** selects or deselects the track you are on, and
**Shift+Space** selects up to it. Moving through the library, or playing, leaves the selection as
it is, so tracks from several folders can be selected together. **Escape** clears it.

While tracks are selected, the right end of the tab bar shows a key with their number (✎ "3 tracks
selected"; on a phone, the number alone), and a × that clears the selection. The key opens the
selection's dialog, whose tabs are:

- **Edit**: the tags and the cover, below. It is the one the key opens.
- **Info**: each file's relative path, name and size, its full checksum, its audio checksum
  (without the ID3 tag) and when it was last verified; for several tracks, the totals and the list.
- **Danger**: removes the tracks from the library with its **Remove** key. The files stay on disk,
  and come back the next time the folder is opened.

Switching tabs keeps what you typed in Edit. **Escape**, the dialog's × or a click outside it close it.

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

## Checking files in the background

A few seconds after a root is ready, jackbird goes through the tracks whose checksums are missing
or more than a day old, one at a time, and records what it finds in `.meta/`. A file changed by
another program has its tags read again.

## Appearance and language

**Preferences** (the gear key) chooses the tone, **Silver** (light) or **Graphite** (dark), and
the interface language, English or Spanish. Until you choose, both follow your system and your
browser.

## What jackbird writes

- In your folders: the tags and covers of the tracks you save, and `.meta/mp3-manager.json` in
  each folder you open.
- In your browser: the open roots, so they can be reopened (IndexedDB), and your theme and
  language (local storage).

Nothing leaves your computer.
