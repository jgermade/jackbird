# iPod sync: the iPod nano and the iPod classic

Sending music from jackbird to an iPod that mounts as a disk, on the owner's own devices: the iPod
video 5G and the classic 7G, then the nano 5G. The nano 6G and 7G get a research step only. (The
nano 1G–4G share the classic's format and work in the code, but no device here tests them.) Asked by the owner on 2026-11-04, started as a spike on
2026-11-14 with the owner's focus on the nano and the classic. The reasoning, the models and the
catches are in [RECORD/2026-11-14.ipod-sync.WIP.md](../../RECORD/2026-11-14.ipod-sync.WIP.md).

Each step ends with its "done when" met and a walkthrough in the record. The dates are estimates,
and the steps from I1 on need the owner's iPod at hand.

```mermaid
gantt
  title iPod sync
  dateFormat YYYY-MM-DD
  axisFormat %d %b
  section Spike
    I0 The devices                    :i0, 2026-11-16, 1d
    I1 Read an iTunesDB               :i1, after i0, 3d
    I2 The device, model and GUID     :i2, after i1, 3d
    I3 Write, and hash58              :i3, after i2, 4d
    I4 Copy tracks, write the database :i4, after i3, 3d
    I5 On the iPod (5G, classic 7G)   :i5, after i4, 2d
    I6 nano 5G (hash72)               :i6, after i5, 5d
  section Research
    I7 nano 6G and 7G (hashAB, SQLite) :i7, after i6, 3d
```

| Step | Scope | Done when |
| --- | --- | --- |
| I0 The devices | The owner's iPods (video 5G, classic 7G, nano 5G, 6G and 7G, touch 6G): capacity, format (HFS+ or FAT32), synced with iTunes or not, and which to test on. | the list is in the record (models listed; the rest pending) |
| I1 Read | `crates/ipod` parses an `iTunesDB`; web and desktop list what is on an iPod opened as a root. | the owner's iPod's tracks and playlists are listed as the iPod shows them |
| I2 The device | `SysInfo` and `SysInfoExtended`, the model and its checksum, the GUID (desktop: USB serial; web: `SysInfo`, WebUSB or typed), detecting HFS+. | the GUID and model are found from the desktop, and from the web by at least one path |
| I3 Write and `hash58` | The writer with a byte-exact round trip, and `hash58`. | `hash58` over the owner's iTunes-written database equals the one iTunes stored |
| I4 Copy and write | MP3s under `iPod_Control/Music/Fnn/`, added to the database and a playlist, with a backup and an atomic rename; the iPod panel in the UI. | the new database is written and read back by `crates/ipod` |
| I5 On the iPod | Tested on the iPod video 5G (no checksum), then on the classic 7G (`hash58`). | the tracks and the playlist play on both, and iTunes still opens them |
| I6 nano 5G | `hash72` from a database iTunes wrote, `iTunesCDB`, and the SQLite databases if its firmware needs them. | a track sent by jackbird plays on the owner's nano 5G |
| I7 Research: nano 6G and 7G | Whether `hashAB` can be done cleanly, and what the SQLite databases need. A report, no code. | the report is in the record and the owner has decided |

Not in it: artwork, play counts, podcasts, AAC and ALAC, FLAC conversion, deleting from the iPod,
the shuffle, the nano 6G and 7G beyond I7's research, the iPod touch and the iPhone.
