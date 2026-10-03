/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_API_MOCK?: string;
	readonly VITE_TRPC_URL?: string;
	readonly VITE_PRIVY_APP_ID?: string;
	readonly VITE_AUTH_MODE?: "privy" | "demo";
	readonly VITE_SOLANA_RPC_URL?: string;
	readonly VITE_SOLANA_WS_URL?: string;
	readonly VITE_DEMO_COMPANY_SECRET?: string;
	readonly VITE_DEMO_SCOUT_SECRET?: string;
	readonly VITE_DEMO_SCOUT2_SECRET?: string;
	/** Public origin for candidate links (a tunnel or the deployed app), e.g. https://x.trycloudflare.com */
	readonly VITE_PUBLIC_APP_URL?: string;
}
