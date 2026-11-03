// The default theme's demo: every token read back from the computed style,
// and every component in its variants and states. Served at /theme/default/.
// See RECORD/2026-11-03.deck-design-system.WIP.md.

import { StrictMode, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  Checkbox,
  Counter,
  Display,
  DisplayLabel,
  DisplayRow,
  DisplayTitle,
  EqBars,
  Field,
  Key,
  KeyBank,
  KeySelect,
  Lamp,
  Legend,
  ListRow,
  Meter,
  Modal,
  Panel,
  Reel,
  Select,
  SlideSwitch,
  Stripes,
  Table,
  Tabs,
  TextInput,
  fieldNoteId
} from "./components";
import "./fonts.css";
import "./tokens.css";
import "./demo.css";

const THEME_KEY = "mp3-manager.theme-demo";

const ALBUM = { artist: "Miles Davis", title: "Kind of Blue", year: "1959" };
const TRACKS = [
  { n: "01", title: "So What", secs: 562 },
  { n: "02", title: "Freddie Freeloader", secs: 586 },
  { n: "03", title: "Blue in Green", secs: 337 },
  { n: "04", title: "All Blues", secs: 693 },
  { n: "05", title: "Flamenco Sketches", secs: 566 }
];
const TOTAL_SECS = TRACKS.reduce((sum, track) => sum + track.secs, 0);

const COLOUR_GROUPS: Array<[string, string[]]> = [
  ["Grounds", ["bg", "chassis", "chassis-hi", "chassis-lo", "surface", "sunken", "field", "hover", "border", "border-strong", "key-top", "key-bottom", "key-down"]],
  ["Ink", ["fg", "fg-muted", "fg-subtle"]],
  ["Signal", ["accent", "accent-hover", "accent-ink", "on-accent", "accent-soft"]],
  ["States", ["ok", "ok-led", "ok-soft", "warn", "warn-led", "warn-soft", "bad", "bad-led", "bad-soft", "on-bad", "led-off"]],
  ["Display", ["display-bg", "display-fg", "display-bezel", "stripe-1", "stripe-2", "stripe-3"]]
];

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

// ---- icons -------------------------------------------------------------------

const PrevIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <rect x="2" y="3" width="2" height="10" />
    <path d="M14 3v10L5 8z" />
  </svg>
);
const NextIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <rect x="12" y="3" width="2" height="10" />
    <path d="M2 3v10l9-5z" />
  </svg>
);
const PlayIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M4 2.5v11L13.5 8z" />
  </svg>
);
const PauseIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <rect x="3.5" y="3" width="3" height="10" />
    <rect x="9.5" y="3" width="3" height="10" />
  </svg>
);
const GearIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <circle cx="8" cy="8" r="2.4" />
    <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" strokeLinecap="round" />
  </svg>
);

// ---- state shared by the faceplate and the library ---------------------------

type Playback = {
  index: number;
  position: number;
  playing: boolean;
};

function usePlayback(): [Playback, { toggle: () => void; next: () => void; prev: () => void; play: (index: number) => void }] {
  const [state, setState] = useState<Playback>({ index: 0, position: 192, playing: false });

  useEffect(() => {
    if (!state.playing) {
      return;
    }
    const timer = window.setInterval(() => {
      setState((current) => {
        const position = current.position + 1;
        if (position < TRACKS[current.index].secs) {
          return { ...current, position };
        }
        return { ...current, index: (current.index + 1) % TRACKS.length, position: 0 };
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [state.playing]);

  return [
    state,
    {
      toggle: () => setState((current) => ({ ...current, playing: !current.playing })),
      next: () => setState((current) => ({ ...current, index: (current.index + 1) % TRACKS.length, position: 0 })),
      prev: () => setState((current) => ({ ...current, index: (current.index + TRACKS.length - 1) % TRACKS.length, position: 0 })),
      play: (index: number) => setState({ index, position: 0, playing: true })
    }
  ];
}

// ---- sections ----------------------------------------------------------------

function Section(props: { id: string; title: string; lead: string; children: ReactNode }): JSX.Element {
  return (
    <section className="demo-section" aria-labelledby={props.id}>
      <div className="demo-head">
        <h2 id={props.id}>{props.title}</h2>
        <p>{props.lead}</p>
      </div>
      {props.children}
    </section>
  );
}

function Faceplate(props: { playback: Playback; controls: ReturnType<typeof usePlayback>[1] }): JSX.Element {
  const { playback, controls } = props;
  const [mode, setMode] = useState<"flat" | "wizard">("wizard");
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState(true);
  const track = TRACKS[playback.index];

  return (
    <div className="demo-faceplate">
      <div className="demo-brand">
        <Stripes />
        <div>
          <div className="demo-brand-name">MP3 Manager</div>
          <Legend>Library deck</Legend>
        </div>
      </div>

      <div className="demo-stack">
        <KeyBank label="Transport">
          <Key square aria-label="Previous track" onClick={controls.prev}>
            <PrevIcon />
          </Key>
          <Key square aria-label={playback.playing ? "Pause" : "Play"} pressed={playback.playing} onClick={controls.toggle}>
            {playback.playing ? <PauseIcon /> : <PlayIcon />}
          </Key>
          <Key square aria-label="Next track" onClick={controls.next}>
            <NextIcon />
          </Key>
        </KeyBank>
        <Legend>Transport</Legend>
      </div>

      <Display aria-live="polite">
        <DisplayRow>
          <DisplayLabel>{playback.playing ? "▶ Play" : "■ Stop"}</DisplayLabel>
          <DisplayLabel>
            Track <Counter size="sm">{track.n}/05</Counter>
          </DisplayLabel>
        </DisplayRow>
        <DisplayRow>
          <DisplayTitle title={`${track.title} — ${ALBUM.artist}`}>
            {track.title} — {ALBUM.artist}
          </DisplayTitle>
          <Counter>{formatTime(playback.position)}</Counter>
        </DisplayRow>
        <Meter variant="display" segments={48} value={playback.position} max={track.secs} label="Position" valueText={`${formatTime(playback.position)} of ${formatTime(track.secs)}`} />
      </Display>

      <div className="demo-fp-right">
        <KeySelect
          label="Library view"
          value={mode}
          onChange={setMode}
          options={[
            { value: "flat", label: "Flat" },
            { value: "wizard", label: "Wizard" }
          ]}
        />
        <KeyBank label="Playback modes">
          <Key size="sm" led pressed={shuffle} onClick={() => setShuffle(!shuffle)}>
            Shuffle
          </Key>
          <Key size="sm" led pressed={repeat} onClick={() => setRepeat(!repeat)}>
            Repeat
          </Key>
        </KeyBank>
      </div>
    </div>
  );
}

function Swatches(): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!ref.current) {
      return;
    }
    const style = getComputedStyle(ref.current);
    const read: Record<string, string> = {};
    for (const [, tokens] of COLOUR_GROUPS) {
      for (const token of tokens) {
        read[token] = style.getPropertyValue(`--mm-${token}`).trim();
      }
    }
    setValues(read);
  }, []);

  return (
    <div ref={ref} className="demo-spec">
      {COLOUR_GROUPS.map(([group, tokens]) => (
        <div key={group} className="demo-swatch-group">
          <Legend>{group}</Legend>
          <div className="demo-swatches">
            {tokens.map((token) => (
              <div key={token} className="demo-sw">
                <b style={{ background: `var(--mm-${token})` }} />
                <span>{token}</span>
                <code>{values[token] ?? ""}</code>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Tone(props: { tone: "light" | "dark"; name: string; kind: string }): JSX.Element {
  return (
    <div className="demo-tone" data-tone={props.tone}>
      <div className="demo-tone-head">
        <span className="demo-tone-name">{props.name}</span>
        <Legend>{props.kind}</Legend>
      </div>
      <Swatches />
      <div className="demo-tone-sample">
        <Display>
          <DisplayRow>
            <DisplayLabel>Scan</DisplayLabel>
            <Counter size="sm">603/739</Counter>
          </DisplayRow>
          <Meter variant="display" value={603} max={739} label="Scan progress" />
        </Display>
        <Key variant="primary">Save</Key>
      </div>
    </div>
  );
}

function KeysSection(): JSX.Element {
  const [groupBy, setGroupBy] = useState<"album" | "artist" | "folder">("album");
  const [hold, setHold] = useState(true);
  const [latched, setLatched] = useState(false);

  return (
    <div className="demo-grid-2">
      <Panel title="Keys">
        <div className="demo-spec">
          <div className="demo-spec-row">
            <Legend>Variants</Legend>
            <div className="demo-items">
              <Key variant="primary">Save</Key>
              <Key>Rename</Key>
              <Key variant="ghost">Cancel</Key>
              <Key variant="danger">Delete</Key>
              <Key disabled>Undo</Key>
            </div>
          </div>
          <div className="demo-spec-row">
            <Legend>Sizes</Legend>
            <div className="demo-items">
              <Key size="sm">Small</Key>
              <Key>Medium</Key>
              <Key size="lg">Large</Key>
            </div>
          </div>
          <div className="demo-spec-row">
            <Legend>Square · icon only</Legend>
            <div className="demo-items">
              <Key square size="sm" aria-label="Play">
                <PlayIcon />
              </Key>
              <Key square aria-label="Preferences">
                <GearIcon />
              </Key>
              <Key square size="lg" variant="ghost" aria-label="Next track">
                <NextIcon />
              </Key>
            </div>
          </div>
          <div className="demo-spec-row">
            <Legend>Latching · with LED</Legend>
            <div className="demo-items">
              <Key led pressed={latched} onClick={() => setLatched(!latched)}>
                Loop
              </Key>
              <span className="demo-state">pressed: {String(latched)}</span>
            </div>
          </div>
        </div>
      </Panel>

      <Panel title="Banks and switches">
        <div className="demo-spec">
          <div className="demo-spec-row">
            <Legend>KeyBank · transport</Legend>
            <div className="demo-items">
              <KeyBank label="Transport">
                <Key square aria-label="Previous track">
                  <PrevIcon />
                </Key>
                <Key square aria-label="Play">
                  <PlayIcon />
                </Key>
                <Key square aria-label="Next track">
                  <NextIcon />
                </Key>
              </KeyBank>
            </div>
          </div>
          <div className="demo-spec-row">
            <Legend>KeySelect · one key down</Legend>
            <div className="demo-items">
              <KeySelect
                label="Group by"
                value={groupBy}
                onChange={setGroupBy}
                options={[
                  { value: "album", label: "Album" },
                  { value: "artist", label: "Artist" },
                  { value: "folder", label: "Folder" }
                ]}
              />
              <span className="demo-state">value: {groupBy}</span>
            </div>
          </div>
          <div className="demo-spec-row">
            <Legend>SlideSwitch</Legend>
            <div className="demo-items">
              <SlideSwitch label="Lock editing" offLegend="Edit" onLegend="Hold" checked={hold} onChange={setHold} />
              <span className="demo-state">checked: {String(hold)}</span>
            </div>
            <div className="demo-items">
              <SlideSwitch label="Disabled switch" offLegend="Off" onLegend="On" checked={false} onChange={() => undefined} disabled />
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}

function FieldsSection(): JSX.Element {
  const [saved, setSaved] = useState(false);
  const [year, setYear] = useState("1959");
  const yearInvalid = !/^\d{4}$/.test(year);

  function handleSubmit(event: FormEvent<HTMLElement>): void {
    event.preventDefault();
    setSaved(true);
  }

  return (
    <Panel
      as="form"
      autoComplete="off"
      title="Edit metadata · 2 tracks"
      actions={saved ? <Lamp tone="ok">Saved</Lamp> : <Lamp tone="warn">Unsaved</Lamp>}
      onSubmit={handleSubmit}
      onChange={() => setSaved(false)}
      footer={
        <>
          <Checkbox label="Rename files from tags" defaultChecked />
          <div className="demo-keys">
            <Key variant="ghost">Cancel</Key>
            <Key variant="primary" type="submit" disabled={yearInvalid}>
              Save 2 tracks
            </Key>
          </div>
        </>
      }
    >
      <div className="demo-form">
        <Field className="demo-c6" label="Title" htmlFor="f-title" hint="The two tracks have different titles; leave it empty to keep each one.">
          <TextInput id="f-title" placeholder="(Multiple values)" aria-describedby={fieldNoteId("f-title")} />
        </Field>
        <Field className="demo-c3" label="Artist" htmlFor="f-artist">
          <TextInput id="f-artist" defaultValue={ALBUM.artist} />
        </Field>
        <Field className="demo-c3" label="Album" htmlFor="f-album">
          <TextInput id="f-album" defaultValue={ALBUM.title} />
        </Field>
        <Field className="demo-c2" label="Year" htmlFor="f-year" error={yearInvalid ? "Four digits, like 1959." : undefined}>
          <TextInput id="f-year" numeric inputMode="numeric" value={year} invalid={yearInvalid} aria-describedby={yearInvalid ? fieldNoteId("f-year") : undefined} onChange={(event) => setYear(event.target.value)} />
        </Field>
        <Field className="demo-c2" label="Track" htmlFor="f-track">
          <TextInput id="f-track" numeric placeholder="(Multiple)" />
        </Field>
        <Field className="demo-c2" label="Genre" htmlFor="f-genre">
          <Select id="f-genre" defaultValue="Jazz">
            <option>Jazz</option>
            <option>Modal jazz</option>
            <option>Hard bop</option>
          </Select>
        </Field>
        <Field className="demo-c6" label="Path" htmlFor="f-path" hint="Read only: renaming happens on save.">
          <TextInput id="f-path" numeric disabled value="Jazz/Miles Davis/1959 - Kind of Blue/" />
        </Field>
      </div>
    </Panel>
  );
}

function IndicatorsSection(): JSX.Element {
  const [scanned, setScanned] = useState(603);
  const scanning = scanned < 739;

  useEffect(() => {
    if (!scanning) {
      return;
    }
    const timer = window.setTimeout(() => setScanned((count) => Math.min(739, count + 7)), 60);
    return () => window.clearTimeout(timer);
  }, [scanned, scanning]);

  return (
    <div className="demo-grid-3">
      <Panel title="Lamps">
        <div className="demo-ind">
          <div className="demo-items">
            <Lamp tone="ok">Saved</Lamp>
            <Lamp tone="warn">Unsaved</Lamp>
            <Lamp tone="bad">Write failed</Lamp>
            <Lamp tone="accent">Playing</Lamp>
            <Lamp>Not scanned</Lamp>
          </div>
          <p>A state is a lamp and a word, never a colour alone.</p>
        </div>
      </Panel>
      <Panel title="Meter" actions={<Key size="sm" onClick={() => setScanned(0)} disabled={scanning}>Rescan</Key>}>
        <div className="demo-ind">
          <Meter variant="chassis" segments={24} value={scanned} max={739} label="Reading tags" valueText={`${scanned} of 739 tracks`} />
          <div className="demo-row">
            <Legend>Reading tags</Legend>
            <span className="demo-mono">
              {scanned} / 739
            </span>
          </div>
          <p>On the chassis, as LEDs. Inside a display it takes the display's ink.</p>
        </div>
      </Panel>
      <Panel title="Busy and playing">
        <div className="demo-ind">
          <div className="demo-items">
            <Reel size={32} />
            <Reel size={24} speed="fast" label="Writing" />
            <EqBars active />
            <EqBars />
            <span className="demo-mono">Writing 2 files…</span>
          </div>
          <p>The reel turns while work runs; the bars mark the track that is playing. Both stop under reduced motion.</p>
        </div>
      </Panel>
    </div>
  );
}

type TreeNode = { id: string; kind: "folder" | "item"; depth: number; label: string; meta: string; parent?: string; track?: number };

const TREE: TreeNode[] = [
  { id: "miles", kind: "folder", depth: 0, label: "Miles Davis", meta: "5" },
  { id: "kob", kind: "folder", depth: 1, label: "1959 - Kind of Blue", meta: "5", parent: "miles" },
  ...TRACKS.map((track, index): TreeNode => ({ id: `t${index}`, kind: "item", depth: 2, label: track.title, meta: track.n, parent: "kob", track: index })),
  { id: "heads", kind: "folder", depth: 0, label: "Talking Heads", meta: "8" },
  { id: "bjork", kind: "folder", depth: 0, label: "Björk", meta: "10" },
  { id: "nina", kind: "folder", depth: 0, label: "Nina Simone", meta: "14" }
];

function ContextSection(props: { playback: Playback; controls: ReturnType<typeof usePlayback>[1] }): JSX.Element {
  const { playback, controls } = props;
  const [roots, setRoots] = useState([
    { id: "music", label: "Music", meta: "739" },
    { id: "jazz", label: "Jazz archive", meta: "2 114" },
    { id: "usb", label: "Car USB", meta: "96" }
  ]);
  const [activeRoot, setActiveRoot] = useState<string | null>("music");
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["miles", "kob"]));
  const [selected, setSelected] = useState<Set<number>>(new Set([0, 2]));

  const visible = TREE.filter((node) => {
    let parent = node.parent;
    while (parent) {
      if (!expanded.has(parent)) {
        return false;
      }
      parent = TREE.find((candidate) => candidate.id === parent)?.parent;
    }
    return true;
  });

  function toggleFolder(id: string): void {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function toggleTrack(index: number): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }

  function closeRoot(id: string): void {
    const remaining = roots.filter((root) => root.id !== id);
    setRoots(remaining);
    if (activeRoot === id) {
      setActiveRoot(remaining[0]?.id ?? null);
    }
  }

  return (
    <div className="demo-app">
      <Tabs
        label="Open folders"
        tabs={roots.map((root) => ({ ...root, closeLabel: `Close ${root.label}` }))}
        activeId={activeRoot}
        onSelect={setActiveRoot}
        onClose={closeRoot}
      />
      <div className="demo-panes">
        <aside className="demo-library" aria-label="Library">
          <div className="demo-lib-head">
            <div className="demo-row">
              <Legend>Library · 739 tracks</Legend>
              <Lamp tone="ok">Synced</Lamp>
            </div>
            <TextInput aria-label="Filter" placeholder="Filter by title, artist or album" />
          </div>
          <div className="demo-tree" role="tree" aria-label="Folders and tracks" aria-multiselectable="true">
            {visible.map((node) => {
              const isTrack = node.track !== undefined;
              const index = node.track ?? -1;
              return (
                <ListRow
                  key={node.id}
                  kind={node.kind}
                  depth={node.depth}
                  label={node.label}
                  meta={node.meta}
                  expanded={node.kind === "folder" ? expanded.has(node.id) : undefined}
                  selected={isTrack && selected.has(index)}
                  playing={isTrack && index === playback.index}
                  playingActive={playback.playing}
                  tabIndex={node.id === "miles" ? 0 : -1}
                  onClick={() => (isTrack ? toggleTrack(index) : toggleFolder(node.id))}
                  onDoubleClick={() => isTrack && controls.play(index)}
                />
              );
            })}
          </div>
        </aside>

        <div className="demo-detail">
          <div className="demo-action-bar">
            <Legend tone="accent">{selected.size} selected</Legend>
            <div className="demo-keys">
              <Key size="sm" disabled={selected.size === 0} onClick={() => controls.play(Math.min(...selected))}>
                Play
              </Key>
              <Key size="sm" disabled={selected.size === 0}>
                Edit
              </Key>
              <Key size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Clear
              </Key>
            </div>
          </div>
          <div className="demo-jcard">
            <div className="demo-cover" aria-hidden="true">
              <Stripes variant="band" />
            </div>
            <div>
              <Legend>Album · {ALBUM.year}</Legend>
              <h3>{ALBUM.title}</h3>
              <p>{ALBUM.artist}</p>
              <div className="demo-items">
                <Lamp>5 tracks</Lamp>
                <Lamp>{formatTime(TOTAL_SECS)}</Lamp>
                <Lamp>MP3 · 320 kbps</Lamp>
              </div>
            </div>
          </div>
          <div className="demo-tracks">
            <Table aria-label={`${ALBUM.title} tracks`}>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Title</th>
                  <th>Artist</th>
                  <th className="mm-end">Time</th>
                </tr>
              </thead>
              <tbody>
                {TRACKS.map((track, index) => {
                  const current = index === playback.index;
                  return (
                    <tr key={track.n} aria-selected={selected.has(index)} data-playing={current} onClick={() => toggleTrack(index)}>
                      <td className="mm-num">{track.n}</td>
                      <td>
                        <span className="mm-title">
                          {current && <EqBars active={playback.playing} />}
                          {track.title}
                        </span>
                      </td>
                      <td>{ALBUM.artist}</td>
                      <td className="mm-num mm-end">{formatTime(track.secs)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
        </div>
      </div>
    </div>
  );
}

function OverlaySection(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="demo-items">
      <Key onClick={() => setOpen(true)}>Open track info</Key>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        eyebrow="Track info"
        title="So What"
        footer={
          <Key variant="primary" onClick={() => setOpen(false)}>
            Done
          </Key>
        }
      >
        <div className="demo-spec">
          <div className="demo-row">
            <Legend>Path</Legend>
            <span className="demo-mono">Jazz/Miles Davis/1959 - Kind of Blue/01 - So What.mp3</span>
          </div>
          <div className="demo-row">
            <Legend>Duration</Legend>
            <span className="demo-mono">09:22</span>
          </div>
          <div className="demo-row">
            <Legend>Audio checksum</Legend>
            <span className="demo-mono">3f9a…c21e</span>
          </div>
          <div className="demo-row">
            <Legend>State</Legend>
            <Lamp tone="ok">Saved</Lamp>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ---- page --------------------------------------------------------------------

function Demo(): JSX.Element {
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === "dark");
  const [playback, controls] = usePlayback();

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    try {
      localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
    } catch {
      // Private browsing: the choice still applies to this page.
    }
  }, [dark]);

  return (
    <>
      <header className="demo-mast">
        <div className="demo-wrap">
          <div className="demo-brand">
            <Stripes />
            <div>
              <div className="demo-brand-name">MP3 Manager</div>
              <Legend>Deck · default theme</Legend>
            </div>
          </div>
          <SlideSwitch label="Dark tone (Graphite)" offLegend="Silver" onLegend="Graphite" checked={dark} onChange={setDark} />
        </div>
      </header>

      <main className="demo-wrap">
        <div className="demo-hero">
          <h1>A library manager with the feel of a tape deck</h1>
          <p>
            Deck borrows the parts of old portable audio gear that still work as interface: a display window that shows state, keys that look pressable,
            printed labels and one signal colour. Everything else stays flat and quiet.
          </p>
          <Faceplate playback={playback} controls={controls} />
        </div>

        <Section id="rules" title="Five rules" lead="What makes it feel like the gear without turning into a costume.">
          <ul className="demo-rules">
            <li>
              <Legend>Evoke, don't copy</Legend>
              <strong>No real product's look.</strong>
              <span>No click wheels, logos or chrome photos. The references are materials and habits, not a device.</span>
            </li>
            <li>
              <Legend>One signal colour</Legend>
              <strong>Orange means "this one".</strong>
              <span>The primary key, the selection, a lit LED and the playing track. Nothing decorative is orange.</span>
            </li>
            <li>
              <Legend>Displays show state</Legend>
              <strong>Status lives in a window.</strong>
              <span>Now playing, counters and scan progress go in an LCD by day and a VFD by night.</span>
            </li>
            <li>
              <Legend>Keys travel</Legend>
              <strong>A press moves 1px down.</strong>
              <span>Keys sit in banks; a latched key stays down with its LED lit.</span>
            </li>
            <li>
              <Legend>Printed labels</Legend>
              <strong>Small, wide, uppercase.</strong>
              <span>Section heads, column heads and field labels are set like the print on a faceplate.</span>
            </li>
          </ul>
        </Section>

        <Section id="materials" title="Materials" lead="Every colour token in both tones, read back from the computed style. Silver is the light tone, Graphite the dark one.">
          <div className="demo-grid-2">
            <Tone tone="light" name="Silver" kind="Light · LCD" />
            <Tone tone="dark" name="Graphite" kind="Dark · VFD" />
          </div>
        </Section>

        <Section id="type" title="Type, space and shape" lead="Four faces with one job each, served from theme/default/fonts/. Spacing and radii are tokens too.">
          <div className="demo-spec">
            <div className="demo-table">
              <div className="demo-type-row">
                <div>
                  <Legend>Label</Legend>
                  <code>--mm-font-label</code>
                  <code>Archivo · 125% · 600</code>
                </div>
                <div className="demo-s-label">Track · Artist · Album · Year · Genre</div>
              </div>
              <div className="demo-type-row">
                <div>
                  <Legend>Body</Legend>
                  <code>--mm-font-sans</code>
                  <code>IBM Plex Sans</code>
                </div>
                <div className="demo-s-sans">Freddie Freeloader, from Kind of Blue (1959), 9 min 46 s</div>
              </div>
              <div className="demo-type-row">
                <div>
                  <Legend>Data</Legend>
                  <code>--mm-font-mono</code>
                  <code>IBM Plex Mono</code>
                </div>
                <div className="demo-s-mono">Jazz/Miles Davis/1959 - Kind of Blue/02 - Freddie Freeloader.mp3</div>
              </div>
              <div className="demo-type-row">
                <div>
                  <Legend>Display</Legend>
                  <code>--mm-font-display</code>
                  <code>Doto · 700</code>
                </div>
                <div className="demo-s-display">02/05 09:46</div>
              </div>
            </div>
            <div className="demo-grid-2">
              <Panel title="Space · --mm-space-1 … 8">
                <div className="demo-scale">
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((step) => (
                    <div key={step}>
                      <span className="demo-space" style={{ width: `var(--mm-space-${step})` }} />
                      <span className="demo-state">{step}</span>
                    </div>
                  ))}
                </div>
              </Panel>
              <Panel title="Radii · key, md, lg, full">
                <div className="demo-scale">
                  {["key", "md", "lg", "full"].map((radius) => (
                    <div key={radius}>
                      <span className="demo-radius" style={{ borderRadius: `var(--mm-radius-${radius})` }} />
                      <span className="demo-state">{radius}</span>
                    </div>
                  ))}
                </div>
              </Panel>
            </div>
          </div>
        </Section>

        <Section id="keys" title="Keys, banks and switches" lead="Key is the theme's button. KeyBank sets keys in a recess; KeySelect is a bank with one key down.">
          <KeysSection />
        </Section>

        <Section id="fields" title="Fields" lead="Field, TextInput, Select and Checkbox, shown as the batch metadata editor. Clear the year to see an error.">
          <FieldsSection />
        </Section>

        <Section id="indicators" title="Indicators" lead="Lamp, Meter, Reel and EqBars. Rescan runs the meter from zero.">
          <IndicatorsSection />
        </Section>

        <Section id="context" title="In context" lead="Tabs, ListRow and Table as the library and album sheet. Example data; double-click a track to play it.">
          <ContextSection playback={playback} controls={controls} />
        </Section>

        <Section id="overlay" title="Modal" lead="On the native dialog: Escape, the close key and a click outside all close it.">
          <OverlaySection />
        </Section>
      </main>

      <footer className="demo-foot">
        <div className="demo-wrap">
          Tokens in <code>theme/default/tokens.css</code>, components in <code>theme/default/components/</code>. See{" "}
          <code>RECORD/2026-11-03.deck-design-system.WIP.md</code>.
        </div>
      </footer>
    </>
  );
}

createRoot(document.getElementById("demo")!).render(
  <StrictMode>
    <Demo />
  </StrictMode>
);
