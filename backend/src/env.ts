import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const expandHome = (p: string) => (p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : resolve(p));

const cluster = process.env.CLUSTER ?? "devnet";
const defaultRpc: Record<string, string> = {
	devnet: "https://api.devnet.solana.com",
	localnet: "http://127.0.0.1:8899",
};

export const env = {
	repoRoot,
	port: Number(process.env.PORT ?? 8788),
	host: process.env.HOST ?? "0.0.0.0",
	corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173").split(","),
	/** Unset → embedded PGlite in backend/.data (no Docker needed). */
	databaseUrl: process.env.DATABASE_URL || null,
	pgliteDir: resolve(repoRoot, "backend/.data/pglite"),
	cluster,
	rpcUrl: process.env.RPC_URL ?? defaultRpc[cluster] ?? defaultRpc.devnet,
	/** Defaults to the RPC URL with ws(s) scheme; Surfpool/validator use port+1 for websockets. */
	wsUrl:
		process.env.WS_URL ??
		(cluster === "localnet"
			? "ws://127.0.0.1:8900"
			: (process.env.RPC_URL ?? defaultRpc[cluster] ?? defaultRpc.devnet).replace(/^http/, "ws")),
	relayerKeypairPath: expandHome(process.env.RELAYER_KEYPAIR ?? "~/.config/solana/id.json"),
	/** The agent's key (role.agent on agent-run roles). */
	agentKeypairPath: expandHome(process.env.AGENT_KEYPAIR ?? "~/.config/solana/superrecruiter/agent.json"),
	/** Demo knobs for agent-run roles. */
	claimTimeoutSeconds: Number(process.env.CLAIM_TIMEOUT_SECONDS ?? 600),
	agentTickMs: Number(process.env.AGENT_TICK_MS ?? 4000),
	/** v3.1 gig gates (demo-friendly defaults; demo personas must stay eligible). */
	minAcceptedForCalls: Number(process.env.MIN_ACCEPTED_CALLS ?? 0),
	sourcingBondBps: Number(process.env.SOURCING_BOND_BPS ?? 1000),
	/** v3.2: min acceptance rate (bps) for screening/reference claims; 0 keeps demo personas eligible. */
	minAcceptRateBpsForCalls: Number(process.env.MIN_ACCEPT_RATE_BPS_CALLS ?? 0),
	/** v3.2: caps the company gives its agent on-chain (USDC base units); default commitment = the whole budget. */
	agentMaxBounty: BigInt(Math.round(Number(process.env.AGENT_MAX_BOUNTY_USD ?? 100) * 1_000_000)),
	/** Paid from the role budget when the notetaker proves the recruiter showed up and the candidate didn't. */
	showUpFee: BigInt(Math.round(Number(process.env.SHOW_UP_FEE_USD ?? 5) * 1_000_000)),
	deploymentPath: expandHome(process.env.DEPLOYMENT_FILE ?? resolve(repoRoot, `deployments/${cluster}.json`)),
	/** Anchor IDL. First existing path wins. */
	idlPaths: [
		process.env.IDL_PATH,
		resolve(repoRoot, "packages/shared/src/idl/scout.json"),
		resolve(repoRoot, "target/idl/scout.json"),
	].filter((p): p is string => Boolean(p)),
	/** Default holdback for new roles (CreateRoleRequest can override). Demo: 30% for 120 s. */
	holdbackBps: Number(process.env.HOLDBACK_BPS ?? 3000),
	/**
	 * 14 days in production. DEMO_FAST: 3 hours (a role prepared at 08:00 still holds parts at 09:30), long enough that "Came to the interview" (not the timer) is
	 * what releases it during the live demo.
	 */
	holdbackWindowSeconds: Number(
		process.env.HOLDBACK_WINDOW_SECONDS ?? (process.env.DEMO_FAST === "1" ? 3 * 3600 : 14 * 24 * 3600),
	),
	/**
	 * Floors for roles run by Scout's agent. The agent can only reject within the review window, so a candidate's
	 * "yes" (interest, or "the call happened") must arrive inside it: 24 h in production, 20 min in DEMO_FAST.
	 */
	/**
	 * How long a fresh (or edited) delivery waits before Scout's agent reviews it, so the recruiter can still edit
	 * or withdraw it. 5 min in production, 30 s with DEMO_FAST; REVIEW_GRACE_SECONDS=0 turns it off (e2e).
	 */
	reviewGraceSeconds: Number(process.env.REVIEW_GRACE_SECONDS ?? (process.env.DEMO_FAST === "1" ? 30 : 300)),
	minReviewWindowSeconds: Number(
		process.env.MIN_REVIEW_WINDOW_SECONDS ?? (process.env.DEMO_FAST === "1" ? 1200 : 24 * 3600),
	),
	minHoldbackWindowSeconds: Number(
		process.env.MIN_HOLDBACK_WINDOW_SECONDS ?? (process.env.DEMO_FAST === "1" ? 3 * 3600 : 0),
	),
	/** Sign-In-With-Solana message fields (what the wallet shows the user). */
	/** The app, for links we hand out (candidate confirmation /c/<token>). */
	appUrl: (process.env.APP_URL ?? "http://localhost:5173").replace(/\/$/, ""),
	authDomain: process.env.AUTH_DOMAIN ?? "scout.app",
	authUri: process.env.AUTH_URI ?? "https://scout.app",
	indexerEnabled: process.env.INDEXER !== "off",
	pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 15_000),
};
