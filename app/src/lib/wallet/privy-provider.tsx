import { PrivyProvider, usePrivy } from "@privy-io/react-auth";
import { toSolanaWalletConnectors, useSignTransaction, useWallets } from "@privy-io/react-auth/solana";
import { createSolanaRpc, createSolanaRpcSubscriptions, address as toAddress } from "@solana/kit";
import { type ReactNode, useMemo } from "react";
import { setApiWallet } from "../api";
import { API_MOCK, PRIVY_APP_ID, SOLANA_RPC_URL, SOLANA_WS_URL } from "../env";
import { WalletContext, type WalletContextValue } from "./context";
import { mergeWalletSignature, wireBytes } from "./sign";

/** Google login with a Privy-managed Solana embedded wallet. Users never see seed phrases or SOL. */
export function PrivyWalletProvider({ children }: { children: ReactNode }) {
	return (
		<PrivyProvider
			appId={PRIVY_APP_ID ?? ""}
			config={{
				loginMethods: ["google", "email"],
				appearance: { theme: "light", accentColor: "#3b5bdb", walletChainType: "solana-only" },
				embeddedWallets: { solana: { createOnLogin: "users-without-wallets" } },
				externalWallets: { solana: { connectors: toSolanaWalletConnectors() } },
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
	const { signTransaction } = useSignTransaction();
	const wallet = authenticated ? wallets[0] : undefined;
	const address = wallet?.address ?? null;

	setApiWallet(address);

	const value = useMemo<WalletContextValue>(
		() => ({
			mode: "privy",
			ready: ready && (!authenticated || walletsReady),
			address,
			label: user?.google?.email ?? user?.email?.address ?? null,
			login,
			logout: () => void logout(),
			signTransaction: async (tx) => {
				if (API_MOCK) return tx;
				if (!wallet) throw new Error("Wallet is still being created, try again in a moment");
				const { signedTransaction } = await signTransaction({
					transaction: wireBytes(tx),
					wallet,
					chain: "solana:devnet",
				});
				return mergeWalletSignature(tx, signedTransaction, toAddress(wallet.address));
			},
			persona: null,
			personas: [],
			selectPersona: () => {},
			missingKeyFor: null,
		}),
		[ready, authenticated, walletsReady, address, user, login, logout, wallet, signTransaction],
	);

	return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
