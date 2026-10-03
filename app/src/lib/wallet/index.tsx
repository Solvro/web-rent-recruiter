import { lazy, type ReactNode, Suspense } from "react";
import { AUTH_MODE } from "../env";
import { DemoWalletProvider } from "./demo-provider";

export { useWallet } from "./context";

// Privy is heavy; only load it when an app id is configured.
const PrivyWalletProvider = lazy(() =>
	import("./privy-provider").then((m) => ({ default: m.PrivyWalletProvider })),
);

export function WalletProvider({ children }: { children: ReactNode }) {
	if (AUTH_MODE === "privy")
		return (
			<Suspense fallback={null}>
				<PrivyWalletProvider>{children}</PrivyWalletProvider>
			</Suspense>
		);
	return <DemoWalletProvider>{children}</DemoWalletProvider>;
}
