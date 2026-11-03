import type { Translate } from "../lib/i18n";

type DetailActionBarProps = {
  t: Translate;
  selectedCount: number;
  onShowInfo: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onClearSelection: () => void;
};

export function DetailActionBar(props: DetailActionBarProps): JSX.Element {
  const { t, selectedCount, onShowInfo, onEdit, onDelete, onClearSelection } = props;

  return (
    <div className="detail-action-bar">
      <div className="detail-action-info">
        <span className="detail-action-count">
          {t.n("selection.count", selectedCount)}
        </span>
      </div>
      <div className="detail-action-buttons">
        <button type="button" className="btn btn-secondary btn-sm" onClick={onShowInfo}>
          {t("actions.showInfo")}
        </button>
        <button type="button" className="btn btn-primary btn-sm" onClick={onEdit}>
          {t("actions.edit")}
        </button>
        <button type="button" className="btn btn-danger btn-sm" onClick={onDelete}>
          {t("actions.delete")}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClearSelection} title={t("actions.clearSelection")} aria-label={t("actions.clearSelection")}>
          ✕
        </button>
      </div>
    </div>
  );
}
