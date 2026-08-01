type RootTab = {
  id: string;
  label: string;
  count: number;
  loadingMetadata: boolean;
  loadedCount: number;
};

type RootTabsProps = {
  tabs: RootTab[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
};

export function RootTabs(props: RootTabsProps): JSX.Element {
  const { tabs, activeTabId, onSelectTab, onCloseTab } = props;

  if (tabs.length === 0) {
    return <div className="empty-tabs">Sin roots abiertas</div>;
  }

  return (
    <div className="panel-tabs">
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        return (
          <div key={tab.id} className={active ? "root-tab is-active" : "root-tab"}>
            <button type="button" className="root-tab-main" onClick={() => onSelectTab(tab.id)}>
              <span>{tab.label}</span>
              <small>
                {tab.loadingMetadata ? `${tab.loadedCount}/${tab.count}` : tab.count}
              </small>
            </button>
            <button
              type="button"
              className="root-tab-close"
              onClick={() => onCloseTab(tab.id)}
              aria-label={`Cerrar ${tab.label}`}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
