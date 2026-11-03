import type { CSSProperties, HTMLAttributes, MouseEvent, ReactNode } from "react";
import { EqBars } from "./EqBars";
import { cx } from "./shared";
import "./ListRow.css";

export type ListRowProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  kind: "folder" | "item";
  /** Indent level, from 0. Also sets `aria-level`. */
  depth?: number;
  /** Folders only: sets `aria-expanded` and turns the caret. */
  expanded?: boolean;
  selected?: boolean;
  /** The row being played: accent label and moving bars in place of `meta`. */
  playing?: boolean;
  /** Whether playback is running, for the bars. */
  playingActive?: boolean;
  label: ReactNode;
  /** Right side: a count, a track number. */
  meta?: ReactNode;
  /** Replaces the folder or track icon. */
  icon?: ReactNode;
  /** Folders only: a click on the caret, which does not reach the row's onClick. */
  onToggle?: () => void;
};

const folderIcon = (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M1.5 3.5h4.2l1.4 1.6h7.4v8.4h-13z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
  </svg>
);

const trackIcon = (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="8" cy="8" r="1.6" fill="currentColor" />
  </svg>
);

/**
 * One row of the library tree: a folder or a track. It is a `treeitem`; the
 * tree around it owns focus and the arrow keys, as TrackWizardList does.
 *
 *   <ListRow kind="item" depth={2} label="So What" meta="01" selected playing playingActive />
 */
export function ListRow(props: ListRowProps): JSX.Element {
  const {
    kind,
    depth = 0,
    expanded,
    selected = false,
    playing = false,
    playingActive = false,
    label,
    meta,
    icon,
    onToggle,
    className,
    style,
    ...rest
  } = props;
  const rowStyle = { ...style, "--mm-row-depth": depth } as CSSProperties;

  function handleCaret(event: MouseEvent<HTMLSpanElement>): void {
    if (onToggle) {
      event.stopPropagation();
      onToggle();
    }
  }

  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={kind === "folder" ? expanded === true : undefined}
      aria-selected={selected}
      className={cx("mm-row", `mm-row--${kind}`, playing && "is-playing", className)}
      style={rowStyle}
      {...rest}
    >
      <span className="mm-row-caret" onClick={handleCaret}>
        {kind === "folder" && (
          <svg viewBox="0 0 8 8" aria-hidden="true">
            <path d="M2 1l4 3-4 3z" fill="currentColor" />
          </svg>
        )}
      </span>
      <span className="mm-row-icon">{icon ?? (kind === "folder" ? folderIcon : trackIcon)}</span>
      <span className="mm-row-label">{label}</span>
      {playing ? <EqBars active={playingActive} /> : meta != null ? <span className="mm-row-meta">{meta}</span> : <span />}
    </div>
  );
}
