import { createContext, useContext } from "react";
import type { Persona, PersonaId } from "../personas";

export type WalletContextValue = {
	mode: "privy" | "demo";
	/** Auth state settled (Privy initialised / demo keys loaded). */
	ready: boolean;
	/** Base58 address of the active identity, null when logged out. */
	address: string | null;
	/** Logged in (Privy session or demo persona), even if the account key is still being created. */
	authenticated: boolean;
	/** Logged in, account key being created: show "Setting up your account…", never a Log in button. */
	settingUp: boolean;
	/** Email or persona label for the header. */
	label: string | null;
	login: () => void;
	logout: () => void;
	/** Sign a base64 wire transaction as the user (partial signature; the relayer adds the fee payer's). */
	signTransaction: (base64Tx: string) => Promise<string>;
	/** Demo mode only. */
	persona: Persona | null;
	personas: Persona[];
	selectPersona: (id: PersonaId) => void;
	/** Demo mode against the real API, with a persona whose keypair is missing from .env. */
	missingKeyFor: PersonaId | null;
};

export const WalletContext = createContext<WalletContextValue | null>(null);

export function useWallet() {
	const ctx = useContext(WalletContext);
	if (!ctx) throw new Error("useWallet must be used inside <WalletProvider>");
	return ctx;
}
