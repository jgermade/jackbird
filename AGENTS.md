## Architecture

Check [STACK.md](STACK.md)

Check [THESAURUS.md](THESAURUS.md)

## Language

**All repository content is written in English**: code, identifiers, comments, UI strings,
documentation, records, roadmaps and commit messages. This applies whatever language the
conversation with the user is held in.

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
