import { memo, useEffect, useRef } from 'react';
import { useBetRow, useRound } from '../../state/hooks.ts';
import { type DisplayStatus } from '../../state/types';
import {deriveDisplayStatus} from "../../state/store.ts";

const STATUS_LABEL: Record<DisplayStatus, string> = {
  active: 'active',
  cashed_out: 'cashed out',
  lost: 'lost',
  pending: 'pending',
  rejected: 'rejected',
};

function BetRowImpl({ id }: { id: string }): React.JSX.Element | null {
  const bet = useBetRow(id);
  const round = useRound();
  const rowRef = useRef<HTMLDivElement>(null);
  const prevRef = useRef<{ status: string; cashedAt: number | null } | null>(null);

  useEffect(() => {
    if (!bet || !rowRef.current) return;
    const prev = prevRef.current;
    const changed = prev !== null && (prev.status !== bet.status || prev.cashedAt !== bet.cashedAt);
    prevRef.current = { status: bet.status, cashedAt: bet.cashedAt };
    if (changed) {
      rowRef.current.animate(
        [
          { backgroundColor: 'rgba(250, 204, 21, 0.5)' },
          { backgroundColor: 'rgba(250, 204, 21, 0)' },
        ],
        { duration: 900, easing: 'ease-out' },
      );
    }
  }, [bet?.status, bet?.cashedAt]);

  if (!bet) return null;
  const display = deriveDisplayStatus(bet, round.phase);

  return (
    <div ref={rowRef} className="bet-row" role="row">
      <span className="cell cell-player">{bet.isYou ? 'you' : bet.player}</span>
      <span className="cell cell-amount">{bet.amount.toFixed(2)}</span>
      <span className="cell cell-cashed">{bet.cashedAt !== null ? `${bet.cashedAt.toFixed(2)}×` : '—'}</span>
      <span className={`cell cell-status status-${display}`}>{STATUS_LABEL[display]}</span>
    </div>
  );
}

export const BetRow = memo(BetRowImpl);
