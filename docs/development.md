# Development

## Requirements

- Node.js 22.6 or later: the unit tests run TypeScript directly with `--experimental-strip-types`.
- A Chromium-based browser to run the app.
- `make`, for the shortcuts below (optional: the npm scripts do the same).
- Rust (stable) with the `wasm32-unknown-unknown` target (`rustup target add
  wasm32-unknown-unknown`): `npm run dev`, `npm test` and `npm run build` first build the tag
  engine into `src/lib/tags/engine.wasm` (`scripts/build-wasm.mjs`, skipped when it is newer than
  every file under `crates/`; `npm run build:wasm` forces it). `rustfmt` and `clippy` to work on
  the crates.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` (`make up`) | The dev server, on <http://localhost:8666>. |
| `npm test` (`make test`) | Every check (below). Run it before every commit. |
| `npm run build` (`make build`) | Type check, then the production build into `dist/`. Under `safeEval`, jq79 precompiles every component's functions into one script, which each page preloads. |
| `npm run preview` | Serves `dist/` as it will be deployed. |
| `npm run type-check` | The TypeScript check alone. |

The `make` targets install the dependencies first (`npm ci`) when `node_modules` is missing or
older than `package-lock.json`. A bare `make` lists them.

## What `npm test` runs

1. **`test:layers`** (`scripts/check-layers.mjs`): no import crosses the layers the wrong way (see
   [Architecture](architecture.md#layers)). `import type` and assets are exempt.
2. **`test:styles`** (`scripts/check-styles.mjs`): no shorthand with `var()` overridden by its own
   longhand in one block (jq79's scoping would drop it), and no `:hover` rule outside
   `@media (hover: hover)`, so touch screens get no hover states.
3. **`test:types`**: a type check of the helpers, `src/lib/tags/` and their tests
   (`tsconfig.test.json`).
4. **`test:unit`**: the tests (`src/**/*.test.ts`), on Node's own test runner, with no
   framework: the helpers', and every fixture of `fixtures/tags/` against the built WebAssembly
   module (`src/lib/tags/wasm.test.ts`). It also writes coverage to `.tmp/coverage/lcov.info`.
5. **`test:coverage`** (`scripts/check-coverage.mjs`): every helper file must reach 90% of lines,
   branches and functions, and a helper that no test loads fails the check.

## The tag crates

`crates/` holds jackbird's own tag engine, in Rust, with no tag dependency (see
[Architecture](architecture.md#the-tag-engine)): `jackbird-id3`, `jackbird-flac` and
`jackbird-tags`, and `jackbird-tags-wasm` (the web app's module), one Cargo workspace whose
`Cargo.toml` is at the root. The module is built with the workspace's `wasm` profile (for size).

| Command | What it does |
| --- | --- |
| `cargo test --workspace` (`make test-crates`, with the two below) | The crates' unit tests, and `jackbird-tags`' tests on every fixture in `fixtures/tags/`. |
| `cargo fmt --all --check` | The formatting (`rustfmt.toml`). |
| `cargo clippy --workspace --all-targets -- -D warnings` | The lints, with warnings as errors, as CI runs them (`tags.yml`, which also lints and builds the module for `wasm32-unknown-unknown`). |

The fixtures are small MP3 and FLAC files built byte by byte, committed with `cases.json`, which
says what each must give; [their README](../fixtures/tags/README.md) says how to make them again.

## Translations

The interface is in English (the source and the fallback) and Spanish. No text is written inline:
each one is a key in `src/lib/locales/en.ts`, with its Spanish in `src/lib/locales/es.ts`, and is
read with `t("key", { param })`, or `t.n("key", count)` for a counted text with `.one` and
`.other` forms. The compiler rejects a Spanish catalogue that misses a key, and `npm test` rejects
one whose `{placeholders}` differ from the English.

## The Deck theme

The default theme lives in `theme/default/`. Its demo page, with every token and component, is
built alongside the app:

- locally: <http://localhost:8666/theme/default/>
- on GitHub Pages: <https://jgermade.github.io/jackbird/theme/default/>, once a release has been
  deployed (see [Releases and deployment](releases.md))

Sizes are in `rem`, so the interface scales with the root font size (`4vw` on phones); only
hairlines stay in `px`.

## Conventions

[`AGENTS.md`](../AGENTS.md) holds the project's conventions: the layers, sizes, language rules,
and how work is planned and recorded in [`RECORD/`](../RECORD/) and [`ROADMAP/`](../ROADMAP/).
Temporary files go in `.tmp/`, which git ignores.
