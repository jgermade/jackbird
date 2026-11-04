# Development

## Requirements

- Node.js 22.6 or later: the unit tests run TypeScript directly with `--experimental-strip-types`.
- A Chromium-based browser to run the app.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | The dev server, on <http://localhost:8666>. |
| `npm test` | Every check (below). Run it before every commit. |
| `npm run build` | Type check, then the production build into `dist/`. Each page preloads every jq79 component script it loads (a small plugin in `vite.config.ts`), so they download in parallel instead of one after another. |
| `npm run preview` | Serves `dist/` as it will be deployed. |
| `npm run type-check` | The TypeScript check alone. |

## What `npm test` runs

1. **`test:layers`** (`scripts/check-layers.mjs`): no import crosses the layers the wrong way (see
   [Architecture](architecture.md#layers)). `import type` and assets are exempt.
2. **`test:types`**: a type check of the helpers and their tests (`tsconfig.test.json`).
3. **`test:unit`**: the helpers' tests (`src/**/*.test.ts`), on Node's own test runner, with no
   framework. It also writes coverage to `.tmp/coverage/lcov.info`.
4. **`test:coverage`** (`scripts/check-coverage.mjs`): every helper file must reach 90% of lines,
   branches and functions, and a helper that no test loads fails the check.

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
