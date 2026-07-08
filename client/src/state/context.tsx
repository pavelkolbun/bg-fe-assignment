import { createContext, useContext, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { WS_URL } from '../config';
import { FeedClient } from '../ws/client';
import type { ClientCommand } from '../ws/protocol';
import { Store } from './store';

interface StoreContextValue {
  store: Store;
  send: (cmd: ClientCommand) => void;
}

const StoreContext = createContext<StoreContextValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const storeRef = useRef<Store | null>(null);
  const clientRef = useRef<FeedClient | null>(null);
  if (storeRef.current === null) {
    storeRef.current = new Store();
    clientRef.current = new FeedClient(WS_URL, storeRef.current.handlers);
  }

  useEffect(() => {
    // StrictMode's dev double-invoke connects, disconnects, reconnects once —
    // harmless, and matches the real reconnect path we already have to support.
    clientRef.current?.connect();
    return () => clientRef.current?.close();
  }, []);

  const value: StoreContextValue = {
    store: storeRef.current,
    send: (cmd) => clientRef.current?.send(cmd),
  };

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStoreContext(): StoreContextValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStoreContext must be used within StoreProvider');
  return ctx;
}
