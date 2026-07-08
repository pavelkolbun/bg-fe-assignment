import { useCallback, useSyncExternalStore } from 'react';
import { useStoreContext } from './context';
import type { BetView, RoundSnapshot, YourBetSnapshot } from './types';
import type { ClientCommand } from '../ws/protocol';

export function useSend(): (cmd: ClientCommand) => void {
  const { send } = useStoreContext();
  return send;
}

export function usePlaceBet(): (amount: number) => void {
  const { store, send } = useStoreContext();
  return useCallback(
    (amount: number) => {
      const clientBetId = generateClientBetId();
      store.placeBetOptimistic(clientBetId, amount);
      send({ type: 'place_bet', clientBetId, amount });
    },
    [store, send],
  );
}

export function useCashOut(): (betId: string) => void {
  const { store, send } = useStoreContext();
  return useCallback(
    (betId: string) => {
      store.markCashingOut();
      send({ type: 'cash_out', betId });
    },
    [store, send],
  );
}

let clientBetIdCounter = 0;
function generateClientBetId(): string {
  clientBetIdCounter += 1;
  return `c-${Date.now().toString(36)}-${clientBetIdCounter}-${Math.random().toString(36).slice(2, 6)}`;
}

export function useRound(): RoundSnapshot {
  const { store } = useStoreContext();
  return useSyncExternalStore(store.subscribeRound, store.getRoundSnapshot);
}

export function useConnection() {
  const { store } = useStoreContext();
  return useSyncExternalStore(store.subscribeConnection, store.getConnectionSnapshot);
}

export function useYourBet(): YourBetSnapshot {
  const { store } = useStoreContext();
  return useSyncExternalStore(store.subscribeYourBet, store.getYourBetSnapshot);
}

export function useBetOrder(): readonly string[] {
  const { store } = useStoreContext();
  return useSyncExternalStore(store.subscribeOrder, store.getOrderSnapshot);
}

export function useBetRow(id: string): BetView | undefined {
  const { store } = useStoreContext();
  const subscribe = useCallback((cb: () => void) => store.subscribeRow(id)(cb), [store, id]);
  const getSnapshot = useCallback(() => store.getRowSnapshot(id), [store, id]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
