# Cloud sources (Google Drive, Box) and an optional account

What is proposed after the Rust tag engine and Tauri plan
([rust-tag-engine-and-tauri.md](rust-tag-engine-and-tauri.md)), awaiting approval. The reasoning is
in [RECORD/2026-08-11.musikmatch-rust-migration.WIP.md](../../RECORD/2026-08-11.musikmatch-rust-migration.WIP.md)
(extension of 2026-11-04 20:59): the web and the app, each with or without an optional account
(email and passkeys), with Google Drive and Box as sources over vfs-sync's `VFSAdapter`.

Dates are estimates, starting after E4; each step ends with its "done when" met and a walkthrough in
the record. C0 is a spike that decides how C1–C3 go.

```mermaid
gantt
  title Cloud sources and an optional account
  dateFormat YYYY-MM-DD
  axisFormat %d %b
  section Decide
    C0 Spike: Box OAuth, Drive scopes, proxy, passkeys :c0, 2026-11-30, 4d
  section Sources, no backend
    C1 Google Drive (read first)                       :c1, after c0, 10d
    C2 Box (BoxAdapter for vfs-sync)                   :c2, after c1, 7d
  section Account (opt-in)
    C3 Backend: email + passkeys, tokens, settings     :c3, after c1, 15d
    C4 Relay peer for the sync mesh                    :c4, after c3, 10d
```

| Step | Scope | Done when |
| --- | --- | --- |
| C0 Spike | Box's OAuth for a public client (PKCE without a secret?); Drive's `drive.file` with a folder from the Picker; a Service Worker range proxy playing a Drive file; passkeys in the three webviews and sign-in through the system browser | the answers are in the record |
| C1 Drive | the `GDriveAdapter` as a source in the web and the app; playback through a Service Worker (web) or Rust (app) proxy; read-only until `.meta` v2 (D9) allows writes | a Drive library opens, plays and shows its tags |
| C2 Box | a `BoxAdapter` contributed to vfs-sync; without a backend if C0 allows it | as C1, with Box |
| C3 Account | email and passkeys, encrypted refresh tokens, settings across devices, the privacy notice and the processors' agreements | sign-in on web and app; a Drive connection survives a new device |
| C4 Relay | the account's relay peer for the vfs-sync mesh (M3) | two devices, never on together, converge |

Depends on, and decided separately: `.meta` v2 (D9, for cloud writes), the vfs-sync mesh (M3, for C4).
