// End-to-end from the CLI, the agent-gig flow (program v3.1):
//  1. the company funds a role and delegates it to the agent (its only signature),
//  2. the agent posts a SOURCING gig (30% holdback, 10% bond for unvouched scouts); the sourcer
//     delivers a candidate; the agent accepts (bond returned),
//  3. the agent posts an exclusive SCREENING_CALL gig for that candidate with subject_scout = sourcer
//     (separation of duties: the sourcer is refused), a second scout claims and delivers; the agent accepts,
//  4. the company ("Invite to interview") attests Advanced, releasing the sourcing holdback.
// The relayer pays every fee; the agent co-signs deliverables and claims as the role's gatekeeper. A vouched sourcer gets the 3-way split and posts no bond.
// Usage: CLUSTER=localnet pnpm e2e
// Don't burn the demo scouts' clean reputation on devnet; use throwaway keypairs:
//   SCOUT_KEYPAIR=/tmp/a.json SCREENER_KEYPAIR=/tmp/b.json VOUCH=1 CLUSTER=devnet pnpm e2e
// (VOUCH=1 registers a new sourcer under the demo operator.)
import { createHash } from "node:crypto";
import type { Address, KeyPairSigner } from "@solana/kit";
import { getMintToInstruction } from "@solana-program/token";
import {
	fetchMaybeScoutProfile,
	fetchOperator,
	fetchRoleVault,
	fetchScoutProfile,
	findRoleVaultPda,
	findScoutProfilePda,
	findSubmissionPda,
	findTaskPda,
	getAcceptSubmissionInstruction,
	getAttestOutcomeInstruction,
	getClaimTaskInstruction,
	getCreateRoleInstructionAsync,
	getCreateTaskInstructionAsync,
	getRegisterScoutInstructionAsync,
	getSubmitDeliverableInstructionAsync,
	Outcome,
	TaskType,
} from "../packages/shared/src/generated/index.ts";
import {
	ata,
	DEMO_AGENT_CAPS,
	DEMO_HOLDBACK,
	DEMO_ROLE,
	DEMO_TASK,
	explorerTx,
	formatUsdc,
	KEYPAIRS,
	loadKeypair,
	loadOrCreateKeypair,
	readDeployment,
	rpc,
	send,
	tokenBalance,
	USDC,
} from "./lib.mts";

const d = readDeployment();
const relayer = await loadKeypair(KEYPAIRS.relayer);
const mintAuthority = await loadKeypair(KEYPAIRS.deployer);
const company = await loadKeypair(KEYPAIRS.company);
const agent = await loadOrCreateKeypair(KEYPAIRS.agent);
const sourcer = await loadOrCreateKeypair(KEYPAIRS.scout);
const screener = await loadOrCreateKeypair(process.env.SCREENER_KEYPAIR ?? KEYPAIRS.scout2);
const companyAta = await ata(company.address, d.usdcMint);
const step = (label: string, sig: string) => console.log(`${label}\n  ${explorerTx(sig)}`);
const sha = (s: string) => createHash("sha256").update(s).digest();

// 1. Company funds the role and hands it to the agent.
const roleId = BigInt(Date.now());
const [roleVault] = await findRoleVaultPda({ company: company.address, roleId });
step(
	`create_role ${roleId}: 200 USDC, agent ${agent.address}`,
	await send(relayer, [
		await getCreateRoleInstructionAsync({
			payer: relayer,
			company,
			companyTokenAccount: companyAta,
			mint: d.usdcMint,
			roleId,
			agent: agent.address,
			reviewWindowSeconds: DEMO_ROLE.reviewWindowSeconds,
			claimTimeoutSeconds: DEMO_ROLE.claimTimeoutSeconds,
			holdbackWindowSeconds: DEMO_HOLDBACK.windowSeconds,
			initialDeposit: 200n * USDC,
			agentMaxBounty: DEMO_AGENT_CAPS.maxBounty,
			agentMaxCommitment: DEMO_AGENT_CAPS.maxCommitment,
		}),
	]),
);
const vaultTokenAccount = (await fetchRoleVault(rpc, roleVault)).data.vaultTokenAccount;

type TaskSpec = {
	taskType: TaskType;
	bounty: bigint;
	max: number;
	exclusive: boolean;
	subjectScout?: Address;
	minAccepted?: number;
	bondBps?: number;
	holdbackBps?: number;
};
async function createTask(taskId: number, t: TaskSpec) {
	const [task] = await findTaskPda({ roleVault, taskId });
	step(
		`create_task #${taskId} ${TaskType[t.taskType]}: ${formatUsdc(t.bounty)} x ${t.max}${t.exclusive ? ", exclusive" : ""}${t.subjectScout ? ", not for the sourcer" : ""} (agent signs)`,
		await send(relayer, [
			await getCreateTaskInstructionAsync({
				payer: relayer,
				authority: agent,
				roleVault,
				task,
				vaultTokenAccount,
				taskId,
				taskType: t.taskType,
				bounty: t.bounty,
				maxDeliverables: t.max,
				exclusive: t.exclusive,
				briefHash: sha(`brief ${roleId} ${taskId}`),
				holdbackBps: t.holdbackBps ?? 0,
				subjectScout: t.subjectScout ?? null,
				minAccepted: t.minAccepted ?? 0,
				minAcceptRateBps: 0,
				bondBps: t.bondBps ?? 0,
				confirmationAttestor: null, // null = whoever is role.agent when settling
			}),
		]),
	);
	return task;
}

async function ensureProfile(scout: KeyPairSigner, vouch: boolean, label: string) {
	const [profile] = await findScoutProfilePda({ scout: scout.address });
	if (!(await fetchMaybeScoutProfile(rpc, profile)).exists) {
		step(
			`register_scout ${label}${vouch ? ` (vouched by ${d.operator?.name})` : ""}`,
			await send(relayer, [
				await getRegisterScoutInstructionAsync({
					payer: relayer,
					scout,
					mint: d.usdcMint,
					...(vouch && d.operator
						? { operator: d.operator.address, operatorAuthority: await loadKeypair(KEYPAIRS.operator) }
						: {}),
				}),
			]),
		);
	}
	const data = (await fetchScoutProfile(rpc, profile)).data;
	const operator = data.operator.__option === "Some" ? data.operator.value : undefined;
	const operatorTokenAccount = operator ? (await fetchOperator(rpc, operator)).data.tokenAccount : undefined;
	return { profile, operator, operatorTokenAccount, tokenAccount: await ata(scout.address, d.usdcMint) };
}

const src = await ensureProfile(sourcer, process.env.VOUCH === "1", "(sourcer)");
const scr = await ensureProfile(screener, false, "(screener)");
// An unvouched sourcer posts a bond: make sure they hold enough test USDC for it.
if (!src.operator && (await tokenBalance(src.tokenAccount)) < USDC) {
	await send(relayer, [
		getMintToInstruction({ mint: d.usdcMint, token: src.tokenAccount, mintAuthority, amount: USDC }),
	]);
}

async function deliverAndAccept(
	task: Address,
	scout: KeyPairSigner,
	who: Awaited<ReturnType<typeof ensureProfile>>,
	deliverable: Uint8Array,
	evidence: Uint8Array,
	label: string,
) {
	const before = await tokenBalance(who.tokenAccount);
	step(
		`submit_deliverable (${label})`,
		await send(relayer, [
			await getSubmitDeliverableInstructionAsync({
				payer: relayer,
				scout,
				gatekeeper: agent,
				roleVault,
				task,
				vaultTokenAccount,
				scoutTokenAccount: who.tokenAccount,
				mint: d.usdcMint,
				deliverableHash: deliverable,
				evidenceHash: evidence,
			}),
		]),
	);
	const bond = before - (await tokenBalance(who.tokenAccount));
	if (bond > 0n) console.log(`  bond posted: ${formatUsdc(bond)}`);
	const [submission] = await findSubmissionPda({ task, deliverableHash: deliverable });
	step(
		"accept_submission (agent signs)",
		await send(relayer, [
			getAcceptSubmissionInstruction({
				payer: relayer,
				authority: agent,
				config: d.config,
				roleVault,
				task,
				submission,
				scoutProfile: who.profile,
				vaultTokenAccount,
				scoutTokenAccount: who.tokenAccount,
				treasuryTokenAccount: d.treasuryTokenAccount,
				operator: who.operator,
				operatorTokenAccount: who.operatorTokenAccount,
				mint: d.usdcMint,
				reviewHash: sha(`agent review of ${label} ${roleId}`), // off-chain review text, hashed
			}),
		]),
	);
	console.log(`  ${label}: +${formatUsdc((await tokenBalance(who.tokenAccount)) - before)} net now`);
	return submission;
}

// 2. Sourcing gig.
const sourcerStart = await tokenBalance(src.tokenAccount);
const screenerStart = await tokenBalance(scr.tokenAccount);
const sourcing = await createTask(0, {
	taskType: TaskType.Sourcing,
	bounty: 5n * USDC,
	max: 20,
	exclusive: false,
	bondBps: DEMO_TASK.sourcingBondBps,
	holdbackBps: DEMO_HOLDBACK.bps,
});
const candidate = sha(`e2e-salt-${roleId}linkedin.com/in/karolina-mazurek`);
const sourced = await deliverAndAccept(sourcing, sourcer, src, candidate, new Uint8Array(32), "candidate");

// 3. Exclusive screening-call gig for that candidate: the sourcer may not take it.
const screening = await createTask(1, {
	taskType: TaskType.ScreeningCall,
	bounty: 35n * USDC,
	max: 1,
	exclusive: true,
	subjectScout: sourcer.address,
});
try {
	await send(relayer, [
		getClaimTaskInstruction({
			payer: relayer,
			scout: sourcer,
			gatekeeper: agent,
			scoutProfile: src.profile,
			roleVault,
			task: screening,
		}),
	]);
	throw new Error("the sourcer was able to claim their own candidate's screening");
} catch (e) {
	if ((e as Error).message.startsWith("the sourcer")) throw e;
	console.log("claim_task by the sourcer: refused (SelfReview), as expected");
}
step(
	"claim_task (screener)",
	await send(relayer, [
		getClaimTaskInstruction({
			payer: relayer,
			scout: screener,
			gatekeeper: agent,
			scoutProfile: scr.profile,
			roleVault,
			task: screening,
		}),
	]),
);
await deliverAndAccept(
	screening,
	screener,
	scr,
	sha(`call ${roleId} karolina`),
	sha("answers to the agent's script"),
	"call notes",
);

// 4. Hanna invites the candidate to interview: Advanced releases the sourcing holdback.
step(
	"attest_outcome Advanced (company; releases the holdback)",
	await send(relayer, [
		getAttestOutcomeInstruction({
			payer: relayer,
			authority: company,
			roleVault,
			task: sourcing,
			submission: sourced,
			scoutProfile: src.profile,
			vaultTokenAccount,
			scoutTokenAccount: src.tokenAccount,
			companyTokenAccount: companyAta,
			operator: src.operator,
			mint: d.usdcMint,
			outcome: Outcome.Advanced,
			reasonCode: 0,
		}),
	]),
);

const sourcerEarned = (await tokenBalance(src.tokenAccount)) - sourcerStart;
const screenerEarned = (await tokenBalance(scr.tokenAccount)) - screenerStart;
console.log(`sourcer earned ${formatUsdc(sourcerEarned)}, screener earned ${formatUsdc(screenerEarned)}`);
// 5 USDC after 10% fee (and a 10% operator cut when vouched); bonds net to zero. 35 USDC after 10% fee.
const expectedSourcer = src.operator ? 4_050_000n : 4_500_000n;
if (sourcerEarned !== expectedSourcer || screenerEarned !== 31_500_000n)
	throw new Error("unexpected payouts");
