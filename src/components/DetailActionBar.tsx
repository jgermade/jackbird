type DetailActionBarProps = {
  selectedCount: number;
  onShowInfo: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onClearSelection: () => void;
};

export function DetailActionBar(props: DetailActionBarProps): JSX.Element {
  const { selectedCount, onShowInfo, onEdit, onDelete, onClearSelection } = props;

  return (
    <div className="detail-action-bar">
      <div className="detail-action-info">
        <span className="detail-action-count">
          {selectedCount} {selectedCount === 1 ? "pista seleccionada" : "pistas seleccionadas"}
        </span>
      </div>
      <div className="detail-action-buttons">
        <button type="button" className="btn btn-secondary btn-sm" onClick={onShowInfo}>
          Mostrar info
        </button>
        <button type="button" className="btn btn-primary btn-sm" onClick={onEdit}>
          Editar
        </button>
        <button type="button" className="btn btn-danger btn-sm" onClick={onDelete}>
          Borrar
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClearSelection} title="Deseleccionar todo">
          ✕
        </button>
      </div>
    </div>
  );
}
