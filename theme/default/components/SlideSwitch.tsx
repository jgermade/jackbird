import type { ReactNode } from "react";
import { cx } from "./shared";
import "./Legend.css";
import "./SlideSwitch.css";

export type SlideSwitchProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** The switch's accessible name: what "on" means. */
  label: string;
  /** Printed either side of the switch; clicking one moves the switch there. */
  offLegend?: ReactNode;
  onLegend?: ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
};

/**
 * A slide switch, like the hold switch on a portable player: the signal colour
 * shows under the thumb when it is on.
 *
 *   <SlideSwitch label="Dark tone" offLegend="Silver" onLegend="Graphite"
 *     checked={dark} onChange={setDark} />
 */
export function SlideSwitch(props: SlideSwitchProps): JSX.Element {
  const { checked, onChange, label, offLegend, onLegend, disabled = false, id, className } = props;
  const set = (next: boolean) => {
    if (!disabled && next !== checked) {
      onChange(next);
    }
  };

  return (
    <span className={cx("mm-slide", className)}>
      {offLegend != null && (
        <span className={cx("mm-legend", "mm-slide-legend", !checked && "is-current")} aria-hidden="true" onClick={() => set(false)}>
          {offLegend}
        </span>
      )}
      <button
        type="button"
        role="switch"
        id={id}
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        className="mm-slide-track"
        onClick={() => set(!checked)}
      >
        <span className="mm-slide-thumb" />
      </button>
      {onLegend != null && (
        <span className={cx("mm-legend", "mm-slide-legend", checked && "is-current")} aria-hidden="true" onClick={() => set(true)}>
          {onLegend}
        </span>
      )}
    </span>
  );
}
