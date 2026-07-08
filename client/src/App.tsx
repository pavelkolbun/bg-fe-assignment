import {StoreProvider} from "./state/context.tsx";
import {BetsTable} from "./components/BetsTable/BetsTable.tsx";

export function App(): React.JSX.Element {
  return (
    <StoreProvider>
      Init
      <BetsTable />
    </StoreProvider>
  );
}
