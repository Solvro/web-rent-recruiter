/**
 * Builders for every Scout program instruction. Account addresses are derived here once and passed by IDL name,
 * so the program can name/order its accounts freely as long as names come from this vocabulary.
 */
import { type Address, address, type Instruction } from "@solana/kit";
import {
	cached,
	fetchProgramAccount,
	findAta,
	findConfigPda,
	findRoleVaultPda,
	findScoutProfilePda,
	findSubmissionPda,
	relayer,
	requireDeployment,
} from "./chain.ts";
import { buildScoutInstruction } from "./tx.ts";

type Ctx = {
	company?: Address;
	scout?: Address;
	roleVault?: Address;
	submission?: Address;
	authority?: Address;
};

async function accountsFor(ctx: Ctx): Promise<Record<string, Address | undefined>> {
	const d = requireDeployment();
	const mint = address(d.usdcMint);
	const payer = (await relayer()).address;
	const roleVaultAta = ctx.roleVault ? await findAta(ctx.roleVault, mint) : undefined;
	const companyAta = ctx.company ? await findAta(ctx.company, mint) : undefined;
	const scoutAta = ctx.scout ? await findAta(ctx.scout, mint) : undefined;
	const scoutProfile = ctx.scout ? await findScoutProfilePda(ctx.scout) : undefined;
	const treasuryAta = address(d.treasuryTokenAccount);
	return {
		payer,
		config: d.config ? address(d.config) : await findConfigPda(),
		mint,
		usdcMint: mint,
		treasury: address(d.treasury),
		treasuryTokenAccount: treasuryAta,
		treasuryAta,
		company: ctx.company,
		companyTokenAccount: companyAta,
		companyAta,
		scout: ctx.scout,
		scoutTokenAccount: scoutAta,
		scoutAta,
		scoutProfile,
		roleVault: ctx.roleVault,
		vaultTokenAccount: roleVaultAta,
		vault: roleVaultAta,
		vaultAta: roleVaultAta,
		submission: ctx.submission,
		authority: ctx.authority,
		caller: payer,
	};
}

export async function createRoleIx(p: {
	company: Address;
	roleId: bigint;
	bountyPerCandidate: bigint;
	maxCandidates: number;
	reviewWindowSeconds: number;
	initialDeposit: bigint;
	agent: Address | null;
}): Promise<{ ix: Instruction; roleVault: Address }> {
	const roleVault = await findRoleVaultPda(p.company, p.roleId);
	const accounts = await accountsFor({ company: p.company, roleVault });
	const ix = buildScoutInstruction(
		"create_role",
		{
			roleId: p.roleId,
			bountyPerCandidate: p.bountyPerCandidate,
			maxCandidates: p.maxCandidates,
			reviewWindowSeconds: BigInt(p.reviewWindowSeconds),
			initialDeposit: p.initialDeposit,
			agent: p.agent,
		},
		accounts,
	);
	return { ix, roleVault };
}

export async function topUpIx(company: Address, roleVault: Address, amount: bigint) {
	return buildScoutInstruction("top_up", { amount }, await accountsFor({ company, roleVault }));
}

export async function closeRoleIx(company: Address, roleVault: Address) {
	return buildScoutInstruction("close_role", {}, await accountsFor({ company, roleVault }));
}

export async function registerScoutIx(scout: Address) {
	return buildScoutInstruction("register_scout", {}, await accountsFor({ scout }));
}

export async function isScoutRegistered(scout: Address) {
	return cached(
		`registered:${scout}`,
		5_000,
		async () => (await fetchProgramAccount("ScoutProfile", await findScoutProfilePda(scout))) !== null,
	);
}

export async function submitCandidateIx(scout: Address, roleVault: Address, candidateHash: Uint8Array) {
	const submission = await findSubmissionPda(roleVault, candidateHash);
	const ix = buildScoutInstruction(
		"submit_candidate",
		{ candidateHash },
		await accountsFor({ scout, roleVault, submission }),
	);
	return { ix, submission };
}

export async function acceptIx(p: {
	authority: Address;
	company: Address;
	scout: Address;
	roleVault: Address;
	submission: Address;
}) {
	return buildScoutInstruction("accept_submission", {}, await accountsFor(p));
}

export async function rejectIx(p: {
	company: Address;
	scout: Address;
	roleVault: Address;
	submission: Address;
	reasonCode: number;
}) {
	return buildScoutInstruction("reject_submission", { reasonCode: p.reasonCode }, await accountsFor(p));
}

export async function settleExpiredIx(p: {
	company: Address;
	scout: Address;
	roleVault: Address;
	submission: Address;
}) {
	return buildScoutInstruction("settle_expired", {}, await accountsFor(p));
}
