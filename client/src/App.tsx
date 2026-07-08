import {StoreProvider} from "./state/context.tsx";
import {BetsTable} from "./components/BetsTable/BetsTable.tsx";
import {MultiplierTicker} from "./components/MultiplierTicker/MultiplierTicker.tsx";

export function App(): React.JSX.Element {
  return (
    <StoreProvider>
      <div className="app">
        <main className="app-main">
          <aside className="app-sidebar">
            <MultiplierTicker />
          </aside>
          <BetsTable />
        </main>
      </div>
    </StoreProvider>
  );
}
