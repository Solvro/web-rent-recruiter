/**
 * Mock data unless VITE_API_MOCK=0. "?data=mock" or "?data=live" overrides it at runtime and is remembered,
 * so the live demo can fall back to simulated data without restarting anything.
 */
function readDataOverride(): boolean | null {
	try {
		const param = new URLSearchParams(location.search).get("data");
		if (param === "mock" || param === "live") localStorage.setItem("scout.data", param);
		const stored = localStorage.getItem("scout.data");
		return stored === "mock" ? true : stored === "live" ? false : null;
	} catch {
		return null;
	}
}
export const API_MOCK = readDataOverride() ?? import.meta.env.VITE_API_MOCK !== "0";
/** tRPC endpoint (the dev server proxies /trpc to the backend). */
export const TRPC_URL = import.meta.env.VITE_TRPC_URL ?? "/trpc";
export const PRIVY_APP_ID = import.meta.env.VITE_PRIVY_APP_ID as string | undefined;
export const SOLANA_RPC_URL = import.meta.env.VITE_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
export const SOLANA_WS_URL = import.meta.env.VITE_SOLANA_WS_URL ?? SOLANA_RPC_URL.replace(/^http/, "ws");

export const DEMO_SECRETS = {
	company: import.meta.env.VITE_DEMO_COMPANY_SECRET as string | undefined,
	scout: import.meta.env.VITE_DEMO_SCOUT_SECRET as string | undefined,
	scout2: import.meta.env.VITE_DEMO_SCOUT2_SECRET as string | undefined,
};

export const PRIVY_AVAILABLE = !!PRIVY_APP_ID;

const AUTH_MODE_KEY = "scout.auth-mode";
type AuthMode = "privy" | "demo";

/** ?auth=demo or ?auth=privy switches mode and remembers it, so a live demo can flip without a rebuild. */
function readAuthOverride(): AuthMode | null {
	try {
		const param = new URLSearchParams(location.search).get("auth");
		if (param === "demo" || param === "privy") localStorage.setItem(AUTH_MODE_KEY, param);
		const stored = localStorage.getItem(AUTH_MODE_KEY);
		return stored === "demo" || stored === "privy" ? stored : null;
	} catch {
		return null;
	}
}

const preferred: AuthMode =
	readAuthOverride() ?? (import.meta.env.VITE_AUTH_MODE === "demo" ? "demo" : "privy");

/** Google login via Privy when an app id is configured, unless demo personas were chosen explicitly. */
export const AUTH_MODE: AuthMode = PRIVY_AVAILABLE && preferred === "privy" ? "privy" : "demo";

export function switchAuthMode(mode: AuthMode) {
	try {
		localStorage.setItem(AUTH_MODE_KEY, mode);
	} catch {
		// private mode: fall through to a plain reload
	}
	location.assign(`${location.pathname}?auth=${mode}`);
}

/** Flip between simulated and live data from the UI (the account menu). Remembered, like "?data=". */
export function switchDataMode(mode: "mock" | "live") {
	try {
		localStorage.setItem("scout.data", mode);
	} catch {
		// private mode: the URL parameter still applies to this load
	}
	location.assign(`${location.pathname}?data=${mode}`);
}
