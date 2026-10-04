import { signBytes } from "@solana/kit";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { API_MOCK, DEMO_SECRETS } from "../env";
import { PERSONA_STORAGE_KEY, PERSONAS, type PersonaId } from "../personas";
import { setSessionSigner } from "../session";
import { setCurrentWallet } from "../trpc";
import { WalletContext, type WalletContextValue } from "./context";
import { useResetOnAccountChange } from "./reset";
import { keyPairFromSecret, signWithKeyPair } from "./sign";

const STORAGE_KEY = PERSONA_STORAGE_KEY;

type Loaded = Partial<Record<PersonaId, { keyPair: CryptoKeyPair; address: string }>>;

function readStoredPersona(): PersonaId | null {
	try {
		const v = localStorage.getItem(STORAGE_KEY);
		if (v && v in PERSONAS) return v as PersonaId;
		// A shared demo link (?auth=demo) on a fresh browser: sign in as the account the page is for, no gate.
		// Candidate (/c) and recruiter-profile (/r) pages stay as they are.
		if (new URLSearchParams(location.search).get("auth") !== "demo") return null;
		const fromRoute: PersonaId | null = location.pathname.startsWith("/company")
			? "company"
			: location.pathname.startsWith("/scout")
				? "scout"
				: null;
		if (fromRoute) localStorage.setItem(STORAGE_KEY, fromRoute);
		return fromRoute;
	} catch {
		return null;
	}
}

/**
 * Persona switcher for the live demo: Company and Scout (plus a second scout for the
 * duplicate-candidate step). With the mock API, personas use fixed mock addresses and
 * signing is a no-op. Against the real API, each persona is a devnet keypair from .env.
 */
export function DemoWalletProvider({ children }: { children: ReactNode }) {
	const [personaId, setPersonaId] = useState<PersonaId | null>(readStoredPersona);
	const [keys, setKeys] = useState<Loaded>({});
	const [ready, setReady] = useState(API_MOCK);

	useEffect(() => {
		if (API_MOCK) return;
		let cancelled = false;
		(async () => {
			const loaded: Loaded = {};
			for (const id of Object.keys(PERSONAS) as PersonaId[]) {
				const secret = DEMO_SECRETS[id];
				if (!secret) continue;
				try {
					loaded[id] = await keyPairFromSecret(secret);
				} catch (e) {
					console.error(`Invalid VITE_DEMO_${id.toUpperCase()}_SECRET`, e);
				}
			}
			if (!cancelled) {
				setKeys(loaded);
				setReady(true);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	const personas = useMemo(
		() => Object.values(PERSONAS).filter((p) => API_MOCK || p.id !== "scout2" || DEMO_SECRETS.scout2),
		[],
	);
	const persona = personaId ? PERSONAS[personaId] : null;
	const address = persona ? (API_MOCK ? persona.mockAddress : (keys[persona.id]?.address ?? null)) : null;
	const missingKeyFor = !API_MOCK && ready && persona && !keys[persona.id] ? persona.id : null;

	// Set synchronously so queries issued during this render already sign in as this account.
	setCurrentWallet(address);
	const keyPair = persona ? keys[persona.id]?.keyPair : undefined;
	setSessionSigner(
		address && keyPair
			? { wallet: address, signMessage: async (m) => new Uint8Array(await signBytes(keyPair.privateKey, m)) }
			: null,
	);
	useResetOnAccountChange(address);

	// Mock demo: once a person plays a recruiter, the simulator leaves Karolina to them.
	useEffect(() => {
		if (API_MOCK && personaId && PERSONAS[personaId].kind === "scout")
			try {
				localStorage.setItem("scout.mock-recruiter-used", "1");
			} catch {}
	}, [personaId]);

	const selectPersona = useCallback((id: PersonaId) => {
		// Another person now: their toasts aren't yours.
		toast.dismiss();
		setPersonaId(id);
		try {
			localStorage.setItem(STORAGE_KEY, id);
		} catch {
			// private mode
		}
	}, []);

	const value = useMemo<WalletContextValue>(
		() => ({
			mode: "demo",
			ready,
			address,
			authenticated: !!persona,
			settingUp: false,
			label: persona?.displayName ?? null,
			login: () => selectPersona("company"),
			logout: () => {
				setPersonaId(null);
				try {
					localStorage.removeItem(STORAGE_KEY);
				} catch {
					// private mode
				}
			},
			signTransaction: async (tx) => {
				if (API_MOCK) return tx;
				const key = persona ? keys[persona.id] : undefined;
				if (!key) throw new Error("This demo account isn't set up");
				return signWithKeyPair(tx, key.keyPair);
			},
			persona,
			personas,
			selectPersona,
			missingKeyFor,
		}),
		[ready, address, persona, personas, keys, selectPersona, missingKeyFor],
	);

	return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
