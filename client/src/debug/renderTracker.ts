declare global {
  interface Window {
    __renderCounts?: Map<string, number>;
    __PERF_DEBUG__?: boolean;
  }
}

/**
 * Opt-in render counter used only to produce the evidence in PERFORMANCE.md —
 * this environment has no interactive Chrome DevTools UI to screenshot the
 * React Profiler tab from, so instead we count actual render calls per row id
 * (set `window.__PERF_DEBUG__ = true` before the app mounts, e.g. via
 * Playwright's `addInitScript`). No-op, and effectively dead code eliminated
 * by the bundler's `__PERF_DEBUG__` check, when unset.
 */
export function trackRender(id: string): void {
  if (typeof window === 'undefined' || !window.__PERF_DEBUG__) return;
  window.__renderCounts ??= new Map();
  window.__renderCounts.set(id, (window.__renderCounts.get(id) ?? 0) + 1);
}
