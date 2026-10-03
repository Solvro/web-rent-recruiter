import { lazy, type ReactNode, Suspense } from "react";
import { AUTH_MODE } from "../env";
import { setCurrentWallet } from "../trpc";
import { WalletContext, type WalletContextValue } from "./context";
import { DemoWalletProvider } from "./demo-provider";

export { useWallet } from "./context";

// Privy is heavy; only load it when an app id is configured.
const PrivyWalletProvider = lazy(() =>
	import("./privy-provider").then((m) => ({ default: m.PrivyWalletProvider })),
);

/**
 * Candidate pages (/c/…) need no account and must open on any host (a tunnel isn't in Privy's allowed origins):
 * they get a guest context and never load Privy or a demo persona.
 */
const GUEST: WalletContextValue = {
	mode: "demo",
	ready: true,
	address: null,
	authenticated: false,
	settingUp: false,
	label: null,
	login: () => {},
	logout: () => {},
	signTransaction: () => Promise.reject(new Error("No account on this page")),
	persona: null,
	personas: [],
	selectPersona: () => {},
	missingKeyFor: null,
};
const isCandidatePage = () => typeof location !== "undefined" && location.pathname.startsWith("/c/");

export function WalletProvider({ children }: { children: ReactNode }) {
	if (isCandidatePage()) {
		setCurrentWallet(null);
		return <WalletContext.Provider value={GUEST}>{children}</WalletContext.Provider>;
	}
	if (AUTH_MODE === "privy")
		return (
			<Suspense fallback={null}>
				<PrivyWalletProvider>{children}</PrivyWalletProvider>
			</Suspense>
		);
	return <DemoWalletProvider>{children}</DemoWalletProvider>;
}
