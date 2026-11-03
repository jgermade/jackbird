import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { Led } from "./Led";
import { cx } from "./shared";
import "./Tabs.css";

export type TabItem = {
  id: string;
  label: ReactNode;
  /** Small mono text after the label: a count. */
  meta?: ReactNode;
  /** The close key's accessible name, e.g. "Close Music". */
  closeLabel?: string;
};

export type TabsProps = {
  /** The tab list's accessible name. */
  label: string;
  tabs: TabItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  /** When given, each tab gets a close key. */
  onClose?: (id: string) => void;
  className?: string;
};

/**
 * Tabs on the chassis. The open one joins the panel below, carries the
 * stripes and has its LED lit. Arrow keys, Home and End move between tabs.
 *
 *   <Tabs label="Open folders" tabs={roots} activeId={active} onSelect={open} onClose={close} />
 */
export function Tabs(props: TabsProps): JSX.Element {
  const { label, tabs, activeId, onSelect, onClose, className } = props;
  const listRef = useRef<HTMLDivElement>(null);
  const focusableId = tabs.some((tab) => tab.id === activeId) ? activeId : tabs[0]?.id;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const index = tabs.findIndex((tab) => tab.id === (event.target as HTMLElement).dataset.tabId);
    if (index < 0) {
      return;
    }
    const last = tabs.length - 1;
    const next =
      event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : -1;
    if (next < 0) {
      return;
    }
    event.preventDefault();
    onSelect(tabs[next].id);
    listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }

  return (
    <div ref={listRef} role="tablist" aria-label={label} className={cx("mm-tabs", className)} onKeyDown={handleKeyDown}>
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <div key={tab.id} className={cx("mm-tab", active && "is-active")}>
            <button
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={tab.id === focusableId ? 0 : -1}
              data-tab-id={tab.id}
              className="mm-tab-main"
              onClick={() => onSelect(tab.id)}
            >
              <Led on={active} />
              <span>{tab.label}</span>
              {tab.meta != null && <span className="mm-tab-meta">{tab.meta}</span>}
            </button>
            {onClose && (
              <button type="button" className="mm-tab-close" aria-label={tab.closeLabel ?? "Close tab"} title={tab.closeLabel} onClick={() => onClose(tab.id)}>
                <svg viewBox="0 0 10 10" aria-hidden="true">
                  <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
