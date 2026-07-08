import { useEffect, useState } from 'react';
import { useStoreContext } from '../../state/context';
import { useCashOut, useConnection, usePlaceBet, useRound, useYourBet } from '../../state/hooks';

const MIN_AMOUNT = 1;
const MAX_AMOUNT = 500;

export function BetPanel(): React.JSX.Element {
  const round = useRound();
  const yourBet = useYourBet();
  const connection = useConnection();
  const placeBet = usePlaceBet();
  const cashOut = useCashOut();
  const { store } = useStoreContext();
  const isLive = connection.status === 'live';
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

  const canPlaceBet =
    isLive && round.phase === 'betting' && (yourBet.status === 'idle' || yourBet.status === 'rejected');
  const canCashOut = isLive && round.phase === 'flight' && yourBet.status === 'active';

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
        <button
          className="bet-button cashout"
          disabled={!canCashOut}
          onClick={() => yourBet.betId && cashOut(yourBet.betId)}
        >
          Cash out
        </button>
      )}

      {round.phase === 'flight' && yourBet.status === 'cashing_out' && (
        <button className="bet-button" disabled>
          Cashing out…
        </button>
      )}

      <div className="bet-status-line">
        {!isLive && <span className="bet-msg bet-msg-muted">{connection.status}… betting paused</span>}
        {isLive && yourBet.status === 'rejected' && (
          <span className="bet-msg bet-msg-bad">rejected: {yourBet.rejectReason}</span>
        )}
        {isLive && yourBet.status === 'cashed_out' && (
          <span className="bet-msg bet-msg-good">cashed out at {yourBet.cashedAt?.toFixed(2)}×</span>
        )}
        {isLive && yourBet.status === 'lost' && <span className="bet-msg bet-msg-bad">lost — round crashed</span>}
        {isLive && yourBet.status === 'idle' && round.phase !== 'betting' && (
          <span className="bet-msg bet-msg-muted">wait for the next round</span>
        )}
      </div>
      <p className="bet-hint">pending → confirmed / rejected</p>
    </section>
  );
}
