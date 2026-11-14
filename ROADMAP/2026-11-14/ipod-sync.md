# iPod sync: the iPod nano and the iPod classic

Sending music from jackbird to an iPod that mounts as a disk, on the owner's own devices, starting
with the nano 7G at the owner's ask (2026-11-14), then the nano 6G, the iPod video 5G, the classic
7G and the nano 5G. The nano 1G–4G share the classic's format and work in the code, but no device
here tests them. Asked by the owner on 2026-11-04, started as a spike on
2026-11-14 with the owner's focus on the nano and the classic. The reasoning, the models and the
catches are in [RECORD/2026-11-14.ipod-sync.WIP.md](../../RECORD/2026-11-14.ipod-sync.WIP.md).

Each step ends with its "done when" met and a walkthrough in the record. The dates are estimates,
and the steps from N1 on need the owner's nano at hand.

```mermaid
gantt
  title iPod sync, the nano 7G first
  dateFormat YYYY-MM-DD
  axisFormat %d %b
  section nano 7G
    N0 The nano 7G                     :n0, 2026-11-16, 1d
    N1 Read it (iTunesCDB, GUID)       :n1, after n0, 3d
    N2 hashAB, checked on the nano     :n2, after n1, 3d
    N3 Write the databases             :n3, after n2, 5d
    N4 Copy tracks, write              :n4, after n3, 3d
    N5 On the nano 7G                  :n5, after n4, 1d
  section Then
    nano 6G                            :b1, after n5, 2d
    iPod video 5G                      :b2, after b1, 2d
    classic 7G (hash58)                :b3, after b2, 3d
    nano 5G (hash72)                   :b4, after b3, 5d
```

| Step | Scope | Done when |
| --- | --- | --- |
| N0 The nano 7G | Capacity, format (HFS+ or FAT32), synced with iTunes or not, can it be restored. | it is in the record |
| N1 Read it | `crates/ipod` reads `SysInfo` and the `iTunesCDB` (zlib); the desktop app reads `SysInfoExtended` (`sg_inq`, or its copy on the device) and the GUID; web and desktop list the nano's tracks. | the tracks and playlists are listed as the nano shows them, and the GUID is known |
| N2 `hashAB` | Ported from dstaley/hashab (public domain), its 100 vectors; checked on the nano's own `iTunesCDB` and `Locations.itdb.cbk`. | the signature iTunes wrote validates |
| N3 Write the databases | The `iTunesCDB` writer and its signature, the SQLite library with the nano's post-process SQL, `Locations.itdb.cbk`. | for an unchanged library, the files match iTunes' in all but the random bytes |
| N4 Copy and write | MP3s under `iPod_Control/Music/Fnn/`, both databases, a playlist, backups and the order of replacing; the iPod panel in the desktop app. | a copy of the nano's files with one track added keeps its tracks, playlists and play counts |
| N5 On the nano 7G | The owner's test on the device. | the tracks play, and iTunes still opens the nano without a restore |
| Then | The nano 6G (same `hashAB` and SQLite), the iPod video 5G (no checksum), the classic 7G (`hash58`), the nano 5G (`hash72`). | each plays on the owner's device |

Writing to a nano 6G or 7G is the desktop app's: it needs `SysInfoExtended` (a SCSI query a
browser cannot make) and SQLite. The web reads them.

Not in it: artwork, play counts shown in jackbird, podcasts, AAC and ALAC, FLAC conversion,
deleting from the iPod, the shuffle, the iPod touch and the iPhone.
