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
	deploymentPath: expandHome(process.env.DEPLOYMENT_FILE ?? resolve(repoRoot, `deployments/${cluster}.json`)),
	/** Anchor IDL. First existing path wins. */
	idlPaths: [
		process.env.IDL_PATH,
		resolve(repoRoot, "packages/shared/src/idl/scout.json"),
		resolve(repoRoot, "target/idl/scout.json"),
	].filter((p): p is string => Boolean(p)),
	indexerEnabled: process.env.INDEXER !== "off",
	pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 15_000),
};
