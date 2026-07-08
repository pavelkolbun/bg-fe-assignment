import {StoreProvider} from "@/state/context.tsx";

export function App(): React.JSX.Element {
  return (
    <StoreProvider>Init</StoreProvider>
  );
}
