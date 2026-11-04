# Cloud sources (Google Drive, Box) and the relay

What is planned after the family instance ([family-instance.md](family-instance.md)), which itself
follows the Rust tag engine and Tauri plan ([rust-tag-engine-and-tauri.md](rust-tag-engine-and-tauri.md)).
The reasoning is in
[RECORD/2026-08-11.musikmatch-rust-migration.WIP.md](../../RECORD/2026-08-11.musikmatch-rust-migration.WIP.md)
(extensions of 2026-11-04, 20:59 to 21:32): Google Drive and Box as sources over vfs-sync's
`VFSAdapter`, in the web and the app, with or without the family instance. The public account first
proposed here (C3, C3b) is gone: the instance's accounts are F2's.

Dates are estimates, from the day F5 is planned to end; each step ends with its "done when" met and a
walkthrough in the record. C0 is a spike that decides how C1 and C2 go.

```mermaid
gantt
  title Cloud sources and the relay
  dateFormat YYYY-MM-DD
  axisFormat %d %b
  section Decide
    C0 Spike: Box OAuth, Drive scopes, the proxy   :c0, 2027-01-04, 3d
  section Sources
    C1 Google Drive (read first)                   :c1, after c0, 10d
    C2 Box (a BoxAdapter for vfs-sync)             :c2, after c1, 7d
  section Sync
    C4 The relay peer for the mesh                 :c4, after c2, 10d
```

| Step | Scope | Done when |
| --- | --- | --- |
| C0 Spike | Box's OAuth for a public client (PKCE without a secret?); Drive's `drive.file` with a folder from the Picker against the restricted scopes and Google's verification; a Service Worker range proxy playing a Drive file | the answers are in the record |
| C1 Drive | the `GDriveAdapter` as a source in the web and the app; playback through a Service Worker (web) or Rust (app) proxy; with the family instance, its refresh tokens kept server-side and server-to-server imports into its store; read-only in the clients until `.meta` v2 (D9) allows writes | a Drive library opens, plays and shows its tags, and imports into the instance |
| C2 Box | a `BoxAdapter` contributed to vfs-sync; without the instance if C0 allows it | as C1, with Box |
| C4 Relay | a relay peer for the vfs-sync mesh, independent of the instance's shared library (record, 21:20): store and forward, or metadata only | two devices, never on together, converge |

Decided separately: `.meta` v2 (D9, for writes from the clients), the vfs-sync mesh (M3, for C4).
