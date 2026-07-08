import { useConnection, useRound } from '../../state/hooks';

export function ConnectionStatusBar(): React.JSX.Element {
  const { status, stats, anomalies } = useConnection();
  const round = useRound();

  return (
    <header className="status-bar">
      <div className="status-bar-row">
        <h1 className="app-title">Crash live board</h1>
        <span className={`pill pill-status status-${status}`}>
          {status} · seq {stats.lastSeq.toLocaleString()}
        </span>
        <span className="pill">drift {stats.driftMs >= 0 ? '+' : ''}{stats.driftMs} ms</span>
        <span className="pill pill-muted">round #{round.roundId.toLocaleString()}</span>
        <div className="counters">
          <span title="Exact-seq duplicate frames dropped">dupes dropped {stats.duplicates}</span>
          <span title="Late frames reordered back into place">reordered {stats.outOfOrderFixed}</span>
          <span title="Sequence gaps detected in the feed">gaps {stats.gapsDetected}</span>
          <span title="Socket reconnects since page load">reconnects {stats.reconnects}</span>
        </div>
      </div>
      <details className="anomaly-log">
        <summary>Event log (debug) · last {anomalies.length}</summary>
        <ul>
          {anomalies.map((a) => (
            <li key={`${a.time}-${a.message}`}>
              <span className="anomaly-time">{new Date(a.time).toLocaleTimeString()}</span>
              <span className={`anomaly-kind anomaly-${a.kind}`}>{a.kind}</span>
              <span>{a.message}</span>
            </li>
          ))}
        </ul>
      </details>
    </header>
  );
}
