import { PrivyProvider, usePrivy } from "@privy-io/react-auth";
import {
	toSolanaWalletConnectors,
	useCreateWallet,
	useSignMessage,
	useSignTransaction,
	useWallets,
} from "@privy-io/react-auth/solana";
import { createSolanaRpc, createSolanaRpcSubscriptions, address as toAddress } from "@solana/kit";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { API_MOCK, PRIVY_APP_ID, SOLANA_RPC_URL, SOLANA_WS_URL } from "../env";
import { dropSession, setSessionSigner } from "../session";
import { setCurrentWallet } from "../trpc";
import { WalletContext, type WalletContextValue } from "./context";
import { useResetOnAccountChange } from "./reset";
import { mergeWalletSignature, wireBytes } from "./sign";

/** Google or email login; Privy keeps a managed account key behind the scenes and signs without any UI. */
export function PrivyWalletProvider({ children }: { children: ReactNode }) {
	return (
		<PrivyProvider
			appId={PRIVY_APP_ID ?? ""}
			config={{
				loginMethods: ["google", "email"],
				appearance: {
					theme: "light",
					accentColor: "#3b5bdb",
					walletChainType: "solana-only",
					showWalletLoginFirst: false,
				},
				// Signing is invisible: no wallet screens, no confirmation modals, no external wallets.
				embeddedWallets: { showWalletUIs: false, solana: { createOnLogin: "users-without-wallets" } },
				// Privy only initialises the Solana wallet list with connectors present; no browser wallets are offered.
				externalWallets: { solana: { connectors: toSolanaWalletConnectors({ shouldAutoConnect: false }) } },
				solana: {
					rpcs: {
						"solana:devnet": {
							rpc: createSolanaRpc(SOLANA_RPC_URL),
							rpcSubscriptions: createSolanaRpcSubscriptions(SOLANA_WS_URL),
						},
					},
				},
			}}
		>
			<PrivyBridge>{children}</PrivyBridge>
		</PrivyProvider>
	);
}

function PrivyBridge({ children }: { children: ReactNode }) {
	const { ready, authenticated, user, login, logout } = usePrivy();
	const { wallets, ready: walletsReady } = useWallets();
	const { createWallet } = useCreateWallet();
	const creating = useRef(false);
	// Some accounts predate automatic key creation: create one, but only if the account truly has none.
	const hasKey = !!user?.linkedAccounts?.some(
		(a) => a.type === "wallet" && (a as { chainType?: string }).chainType === "solana",
	);
	useEffect(() => {
		if (!authenticated || !walletsReady || hasKey || wallets.length > 0 || creating.current) return;
		creating.current = true;
		console.info("[privy] no account key yet, creating one");
		createWallet()
			.then(({ wallet }) => console.info("[privy] account key created", wallet.address))
			.catch((e) => console.warn("[privy] createWallet failed", e));
	}, [authenticated, walletsReady, hasKey, wallets.length, createWallet]);
	// Never hang on Privy: after a few seconds treat it as ready, so pages show a login button instead of a skeleton.
	const [timedOut, setTimedOut] = useState(false);
	useEffect(() => {
		const t = setTimeout(() => setTimedOut(true), 5000);
		return () => clearTimeout(t);
	}, []);
	const { signTransaction } = useSignTransaction();
	const wallet = authenticated ? wallets[0] : undefined;
	// Diagnostics for login issues: what Privy reports, without any secrets.
	useEffect(() => {
		console.info(
			"[privy]",
			JSON.stringify({
				ready,
				authenticated,
				walletsReady,
				wallets: wallets.map((w) => w.address),
				linked: user?.linkedAccounts?.map((a) =>
					a.type === "wallet"
						? `wallet:${(a as { chainType?: string }).chainType}:${(a as { walletClientType?: string }).walletClientType}`
						: a.type,
				),
			}),
		);
	}, [ready, authenticated, walletsReady, wallets, user]);
	const address = wallet?.address ?? null;
	const { signMessage } = useSignMessage();

	setCurrentWallet(address);
	// Session sign-in: the embedded key signs the server's message with no prompt.
	setSessionSigner(
		wallet && !API_MOCK
			? {
					wallet: wallet.address,
					signMessage: async (message) =>
						(await signMessage({ message, wallet, options: { uiOptions: { showWalletUIs: false } } }))
							.signature,
				}
			: null,
	);
	useResetOnAccountChange(address);

	const value = useMemo<WalletContextValue>(
		() => ({
			mode: "privy",
			ready: timedOut || (ready && (!authenticated || walletsReady)),
			address,
			authenticated: ready && authenticated,
			settingUp: ready && authenticated && !address,
			label: user?.google?.email ?? user?.email?.address ?? null,
			login,
			logout: () => {
				if (address) dropSession(address);
				void logout();
			},
			signTransaction: async (tx) => {
				if (API_MOCK) return tx;
				if (!wallet) throw new Error("Wallet is still being created, try again in a moment");
				const { signedTransaction } = await signTransaction({
					transaction: wireBytes(tx),
					wallet,
					chain: "solana:devnet",
					options: { uiOptions: { showWalletUIs: false } },
				});
				return mergeWalletSignature(tx, signedTransaction, toAddress(wallet.address));
			},
			persona: null,
			personas: [],
			selectPersona: () => {},
			missingKeyFor: null,
		}),
		[ready, timedOut, authenticated, walletsReady, address, user, login, logout, wallet, signTransaction],
	);

	return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
