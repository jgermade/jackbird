import type { TableHTMLAttributes } from "react";
import { cx } from "./shared";
import "./Table.css";

/**
 * A data table that scrolls sideways inside its own box. Rows take
 * `aria-selected` and `data-playing`; cells take the classes `mm-num`,
 * `mm-end` and `mm-title`.
 *
 *   <Table aria-label="Tracks"><thead>…</thead><tbody>
 *     <tr aria-selected="true" data-playing="true"><td className="mm-num">01</td>…</tr>
 *   </tbody></Table>
 */
export function Table(props: TableHTMLAttributes<HTMLTableElement>): JSX.Element {
  const { className, ...rest } = props;
  return (
    <div className="mm-table-wrap">
      <table className={cx("mm-table", className)} {...rest} />
    </div>
  );
}
