import { useEffect, useRef } from 'react';
import { useStoreContext } from '../../state/context';
import { useRound } from '../../state/hooks';

const MAX_EXTRAPOLATION_MS = 150;

interface Anchor {
  value: number;
  localTime: number; // in Date.now() domain, drift already applied
  rate: number; // multiplier units per ms
}

export function MultiplierTicker(): React.JSX.Element {
  const { store } = useStoreContext();
  const round = useRound();
  const valueRef = useRef<HTMLSpanElement>(null);
  const anchorRef = useRef<Anchor>({ value: 1, localTime: Date.now(), rate: 0 });
  const prevRef = useRef<{ value: number; localTime: number } | null>(null);

  useEffect(
    () =>
      store.subscribeTicker((a) => {
        const drift = store.getConnectionSnapshot().stats.driftMs;
        const localTime = a.serverTime - drift;
        const prev = prevRef.current;
        let rate = 0;
        if (prev && a.phase === 'flight' && localTime > prev.localTime) {
          rate = Math.max(0, (a.value - prev.value) / (localTime - prev.localTime));
        }
        anchorRef.current = { value: a.value, localTime, rate };
        prevRef.current = { value: a.value, localTime };
      }),
    [store],
  );

  useEffect(() => {
    let raf: number;
    const frame = () => {
      const { value, localTime, rate } = anchorRef.current;
      const elapsed = Math.min(Math.max(0, Date.now() - localTime), MAX_EXTRAPOLATION_MS);
      const displayed = value + rate * elapsed;
      if (valueRef.current) valueRef.current.textContent = `${displayed.toFixed(2)}×`;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  const crashed = round.phase === 'crashed' || round.phase === 'pause';

  return (
    <section className={`ticker ticker-${round.phase}`} aria-label="Multiplier">
      <div className="ticker-label">Multiplier</div>
      <div className="ticker-value">
        <span ref={valueRef}>1.00×</span>
      </div>
      <div className="ticker-sub">
        {round.phase === 'betting' && 'betting open — waiting for take-off'}
        {round.phase === 'flight' && '20 ticks / second'}
        {crashed && round.crashMultiplier !== null && `crashed at ${round.crashMultiplier.toFixed(2)}×`}
      </div>
      <div className="ticker-history">
        <div className="ticker-history-label">Last rounds</div>
        <div className="chips">
          {round.lastRounds.map((m, i) => (
            <span key={`${i}-${m}`} className={`chip ${chipClass(m)}`}>
              {m.toFixed(2)}×
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

function chipClass(multiplier: number): string {
  if (multiplier >= 10) return 'chip-gold';
  if (multiplier >= 2) return 'chip-green';
  return 'chip-gray';
}
