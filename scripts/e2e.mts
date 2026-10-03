// End-to-end from the CLI (milestone M2): create role, register scout, submit, accept.
// The deployer acts as the relayer (fee payer); company and scout only sign as authorities.
// Usage: CLUSTER=localnet pnpm e2e
import { createHash } from "node:crypto";
import {
	fetchMaybeScoutProfile,
	fetchRoleVault,
	findRoleVaultPda,
	findScoutProfilePda,
	findSubmissionPda,
	getAcceptSubmissionInstruction,
	getCreateRoleInstructionAsync,
	getRegisterScoutInstructionAsync,
	getSubmitCandidateInstructionAsync,
} from "../packages/shared/src/generated/index.ts";
import {
	ata,
	explorerTx,
	formatUsdc,
	KEYPAIRS,
	loadKeypair,
	readDeployment,
	rpc,
	send,
	tokenBalance,
	USDC,
} from "./lib.mts";

const d = readDeployment();
const relayer = await loadKeypair(KEYPAIRS.deployer);
const company = await loadKeypair(KEYPAIRS.company);
const scout = await loadKeypair(KEYPAIRS.scout);
const scoutAta = await ata(scout.address, d.usdcMint);
const step = (label: string, sig: string) => console.log(`${label}\n  ${explorerTx(sig)}`);

const roleId = BigInt(Date.now());
const [roleVault] = await findRoleVaultPda({ company: company.address, roleId });
step(
	`create_role ${roleId}: 20 USDC bounty, 200 USDC deposit`,
	await send(relayer, [
		await getCreateRoleInstructionAsync({
			payer: relayer,
			company,
			companyTokenAccount: await ata(company.address, d.usdcMint),
			mint: d.usdcMint,
			roleId,
			bountyPerCandidate: 20n * USDC,
			maxCandidates: 10,
			reviewWindowSeconds: 60n,
			initialDeposit: 200n * USDC,
			agent: null,
		}),
	]),
);

const [scoutProfile] = await findScoutProfilePda({ scout: scout.address });
if (!(await fetchMaybeScoutProfile(rpc, scoutProfile)).exists) {
	step(
		"register_scout",
		await send(relayer, [
			await getRegisterScoutInstructionAsync({ payer: relayer, scout, mint: d.usdcMint }),
		]),
	);
}

const candidateHash = createHash("sha256").update(`e2e-salt-${roleId}linkedin.com/in/ada-lovelace`).digest();
const role = await fetchRoleVault(rpc, roleVault);
step(
	"submit_candidate",
	await send(relayer, [
		await getSubmitCandidateInstructionAsync({
			payer: relayer,
			scout,
			roleVault,
			vaultTokenAccount: role.data.vaultTokenAccount,
			candidateHash,
		}),
	]),
);

const before = await tokenBalance(scoutAta);
const [submission] = await findSubmissionPda({ roleVault, candidateHash });
step(
	"accept_submission",
	await send(relayer, [
		getAcceptSubmissionInstruction({
			payer: relayer,
			authority: company,
			config: d.config,
			roleVault,
			submission,
			scoutProfile,
			vaultTokenAccount: role.data.vaultTokenAccount,
			scoutTokenAccount: scoutAta,
			treasuryTokenAccount: d.treasuryTokenAccount,
			mint: d.usdcMint,
		}),
	]),
);
const after = await tokenBalance(scoutAta);
console.log(`scout balance ${formatUsdc(before)} -> ${formatUsdc(after)} (+${formatUsdc(after - before)})`);
if (after - before !== 18n * USDC) throw new Error("unexpected payout");
