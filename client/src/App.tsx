import {StoreProvider} from "./state/context.tsx";
import {BetsTable} from "./components/BetsTable/BetsTable.tsx";
import {MultiplierTicker} from "./components/MultiplierTicker/MultiplierTicker.tsx";
import {ConnectionStatusBar} from "./components/ConnectionStatusBar/ConnectionStatusBar.tsx";
import {BetPanel} from "./components/BetPanel/BetPanel.tsx";

export function App(): React.JSX.Element {
  return (
    <StoreProvider>
      <div className="app">
        <ConnectionStatusBar />
        <main className="app-main">
          <aside className="app-sidebar">
            <MultiplierTicker />
            <BetPanel />
          </aside>
          <BetsTable />
        </main>
      </div>
    </StoreProvider>
  );
}
