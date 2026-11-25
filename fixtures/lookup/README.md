# Lookup fixtures

Responses saved as the services gave them on 2026-11-25, for `src/helpers/lookup.test.ts`
(RECORD/2026-11-03.deck-design-system.WIP.md, 2026-11-25, "the album lookup", L1):

| File | Request |
| --- | --- |
| `mb-search.json` | `https://musicbrainz.org/ws/2/release/?query=release:"OK Computer" AND artist:Radiohead&fmt=json&limit=5` |
| `mb-release.json` | `https://musicbrainz.org/ws/2/release/6a09041b-0f79-3278-88d9-0552dd28d37f?inc=recordings+artist-credits+release-groups+genres&fmt=json` |
| `dc-search.json` | `https://api.discogs.com/database/search?type=release&release_title=OK Computer&artist=Radiohead&per_page=5` |
| `dc-release.json` | `https://api.discogs.com/releases/1475007` |

MusicBrainz's core data and Discogs' release data are CC0. Pretty-printed, otherwise as they came.
