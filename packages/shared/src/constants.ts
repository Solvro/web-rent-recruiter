/** Working name. Rename the product here only. */
export const PROJECT_NAME = "Scout";

export const CLUSTER = "devnet" as const;
// Solscan reads through its own backend. Solana Explorer queries the public devnet RPC
// from the viewer's browser, which is rate-limited on shared networks (e.g. hackathon Wi-Fi).
export const EXPLORER_BASE = "https://solscan.io";
export const explorerTxUrl = (signature: string) => `${EXPLORER_BASE}/tx/${signature}?cluster=${CLUSTER}`;
export const solscanTxUrl = (signature: string) =>
	`https://solscan.io/tx/${signature}${CLUSTER === "devnet" ? "?cluster=devnet" : ""}`;
export const explorerAddressUrl = (address: string) =>
	`${EXPLORER_BASE}/account/${address}?cluster=${CLUSTER}`;

/** Mock USDC we mint on devnet. Labelled "USDC" in the UI. */
export const USDC_DECIMALS = 6;
export const USDC_UNIT = 10 ** USDC_DECIMALS;
export const toBaseUnits = (usdc: number) => BigInt(Math.round(usdc * USDC_UNIT));
export const fromBaseUnits = (base: bigint | number | string) => Number(BigInt(base)) / USDC_UNIT;

export const DEFAULT_FEE_BPS = 1000; // 10%
export const BPS_DENOMINATOR = 10_000;

/** Demo uses a short window so the auto-accept path is visible live. */
export const DEMO_REVIEW_WINDOW_SECONDS = 180;
export const DEFAULT_REVIEW_WINDOW_SECONDS = 72 * 60 * 60;

/**
 * PDA seeds. Must match programs/scout/src/constants.rs.
 * - Config:     ["config"]
 * - RoleVault:  ["role", company, roleId (u64 LE)]
 * - ScoutProfile: ["scout", scout]
 * - Task:       ["task", roleVault, taskId (u32 LE)]
 * - Submission: ["submission", task, deliverableHash (32 bytes)]
 * The vault token account is the associated token account of the RoleVault PDA.
 */
export const SEEDS = {
	/** v3.2: the Config PDA moved to a new seed. */
	config: "config_v2",
	role: "role",
	scout: "scout",
	submission: "submission",
	task: "task",
} as const;

/** On-chain reject reason codes (u8). */
export const REJECT_REASONS = {
	NOT_MATCHING: 0,
	NOT_INTERESTED: 1,
	ALREADY_IN_PIPELINE: 2,
	OTHER: 3,
} as const;
export type RejectReason = keyof typeof REJECT_REASONS;
export const REJECT_REASON_LABELS: Record<RejectReason, string> = {
	NOT_MATCHING: "Doesn't match the criteria",
	NOT_INTERESTED: "Candidate not interested",
	ALREADY_IN_PIPELINE: "Already in our pipeline",
	OTHER: "Other",
};
