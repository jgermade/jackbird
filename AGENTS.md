## Architecture

Check [STACK.md](STACK.md)

Check [THESAURUS.md](THESAURUS.md)

### Layers

The UI is built with [jq79](https://github.com/jgermade/jq79) components, and nothing else: no
other UI framework, and no app-wide stylesheet (each view and component styles itself over the
Deck theme's tokens). Code lives in four layers, and an import that crosses them the wrong way fails
`npm test` (`scripts/check-layers.mjs`; `import type` is exempt, since it is erased, and so are
assets such as styles, fonts and images):

| Folder | What | May import |
| --- | --- | --- |
| `src/helpers/` | Pure TypeScript functions, ideally with no package dependencies. Every helper has a `.test.ts` beside it; coverage stays at 90% or more of lines, branches and functions. | `src/helpers/` |
| `src/lib/` | Factories, services and stores (`$reactive`). | `src/helpers/`, `src/lib/`, packages |
| `src/components/`, `theme/default/components/` | jq79 components that depend on no store: only on themselves and on helpers. | `src/helpers/`, components |
| `src/views/` | jq79 components that bring data (`src/lib/`) and components together. | all of the above |

`npm test` runs the layer check, a type check of the helpers and their tests, the unit tests
(Node's own runner, no framework), and a coverage check that holds **every** helper file to the
90% floor and fails on a helper no test loads. Run it before every commit.

`src/types.ts` holds types only and may be imported from anywhere.

### Rust crates

`crates/` holds jackbird's own Rust crates, one Cargo workspace whose `Cargo.toml` is at the root,
with the desktop app (`src-tauri/`, Tauri v2) in it. The tag crates (`id3`, `flac`, `tags`,
`tags-wasm`) do no I/O: they are
given the ranges of a file they ask for (its head and its last bytes) and return what to write (a
splice: the tags to put in place of the old ones); the audio never passes through them. `crates/core` is the one crate that touches the file system,
by design: open folders (roots) and the paths under them (none leads out, links included), and
tags, checksums and saves on files, streamed, never holding the audio in memory; the desktop app
wraps it in commands, and the service (`crates/service`) in HTTP, both speaking `crates/api`'s
JSON. `crates/store` (F1) is the other crate that touches it: the family library, its blobs and
its catalogue (SQLite) in a folder of its own, on `crates/core`. `crates/audio` (E5) reads files too, to play them: the desktop app's native output (`symphonia` decoding, `cpal` and each system's exclusive path behind its `device` feature, which needs ALSA's headers on Linux); without that feature it builds with no system library, and its tests play to a capture output. The tag crates depend on nothing but
each other (`crates/core` adds `sha1` and `sha2`); a dependency in `[dev-dependencies]` is for
tests only. `crates/tags-wasm` is the web app's WebAssembly module, built by
`scripts/build-wasm.mjs` (not committed); its exports' `#[unsafe(no_mangle)]` is unsafe code the
workspace allows, and it has no unsafe block. The only other is one block in `src-tauri`
(`phone::take`, Android only, approved by the owner on 2026-11-12): it takes a file descriptor
Android's document provider opened for a folder the person chose (E6b-D9), handed to Rust by the
app's plugin and never by the page. Both crates set `unsafe_code` to "deny" instead of the
workspace's "forbid", and allow it only where it is. They are written from the formats' specifications; other libraries are references for
behaviour and edge cases, and no code is copied from GPL or LGPL ones. Tests run on the shared
fixtures in `fixtures/tags/` (made by `fixtures/tags/make.mjs`, whose expectations come from how
each file is built). Run `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --
-D warnings` and `cargo test --workspace` (or `make test-crates`, and `make desktop-test` for the
desktop app, which needs WebKitGTK on Linux) before committing a change to them.

jq79 pitfalls found here (details in `RECORD/2026-11-03.deck-design-system.WIP.md`):

- A prop can't be called `value`, `checked`, `selected`, `text`, `html` or `class`: those are
  jq79 directives and are ignored on a component tag.
- A `$computed` must not read another `$computed`'s object value: it wakes itself again and jq79
  gives up after 100 rounds. Derive from the source store, as `derive()` in
  `src/lib/workspace.ts` does.
- A derived value that holds nested objects is handed out boxed (`Opaque`) and read through
  functions in views, never copied into a component's store with `$:`.
- Several components fetched at runtime go through one `Component79.fetchAll([...])`, never
  consecutive `Component79.fetch()` calls: they leave in the same moment and share the HTTP/2
  connection. (A setup script's `await import("….html")` fetches nothing: jq79/vite hoists it into
  the bundle.)

### Sizes

Hover states live only inside `@media (hover: hover)`: a touch screen has none, so whatever a
hover reveals (a row's keys, its ▶) is always shown under `(hover: none)`. `npm test` fails on a
`:hover` rule outside that media query.

Sizes are in `rem`, never in `px`, so the interface scales with the root font size: 18px on a
desktop or a tablet and `4.5vw` on a phone (`theme/default/tokens.css`), which scales every component
linearly with the screen. Only hairlines (1–2px borders, focus rings) stay in `px`. Setup scripts are written in
TypeScript (`lang="ts"`); since templates are not type-checked, keep them thin and put the logic
in helpers and `lib/`.

## Language

**All repository content is written in English**: code, identifiers, comments, UI strings,
documentation, records, roadmaps and commit messages. This applies whatever language the
conversation with the user is held in.

The one exception is UI translations. The interface is available in English and Spanish, with
English as the source and the fallback: every string is written in English first, and its
Spanish translation lives only in the Spanish translation file.

So no UI text is written inline. Each one is a key in `src/lib/locales/en.ts`, with its Spanish in
`src/lib/locales/es.ts`, and is read with `t("key", { param })`. A counted text has `.one` and
`.other` forms and is read with `t.n("key", count)`. The compiler rejects a Spanish catalogue
missing a key, and `npm test` rejects one whose `{placeholders}` differ from the English. A view
gets `t` from `src/lib/i18n.ts`; a component, which may not import `lib/`, receives it as a prop.
The app's name is the `app.name` key.

## Project Management

### Records

Specifications, plans, walkthroughs and the audit trail live in [RECORD/](./RECORD/). Convention:

- Name format: `YYYY-MM-DD.<summary>.<status>.md`
  - `YYYY-MM-DD`: the date the record was created.
  - `<summary>`: a kebab-case slug of the topic.
  - `<status>`: `WIP` or `completed`.
  - Example: `RECORD/2026-08-11.file-explorer-ui-refresh.WIP.md`
- `.WIP.md` records are **append-only**: new content is added at the end, and existing content
  is never deleted or modified. Each extension starts with the date and time of the extension
  and a summary of the new content added.
- `.completed.md` records are **read-only**: never edit, extend, rename or delete them.
  Follow-up work on a completed topic goes into a new `.WIP.md` record, which may link to the
  completed one.
- A record is completed only when the user explicitly orders it: append the final walkthrough
  to the `.WIP.md` record, then rename it to `.completed.md` (`git mv`) without any other change.
- For a new topic with no relation to previous ones: create a new record.

### Roadmap

The roadmap lives in [ROADMAP/](./ROADMAP/), in folders named after the date the roadmap was
drafted: `ROADMAP/YYYY-MM-DD/`. Convention:

- Each dated folder holds one or more Markdown files with kebab-case names
  (e.g. `ROADMAP/2026-11-03/storage-layer.md`).
- Each file lays out its schedule as a Gantt chart in a Mermaid code block:

  ````markdown
  ```mermaid
  gantt
    title Storage layer
    dateFormat YYYY-MM-DD
    section Milestone 1
      Task A :a1, 2026-11-03, 7d
      Task B :a2, after a1, 5d
    section Milestone 2
      Task C :b1, after a2, 14d
  ```
  ````

## Critical Rules

### Record-first workflow
**Never make changes without first documenting them in a record.** This is non-negotiable. Before implementing any feature, refactoring code, or adding dependencies:

1. Create or extend the appropriate `.WIP.md` record in `RECORD/`
2. Document the planned changes in detail
3. Wait for user approval before proceeding
4. When the current record is completed, and only when the user explicitly orders it, append the final walkthrough and rename the record to `.completed.md`.

## Tasks

- When adding a task to do, **extend** the current `.WIP.md` record with the implementation plan.
- When a task is done, append to the current `.WIP.md` record a walkthrough of what's done, and suggest a 1-line commit message.

## Ending records

When the user says **"capitular"**:

1. Complete the current record (append the walkthrough, rename it to `.completed.md`) and update `README.md` with the project specifications (in the `# Project Specs` section) and a todo list (in the `# Todos` section, if it exists).
2. Ask the user to start a new record.
3. Unless the user explicitly asks to capitulate, never create a new record. Instead, append the proposal to the current `.WIP.md` record and ask the user to review and approve it.

For temp files and folders, use `.tmp/` into project root.
Temporary scripts should be created in `.tmp/scripts/`.
