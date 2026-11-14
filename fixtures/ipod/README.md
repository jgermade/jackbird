# iPod fixtures

- `hashab-vectors.json`: the 100 test vectors of [dstaley/hashab](https://github.com/dstaley/hashab)
  (`test-data.json` at commit `f80d464`), released into the public domain under the Unlicense. Each
  entry is a SHA-1, a FireWire GUID (`uuid`) and the 57-byte `hashAB` signature of both, made with
  libgpod's random bytes (`ABCDEFGHIJKLMNOPQRSTUVW`). `crates/ipod/src/hashab` is checked against
  them.

Databases from a real iPod hold a person's library and are not kept here (see
`RECORD/2026-11-14.ipod-sync.WIP.md`).
