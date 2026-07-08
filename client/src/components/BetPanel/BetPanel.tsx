import { useEffect, useState } from 'react';
import { useStoreContext } from '../../state/context';
import { useCashOut, usePlaceBet, useRound, useYourBet } from '../../state/hooks';

const MIN_AMOUNT = 1;
const MAX_AMOUNT = 500;

export function BetPanel(): React.JSX.Element {
  const round = useRound();
  const yourBet = useYourBet();
  const placeBet = usePlaceBet();
  const cashOut = useCashOut();
  const { store } = useStoreContext();
  const [amount, setAmount] = useState('25.00');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (round.phase !== 'betting') return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [round.phase]);

  const parsedAmount = Number(amount);
  const amountValid = Number.isFinite(parsedAmount) && parsedAmount >= MIN_AMOUNT && parsedAmount <= MAX_AMOUNT;

  const drift = store.getConnectionSnapshot().stats.driftMs;
  const secondsLeft = round.phaseEndsAt !== null ? Math.max(0, (round.phaseEndsAt - (now + drift)) / 1000) : 0;

  const canPlaceBet = round.phase === 'betting' && (yourBet.status === 'idle' || yourBet.status === 'rejected');

  return (
    <section className="bet-panel" aria-label="Your bet">
      <h2>Place bet</h2>
      <input
        type="number"
        min={MIN_AMOUNT}
        max={MAX_AMOUNT}
        step="0.01"
        value={amount}
        disabled={!canPlaceBet}
        onChange={(e) => setAmount(e.target.value)}
        aria-label="Bet amount"
      />

      {canPlaceBet && (
        <button
          className="bet-button"
          disabled={!amountValid}
          onClick={() => placeBet(parsedAmount)}
        >
          Bet next round · {secondsLeft.toFixed(1)}s
        </button>
      )}

      {round.phase === 'betting' && yourBet.status === 'pending' && (
        <button className="bet-button" disabled>
          Placing bet…
        </button>
      )}

      {round.phase === 'flight' && yourBet.status === 'active' && (
        <button className="bet-button cashout" onClick={() => yourBet.betId && cashOut(yourBet.betId)}>
          Cash out
        </button>
      )}

      {round.phase === 'flight' && yourBet.status === 'cashing_out' && (
        <button className="bet-button" disabled>
          Cashing out…
        </button>
      )}

      <div className="bet-status-line">
        {yourBet.status === 'rejected' && <span className="bet-msg bet-msg-bad">rejected: {yourBet.rejectReason}</span>}
        {yourBet.status === 'cashed_out' && (
          <span className="bet-msg bet-msg-good">cashed out at {yourBet.cashedAt?.toFixed(2)}×</span>
        )}
        {yourBet.status === 'lost' && <span className="bet-msg bet-msg-bad">lost — round crashed</span>}
        {yourBet.status === 'idle' && round.phase !== 'betting' && (
          <span className="bet-msg bet-msg-muted">wait for the next round</span>
        )}
      </div>
      <p className="bet-hint">pending → confirmed / rejected</p>
    </section>
  );
}
