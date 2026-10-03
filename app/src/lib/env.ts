/** Mock API is the default until the backend is up. Set VITE_API_MOCK=0 to hit the real API. */
export const API_MOCK = import.meta.env.VITE_API_MOCK !== "0";
export const API_URL = import.meta.env.VITE_API_URL ?? "/api";
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
