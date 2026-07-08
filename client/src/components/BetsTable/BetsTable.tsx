import { useRef } from 'react';
import { useVirtualRange } from '../../hooks/useVirtualRange.ts';
import { useBetOrder } from '../../state/hooks.ts';
import { BetRow } from '../BetRow/BetRow.tsx';
import {trackRender} from "../../debug/renderTracker.ts";

const ROW_HEIGHT = 32;

export function BetsTable(): React.JSX.Element {
  trackRender('__table_container__');
  const order = useBetOrder();
  const containerRef = useRef<HTMLDivElement>(null);
  const { start, end, totalHeight, offsetY } = useVirtualRange(containerRef, order.length, ROW_HEIGHT);
  const visibleIds = order.slice(start, end);

  return (
    <section className="bets-table" aria-label="Live bets">
      <div className="bets-table-caption">
        <strong>Live bets</strong> {order.length.toLocaleString()} rows · virtualized
      </div>
      <div className="bets-table-header" role="row">
        <span className="cell cell-player">Player</span>
        <span className="cell cell-amount">Bet</span>
        <span className="cell cell-cashed">Cashed</span>
        <span className="cell cell-status">Status</span>
      </div>
      <div className="bets-table-body" ref={containerRef} role="rowgroup">
        <div style={{ height: totalHeight, position: 'relative' }}>
          <div
            style={{ transform: `translateY(${offsetY}px)`, position: 'absolute', top: 0, left: 0, right: 0 }}
          >
            {visibleIds.map((id) => (
              <BetRow key={id} id={id} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
