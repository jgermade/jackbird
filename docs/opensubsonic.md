# Apps that speak OpenSubsonic

jackbird's service answers the [OpenSubsonic API](https://opensubsonic.netlify.app/) for the family
library. Apps that speak it can then browse the library, play it, star songs and count plays, each
person with their own favourites and history. Among those apps are Symfonium and Tempus on
Android, Amperfy on iOS, and Feishin and Supersonic on a computer.

This is part of E6's spike (`RECORD/2026-08-11.musikmatch-rust-migration.WIP.md`). Editing tags,
renaming and importing stay in jackbird's own interface.

## Signing an app in

jackbird has no passwords, so an app signs in with a **key**:

1. In jackbird, open **Preferences → My account → Keys for other apps**, name the key after the
   app, and make it. The key is shown once: copy it.
2. In the app, add a server:
   - **Address**: the instance's, as you reach it from outside (`https://music.example.org`).
   - **User**: your name in jackbird, or your email.
   - **Password**: the key.

   An app that asks for an **API key** instead takes the key alone.
3. To shut an app out, remove its key in the same place.

Apps that offer a "legacy" or "plain password" sign-in work with the key as the password. Apps
that only send salted tokens (`t` and `s`) cannot sign in: a token needs the password itself, and
jackbird never has one. Those get error 41 with a link to this page.

## What is answered

- **Every request**: `ping`, `getLicense`, `getOpenSubsonicExtensions`, `getUser` and
  `getMusicFolders` (one folder: the library).
- **Browsing**:
  - `getArtists`, `getIndexes`, `getArtist`, `getAlbum`, `getSong`
  - `getAlbumList2` and `getAlbumList` (`newest`, `alphabeticalByName`, `alphabeticalByArtist`,
    `starred`)
  - `getRandomSongs`, `getGenres`
  - `search3` and `search2` (an empty query lists everything)
- **Playing**:
  - `stream` and `download` send the song as it leaves the library, with the family's tags. Ranges
    work; nothing is transcoded.
  - `getCoverArt` sends the cover of a song, an album or an artist.
- **One's own**:
  - `star` and `unstar` take songs, and albums (as their songs); `getStarred2` and `getStarred`
    list the starred songs.
  - `scrobble` counts a play.
- **Playlists**: `getPlaylists` answers an empty list for now.

Answers are XML, or JSON with `f=json`. Forms posted with `formPost` work as queries do.

The service must be reachable from the phone, so sign-in must be on. With sign-in off it answers
only on its own machine.
