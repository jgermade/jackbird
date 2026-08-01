## Architecture

Check [STACK.md](STACK.md)

Check [THESAURUS.md](THESAURUS.md)

## Project Managment

Sessions and specifications live in [SESSIONS/](./SESSIONS/). Convention:

- Name format: `YYYY-MM-DD_HHhMM.<summary>.session.md` where `<summary>` is a kebab-case slug of the topic.
- Files can be **extended** (appended to the end) but existing content must never be deleted or modified. The extensions should include the date and time of the extension, as well as the summary of the new content added.
- For a new topic with no relation to previous ones: create a new file.
- Session files should always be written in English

## Critical Rules

### Session-first workflow
**Never make changes without first documenting them in a session file.** This is non-negotiable. Before implementing any feature, refactoring code, or adding dependencies:

1. Create or extend the appropriate session file in `SESSIONS/`
2. Document the planned changes in detail
3. Wait for user approval before proceeding
4. When current session is completed, only when user explicitly order it, add "Status: Completed" and `walkthrough` at the end of the session file.

## Tasks

- When adding a task to do, **extended** session file with implementation plan
- When task is done, append to current session file a walkthrough with what's done. And suggest a 1-line commit message in English.

## Ending sessions

When the user says **"capitular"**:

1. Complete current session and update `README.md` with the project specifications (in -# Project Specs- section) and a todo list (in -# Todos- section if exists).
2. Ask user to start a new session.
3. Unless user require to capitulate explicitly, never create a new session file. Instead attach proposal to the current session file and ask the user to review and approve it.

For temp files and folders, use `.tmp/` into project root.
Temporary scripts should be created in `.tmp/scripts/`.
