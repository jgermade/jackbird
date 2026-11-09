# The family instance

A jackbird server of the owner's own, for three or four people sharing one catalogue, reached from
outside home by whatever route the owner picks (a private network, a reverse proxy, a tunnel). What is planned, in order, after E4 of
[rust-tag-engine-and-tauri.md](rust-tag-engine-and-tauri.md); the cloud sources follow it
([cloud-sources-and-accounts.md](cloud-sources-and-accounts.md)). The reasoning is in
[RECORD/2026-08-11.musikmatch-rust-migration.WIP.md](../../RECORD/2026-08-11.musikmatch-rust-migration.WIP.md)
(extensions of 2026-11-04, 21:22 to 21:40, and 21:35 for the instance's modes).

Since 2026-11-08 the service ([../2026-11-08/service.md](../2026-11-08/service.md)) comes first:
it is this instance's backend, over local folders, installed from the desktop app (S1, S2), with
sign-in and people (S3, which takes over F2's sign-in, passkeys and roles) and the online route
(S4). F1's store, F3, F4 and F5 follow it.

Dates are estimates, from the day E4 is planned to end; each step ends with its "done when" met and
a walkthrough in the record. F0 is a spike that decides the rest.

```mermaid
gantt
  title The family instance
  dateFormat YYYY-MM-DD
  axisFormat %d %b
  section Decide
    F0 Spike: passkeys, routes, the store          :f0, 2026-11-25, 4d
  section Server
    F1 The server and its store                    :f1, after f0, 10d
    F2 Modes, people, roles, passkeys              :f2, after f1, 8d
    F3 Each person's own data and metadata         :f3, after f2, 5d
    F4 Concurrent edits, backups                   :f4, after f3, 5d
  section Ship
    F5 Packaging: Docker image, binaries           :f5, after f4, 4d
```

| Step | Scope | Done when |
| --- | --- | --- |
| F0 Spike (**folded**, 2026-11-09: passkeys and routes answered by S3 and intergate; the store's layout is F1's first step) | Passkeys on the instance's own address (a setting; its domain is the RP ID), with the app signing in through the system browser and a one-time console code for the first owner and recovery; the instance reached by more than one route (the home network, a private network, a tunnel such as intergate), with byte-range streaming and long responses through each; WebAuthn's related origins for a second address; the store's layout (blobs by SHA-256 of the audio region) on a sample library | the answers are in the record |
| F1 Server (plan in the record, 2026-11-09 13:46, awaiting approval; in `jackbird-service`, with `crates/store`) | `crates/server` (axum, SQLite, `crates/tags` native): import from a folder into the content-addressed store (audio and covers, deduplicated), the metadata layers (file, family), the HTTP API mirroring `VFSAdapter` with server-side tag operations and ranged reads, tags written on the fly for downloads and exports; it serves the web build; the app and the web use it as a source through one `HttpAdapter` | a family library imports, plays in the web and the app, and a tag edit by one person shows for another |
| F2 People | the instance's mode, open or with sign-in, for one person or several (record, 21:35), with open instances kept to the machine and private networks unless forced; owners, admins, editors and listeners (record, 21:32); profiles in open mode; invitations by one-time link; passkeys on the instance's own address (record, 21:40); sessions; the log of changes to the shared catalogue; moving an open instance to sign-in without losing anyone's data | the four combinations run; with sign-in, four people with the four roles can each do what the role allows and nothing more |
| F3 Their own | favourites, playlists, history and settings per person; their own metadata layer, with the switch between the family's version and theirs; an import with other tags becoming the importer's layer and a suggestion for editors | two people see the same song with different titles, and the family's version is untouched |
| F4 Safety | each write carries the version it read, and a stale one is refused and shown; nightly SQLite snapshots with rotation; the trash (30 days) before blobs go; the weekly scrub; restic to a second place, documented; the plain-folder export | an edit made against an old version is refused, and a restore from the off-site copy brings back the library |
| F5 Ship | a Docker image and binaries for Linux (x64, arm64, for a NAS or a Raspberry Pi) and macOS, built in GitHub Actions; a compose file with the server and restic; the routes from outside home documented, none bundled | an instance installs from the docs on a clean machine and is reached at its address |

Decided separately: the OpenSubsonic API (the owner looks into it; F1's API leaves room for it), the
relay for the vfs-sync mesh (C4).
