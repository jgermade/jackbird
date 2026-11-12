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

jackbird reads every `.mp3` and `.flac` file in the folder and its subfolders. The first time, it reads all of
their tags. It then keeps what it learned in `.meta/mp3-manager.json` inside the folder, so the
next time it shows the library at once and reads only the files that are new or have changed,
in the background.

When you reload the page, the roots you had open come back by themselves, as long as the browser
still grants permission for them: each with its open folders and the folder it showed, and the
panel and scroll positions you were at. The track that was playing comes back at the same second
and plays on. A reload stops the sound for a moment, since a page cannot play through its own
reload; and if the browser does not let the page start sound by itself, the track waits, paused at
its place, and your first click or key anywhere resumes it.

## People and sign-in (the service)

When jackbird is served by its service (installed from the desktop app, or `jackbird-service` on
a machine), it starts open, for one person: you, its **owner**, on that machine only.

**Several people.** In **Preferences**, **People and sign-in…** adds people with a name and a
role. While sign-in is off they are profiles: opening jackbird asks *Who's listening?*, and
picking a name is enough. Roles decide what jackbird offers: a **listener** plays; an **editor**
also edits tags and covers, renames files and keeps playlists; an **admin** also adds editors and
listeners, sets up email and reads the log of changes; an **owner** also opens folders and decides
how jackbird is reached. With sign-in off, anyone at the machine can pick any profile.

**Sign-in.** Set up email first (**People and sign-in…**, **Sign-in**: your SMTP server, then
**Send a test**). An owner then gives their own address and types back the code sent there:
sign-in is on. Nobody's role changes; the others are disabled until an owner or an admin gives
them an address, where an invitation is sent, and they sign in with the code sent there. Only
people added this way can sign in. Once in, **Preferences**, **Account** adds a **passkey** to sign
in without a code (on the instance's own address, over HTTPS or on `localhost`), and shows where
you are signed in. Without a screen, `jackbird-service setup` on the machine does the same from
the console, and is the way back in for an owner whose address changed. Only an owner turns
sign-in off again; people keep their addresses and become profiles.

**The family library.** The service keeps a library of its own, shown to everyone as the
**Library** tab. **Add music** puts songs in it: editors and up upload songs or a whole folder
from their own device, and owners can also import a folder of the machine the service runs on.
Each song is kept once, however many times it is brought, and the files you pick are never
changed. Editing a song's tags changes what everyone sees, not the stored file: the song leaves
with the family's tags when it is played or downloaded (**Info**, **Download**). When someone
brings a song the library already has, with other tags, those are kept beside it and shown in its
**Info**. The library lives in your data folder (`~/.local/share/jackbird/library` on Linux,
`~/Library/Application Support/jackbird/library` on macOS, `%LOCALAPPDATA%\jackbird\library` on
Windows), or wherever `service.json`'s `library` says: back that folder up and the whole library
is in it.

**Your own, in the library.** Each person has their own there: **Add to favourites** in a
song's menu; what you play (a song counts once half of it, or four minutes, has played); your own
playlists. They are the library's **My playlists** folder, yours alone, with **Favourites** and
**Recently played** made from what you did. Editing a song's tags in the library, an editor
chooses **For everyone** or **Only for me**; anyone else saves for themselves only. What you set
for yourself is what you see, play and download; the song's **Info** says which fields are yours,
with **Back to the family's version**. In **Preferences**, **Account**, **Your version** switches
between yours and the family's, and **Clear what I played** empties your history. A song you bring
that the library already has, with other tags, shows you your tags, and editors see them as a
suggestion they can **Apply for everyone**. Your theme and language follow you to every device.

**Keeping the library safe.** When two people edit the same song, the second save is refused
and the song's tags as they are now are shown, to apply yours again: nothing is saved over
someone else's change without anyone knowing (shared playlists work the same way). Deleting
songs from the library moves them to the **Trash** (**People and sign-in…**), where admins and
owners restore them; after 30 days they go for good. Every night after 03:00 (UTC) the service
keeps a copy of its databases in the library's `backups/` folder (7 daily, 4 weekly, 12 monthly),
and once a week it checks every song's file against its name, so a failing disk shows up in
**Backups** and the log. Owners can take a copy or run the check from **Backups**, and **Export**
the whole library to a folder as `Artist/Album/NN - Title`, with the family's tags.

**A copy away from home, with [restic](https://restic.net).** Everything the library is lives in
its folder (Backups shows where). Copy it, encrypted, to a USB disk or a storage service:

```sh
export RESTIC_REPOSITORY=/media/usb/jackbird-restic   # or b2:bucket:jackbird, sftp:…
export RESTIC_PASSWORD_FILE=~/.config/jackbird/restic-password
restic init                                           # once
restic backup ~/.local/share/jackbird/library         # every day, from cron or a timer
restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --prune
```

To bring it back: stop the service (`jackbird-service stop`), `restic restore latest --target /`,
and start it again. If the catalogue itself is what went wrong, put the newest
`backups/<date>/catalogue.db` in place of `catalogue.db` (and `jackbird.db` beside the
configuration) while the service is stopped.

**Reaching it from elsewhere.** With sign-in on, an owner can let the home network reach it
(**Sign-in**, **Home network**); over plain HTTP, codes and sessions travel unencrypted there and
passkeys are not available. For HTTPS, and to reach it from outside home, put a proxy in front
and set **The instance's address** to the address it serves (passkeys belong to that address).
With Caddy:

```caddy
music.example.com {
  reverse_proxy 127.0.0.1:4646
}
```

With nginx (and a certificate of your own):

```nginx
server {
  listen 443 ssl;
  server_name music.example.com;
  # ssl_certificate …; ssl_certificate_key …;
  location / {
    proxy_pass http://127.0.0.1:4646;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

jackbird believes the proxy's `X-Forwarded-*` headers only from the machine itself; a proxy on
another machine is listed in `service.json`'s `proxies`. While sign-in is off, a request through a
proxy is refused.

## The library

The left panel lists the active root's folders and tracks. A click on a folder's glyph opens or
closes it (an open folder draws an open folder). Choosing a folder shows
what it holds on the right, and choosing a track shows its folder. Until you choose one, the right panel shows the whole root.

A click on a track plays it (its folder, from that track): on a computer, a ▶ at the end of the
row shows when the pointer is over it, and the track playing shows moving bars there. Each folder
has a ❯ key at its end (on a computer, it shows when the pointer is over the row) that shows the
folder on the right; on a phone, it also takes you to the **Details** panel. The box at the left
of each track selects it (see [Selecting tracks](#selecting-tracks)); on a computer the box shows
when the pointer is over the row (a track's number sits there otherwise), and stays on the
tracks selected.

With the keyboard, the arrows move through the tree and open and close folders, **Enter** plays
the row you are on (on a folder, from its first track), and **Space** selects or deselects the
track you are on.

On a phone, the two panels take turns: swipe between them, or use the **Library** and **Details**
keys at the top right. The library there lists one level at a time, with no nesting: tap a folder
(or an artist, an album) and the list is what it holds, with the folders you came through stacked
above it, the first at the top; tap one of those to go back out of it. A folder's ❯ shows it in
**Details**.

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

**Save changes** writes the tags and the cover into the files themselves (ID3v2 tags in MP3,
Vorbis comments and a picture block in FLAC). Every other tag the files carry (album artist, disc
number, comments, lyrics, ReplayGain and the like) is kept as it was, and so is the audio, byte
for byte. A save that would not keep them is refused, and says why. A FLAC file's year can be any
text; an MP3's must be a date its tag can hold (a year, a year and month in v2.4, or a full date).
The **Info** tab says each track's format.

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
