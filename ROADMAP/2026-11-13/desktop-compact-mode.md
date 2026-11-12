# The desktop app's compact mode

A small window for the desktop app (Tauri v2) that is only the deck: the display and the
transport keys, like a hi-fi unit on the desk, while the music plays and the library is out of
the way. Asked by the owner on 2026-11-12, after seeing the landing page's mock-up of a deck
(later replaced by the real faceplate); planned on 2026-11-13. The reasoning goes into
[RECORD/2026-11-03.deck-design-system.WIP.md](../../RECORD/2026-11-03.deck-design-system.WIP.md)
when it is taken up.

The window's part is the desktop app's: a browser page cannot size or keep its own window on top,
and a phone's screen is already one deck. In Chromium's desktop browsers (Chrome, Edge), the same
view floats in a Picture-in-Picture window (C1b, added on 2026-11-13 at the owner's ask). Dates are estimates; each step ends with its "done when" met and a
walkthrough in the record.

```mermaid
gantt
  title The desktop app's compact mode
  dateFormat YYYY-MM-DD
  axisFormat %d %b
  section Compact mode
    C1 The compact view                     :c1, 2026-11-16, 2d
    C1b In the web, in Picture-in-Picture   :c1b, after c1, 1d
    C2 The window: size, on top, dragged    :c2, after c1b, 2d
    C3 Kept, and reached from the keyboard  :c3, after c2, 1d
```

| Step | Scope | Done when |
| --- | --- | --- |
| C1 The compact view | A view of the app that is the faceplate's deck alone: the display (its three views, the clock), the transport keys, a key back to the full window; the queue's next track on the display's second line when there is room. Drawn by the faceplate's own pieces, so it follows every change to them. In the web build too, for a narrow window, without the window's part. | at about 30rem by 7rem the deck shows the playing track, its format and its spectrum, and plays, pauses and skips |
| C1b In the web, in Picture-in-Picture | Where the browser has `documentPictureInPicture` (Chromium's desktop browsers), a key on the faceplate opens the compact view in a floating window of its own (the Document Picture-in-Picture API), its styles copied there; closed, the view goes back to the page. Where it has not, the key turns the page itself compact. | in Chrome and Edge on a desktop the floating window shows the track, its format and its spectrum, plays, pauses and skips, and keeps playing with the tab in the background |
| C2 The window | From the desktop app: a key (and the menu) turns the window into the compact one: its size and least size, kept on top of others or not (a latching key with its LED), no title bar, dragged by the deck's chassis (`data-tauri-drag-region`); back to the full window at its earlier size and place. Tauri's window API (`setSize`, `setMinSize`, `setAlwaysOnTop`, `setDecorations`), allowed in the app's capabilities. | on macOS, Windows and Linux the window turns compact and back, stays on top when asked, and is moved by its chassis |
| C3 Kept, and the keyboard | The mode, its place and "on top" kept across restarts (the app starts compact if it was closed so); a shortcut to turn it (Ctrl/Cmd+Shift+M); the media keys reach it as they do the full window. | closed compact, the app comes back compact where it was; the shortcut turns it both ways |

Not in it: a menu-bar or tray player, and more than one window at once; they can follow on their
own if wanted.
