/**
 * End-to-end check of Scout as a protocol: a role reviewed by the company's OWN agent key (not the hosted one),
 * then by the company itself. Everything goes through the public tRPC API (agent.*, tx.submitForCosign,
 * gatekeeper.*), like a self-hosted `scout-agent` would use it.
 *
 *   NODE_OPTIONS=--experimental-eventsource API=http://localhost:8789 \
 *     pnpm --filter @scout/backend exec tsx --env-file=.env src/scripts/e2e-protocol.ts
 *
 * Flow: company creates a role with reviewer = its own key K → hosted runner stays out → K signs in, reads
 * agent.config/roles/role, posts a sourcing gig itself (create_task + agent.gig.register) → a recruiter delivers
 * two candidates; each delivery waits in K's co-sign queue → K rejects one (signs reject_submission) and
 * pre-accepts the other → the candidate confirms → K accepts on-chain → company switches to manual review →
 * the next delivery waits in the company's gatekeeper queue.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { type Deliverable, toBaseUnits, type UnsignedTx } from "@scout/shared";
import {
	address,
	createKeyPairSignerFromBytes,
	generateKeyPairSigner,
	getBase64EncodedWireTransaction,
	getTransactionDecoder,
	type KeyPairSigner,
	partiallySignTransaction,
	signBytes,
} from "@solana/kit";
import {
	getCreateAssociatedTokenIdempotentInstruction,
	getTransferCheckedInstruction,
} from "@solana-program/token";
import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import superjson from "superjson";
import { canonical } from "../agent-runner/backend-ports.ts";
import { fetchProgramAccount, findAta, relayer, requireDeployment } from "../solana/chain.ts";
import { acceptIx, createTaskIx, rejectIx } from "../solana/scout.ts";
import { buildUnsignedTx, sendAsRelayer } from "../solana/tx.ts";
import type { AppRouter } from "../trpc/router.ts";

const API = `${process.env.API ?? "http://localhost:8789"}/trpc`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const load = async (p: string) =>
	createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(resolve(homedir(), p), "utf8"))));

function check(cond: unknown, what: string) {
	if (!cond) throw new Error(`check failed: ${what}`);
	console.log(`  ✓ ${what}`);
}
async function waitFor<T>(label: string, get: () => Promise<T | null | undefined | false>, timeout = 60_000) {
	const start = Date.now();
	for (;;) {
		const v = await get();
		if (v) {
			console.log(`  ✓ ${label} (${Math.round((Date.now() - start) / 1000)}s)`);
			return v;
		}
		if (Date.now() - start > timeout) throw new Error(`timed out waiting for: ${label}`);
		await sleep(1500);
	}
}
async function expectAppError(p: Promise<unknown>, codes: string[], what: string) {
	try {
		await p;
	} catch (err) {
		const code = err instanceof TRPCClientError ? (err.data?.appCode ?? err.data?.code) : null;
		if (code && codes.includes(code)) return console.log(`  ✓ ${what} (${code})`);
		throw err;
	}
	throw new Error(`${what}: expected ${codes.join("/")}`);
}

const makeClient = (token: string | null) =>
	createTRPCClient<AppRouter>({
		links: [
			httpBatchLink({
				url: API,
				transformer: superjson,
				headers: () => (token ? { authorization: `Bearer ${token}` } : {}),
			}),
		],
	});
type Client = ReturnType<typeof makeClient>;
const anon = makeClient(null);
async function signIn(signer: KeyPairSigner) {
	const { message } = await anon.auth.nonce.mutate({ wallet: signer.address });
	const signature = await signBytes(signer.keyPair.privateKey, new TextEncoder().encode(message));
	const { token } = await anon.auth.verify.mutate({
		wallet: signer.address,
		message,
		signature: Buffer.from(signature).toString("base64"),
	});
	return makeClient(token);
}
const sign = async (signers: KeyPairSigner[], wire: string) =>
	getBase64EncodedWireTransaction(
		await partiallySignTransaction(
			signers.map((s) => s.keyPair),
			getTransactionDecoder().decode(Buffer.from(wire, "base64")),
		),
	);
async function submit(client: Client, signers: KeyPairSigner[], unsigned: UnsignedTx) {
	const r = await client.tx.submit.mutate({ signedTx: await sign(signers, unsigned.transaction) });
	console.log(`  ✓ ${unsigned.summary}`);
	return r;
}

// ---- Setup ------------------------------------------------------------------------------------

const company = await load(".config/solana/superrecruiter/client.json");
const asCompany = await signIn(company);
const ownAgent = await generateKeyPairSigner();
const recruiter = await generateKeyPairSigner();
const [asAgent, asRecruiter] = await Promise.all([signIn(ownAgent), signIn(recruiter)]);
await asRecruiter.me.upsert.mutate({ kind: "scout", displayName: "E2E protocol recruiter" });
if (!(await asCompany.me.get.query()))
	await asCompany.me.upsert.mutate({
		kind: "company",
		displayName: "E2E company",
		companyName: "E2E test company",
	});
{
	const d = requireDeployment();
	const mint = address(d.usdcMint);
	const ata = await findAta(recruiter.address, mint);
	await sendAsRelayer(
		[
			getCreateAssociatedTokenIdempotentInstruction({
				payer: await relayer(),
				ata,
				owner: recruiter.address,
				mint,
			}),
			getTransferCheckedInstruction({
				source: await findAta(company.address, mint),
				mint,
				destination: ata,
				authority: company,
				amount: toBaseUnits(10),
				decimals: 6,
			}),
		],
		[company],
	);
	console.log("  ✓ funded the recruiter with $10 for bonds");
}

// ---- 1. The company brings its own agent ------------------------------------------------------

const created = await asCompany.roles.create.mutate({
	title: "Protocol test role",
	summary: "Reviewed by the company's own agent",
	jobDescription: "Senior Rust engineer for Solana programs.",
	criteria: JSON.parse(
		readFileSync(new URL("../agent/fixtures/criteria-senior-rust.json", import.meta.url), "utf8"),
	),
	taskType: "SOURCING",
	reviewWindowSeconds: 600,
	holdbackWindowSeconds: 600,
	holdbackBps: 0,
	deposit: toBaseUnits(40).toString(),
	reviewer: { mode: "custom", agentPubkey: ownAgent.address },
});
await submit(asCompany, [company], created.unsignedTx);
const roleId = created.roleId;
await sleep(5000);
check(
	(await asCompany.gigs.list.query({ roleId })).length === 0,
	"Scout's hosted agent leaves the role alone",
);

const config = await anon.agent.config.query();
check(
	config.programId && config.relayer,
	`agent.config is public (${config.cluster}, relayer ${config.relayer?.slice(0, 6)}…)`,
);
check(
	(await asAgent.agent.roles.query()).some((r) => r.roleId === roleId),
	"the own agent sees its role in agent.roles",
);
await expectAppError(asRecruiter.agent.role.query({ roleId }), ["FORBIDDEN"], "anyone else is refused");
const snapshot = await asAgent.agent.role.query({ roleId });
check(
	snapshot.title === "Protocol test role" && snapshot.gigs.length === 0,
	"agent.role returns the role snapshot",
);

// ---- 2. The agent posts its own gig -----------------------------------------------------------

const vault = await fetchProgramAccount<{ taskCount: number | bigint }>(
	"RoleVault",
	address(snapshot.roleVault),
);
const gig = {
	taskType: "SOURCING" as const,
	variant: "standard" as const,
	title: "Find Rust engineers (protocol test)",
	brief: "Senior Rust engineers with Solana program experience.",
	script: null,
	bounty: toBaseUnits(5).toString(),
	maxDeliverables: 4,
	exclusive: false,
	when: "now" as const,
	candidateId: null,
};
const briefHash = new Uint8Array(
	createHash("sha256")
		.update(canonical({ title: gig.title, brief: gig.brief, script: gig.script }))
		.digest(),
);
const { ix, task } = await createTaskIx({
	authority: ownAgent.address,
	roleVault: address(snapshot.roleVault),
	taskId: Number(vault?.taskCount ?? 0),
	type: "SOURCING",
	bounty: BigInt(gig.bounty),
	maxDeliverables: gig.maxDeliverables,
	exclusive: false,
	briefHash,
	holdbackBps: 0,
	bondBps: 1000,
});
const posted = await submit(asAgent, [ownAgent], await buildUnsignedTx([ix], `Agent posts "${gig.title}"`));
const { gigId } = await asAgent.agent.gig.register.mutate({
	roleId,
	taskAddress: task,
	signature: posted.signature,
	gig,
});
check(gigId, "agent.gig.register verified the Task on-chain and opened the gig");
await expectAppError(
	asAgent.agent.gig.register.mutate({
		roleId,
		taskAddress: task,
		signature: posted.signature,
		gig: { ...gig, brief: "x" },
	}),
	["BRIEF_MISMATCH"],
	"a brief that doesn't match brief_hash is refused",
);

// ---- 3. Deliveries wait for the agent's co-signature ------------------------------------------

const candidate = (name: string): Deliverable => ({
	type: "SOURCING",
	name,
	profileUrl: `https://linkedin.com/in/e2e-${randomBytes(4).toString("hex")}`,
	notes: `${name}: 7 years of Rust, shipped two Anchor programs.`,
	consent: true,
	candidate: { currentTitle: "Rust engineer", location: "Warsaw" },
});
async function deliverViaQueue(
	asGatekeeper: Client,
	gatekeeper: KeyPairSigner,
	name: string,
	queue: "agent" | "company",
) {
	const r = await asRecruiter.gigs.deliver.mutate({ gigId, deliverable: candidate(name) });
	check(
		r.unsignedTx.cosigner === gatekeeper.address,
		`${name}: the delivery needs the ${queue}'s co-signature`,
	);
	const signed = await sign([recruiter], r.unsignedTx.transaction);
	await expectAppError(
		asRecruiter.tx.submit.mutate({ signedTx: signed }),
		["RELAYER_POLICY"],
		"the relayer won't send it without that signature",
	);
	const { pendingId } = await asRecruiter.tx.submitForCosign.mutate({ signedTx: signed });
	const list =
		queue === "agent"
			? () => asGatekeeper.agent.cosign.list.query({ roleId })
			: () => asGatekeeper.gatekeeper.pending.query({ roleId });
	const item = (await list()).find((p) => p.id === pendingId);
	check(item?.kind === "deliver", `it waits in the ${queue}'s co-sign queue`);
	const cosigned = await sign([gatekeeper], item?.transaction ?? "");
	if (queue === "agent") await asGatekeeper.agent.cosign.submit.mutate({ id: pendingId, signedTx: cosigned });
	else await asGatekeeper.gatekeeper.cosign.mutate({ id: pendingId, signedTx: cosigned });
	check(
		(await list()).every((p) => p.id !== pendingId),
		`the ${queue} co-signed it and the relayer sent it`,
	);
	return r.deliverableId;
}
const strongId = await deliverViaQueue(asAgent, ownAgent, "Ada Kowalczyk", "agent");
const weakId = await deliverViaQueue(asAgent, ownAgent, "Jan Weak", "agent");

const pending = await waitFor("agent.deliverables lists both", async () => {
	const d = await asAgent.agent.deliverables.query({ roleId });
	return d.length === 2 && d;
});
check(
	pending.every((d) => d.stage === "pending" && d.task === task),
	"both pending, with on-chain accounts to sign against",
);

// ---- 4. The agent decides, signing with its own key ---------------------------------------------

const ctx = (d: (typeof pending)[number]) => ({
	company: company.address,
	scout: address(d.scout),
	roleVault: address(snapshot.roleVault),
	task: address(d.task),
	submission: address(d.submission),
});
const weak = pending.find((d) => d.id === weakId);
if (!weak) throw new Error("weak deliverable missing");
await asAgent.agent.review.save.mutate({ deliverableId: weakId, review: { verdict: "reject", score: 20 } });
const reason = "Doesn't meet the must-haves.";
const rejected = await submit(
	asAgent,
	[ownAgent],
	await buildUnsignedTx(
		[await rejectIx({ ...ctx(weak), authority: ownAgent.address, reasonCode: 0, reasonText: reason })],
		"Agent rejects Jan Weak",
	),
);
await asAgent.agent.decision.mutate({
	deliverableId: weakId,
	action: "reject",
	reason,
	signature: rejected.signature,
});
const seen = await waitFor("the recruiter sees the rejection", async () => {
	const mine = await asRecruiter.gigs.mine.query();
	const d = mine.deliverables.find((d) => d.id === weakId);
	return d?.status === "REJECTED" && d;
});
check(seen.review?.reasons[0] === reason, `with the agent's own words: "${seen.review?.reasons[0]}"`);

await asAgent.agent.askRecruiter.mutate({ deliverableId: strongId, question: "Has Ada led an audit?" });
const asked = await asRecruiter.gigs.mine.query();
check(
	asked.deliverables.find((d) => d.id === strongId)?.followUps?.[0]?.question === "Has Ada led an audit?",
	"the recruiter sees the agent's follow-up question",
);
await asRecruiter.gigs.answerFollowUp.mutate({
	id: strongId,
	index: 0,
	answer: "Yes, two Anchor audits in 2025.",
});
check(
	(await asAgent.agent.deliverable.query({ deliverableId: strongId }))?.updatedAt,
	"the answer marks the deliverable updated for the agent",
);

await asAgent.agent.decision.mutate({
	deliverableId: strongId,
	action: "pre_accept",
	reason: "Strong Rust",
	signature: null,
});
const link = await waitFor("pre-accept sent the candidate a confirmation link", async () => {
	const mine = await asRecruiter.gigs.mine.query();
	return mine.deliverables.find((d) => d.id === strongId)?.confirmation?.url;
});
await anon.candidate.confirm.mutate({ token: link.split("/c/")[1] ?? "", interested: true });
const confirmed = await waitFor("agent.deliverable shows the candidate confirmed", async () => {
	const d = await asAgent.agent.deliverable.query({ deliverableId: strongId });
	return d?.stage === "candidate_confirmed" && d;
});
const review = "Candidate confirmed interest; strong Rust.";
const accepted = await submit(
	asAgent,
	[ownAgent],
	await buildUnsignedTx(
		[await acceptIx({ ...ctx(confirmed), authority: ownAgent.address, review })],
		"Agent pays the sourcer",
	),
);
await asAgent.agent.decision.mutate({
	deliverableId: strongId,
	action: "accept",
	reason: review,
	signature: accepted.signature,
});
await waitFor("the recruiter was paid", async () => {
	const mine = await asRecruiter.gigs.mine.query();
	return mine.deliverables.find((d) => d.id === strongId)?.status === "ACCEPTED";
});
check((await asAgent.agent.deliverables.query({ roleId })).length === 0, "nothing left for the agent");

// The agent asks the company something that isn't about a pending deliverable: it lands in the cockpit.
await asAgent.agent.escalate.mutate({
	roleId,
	deliverableId: null,
	candidateId: null,
	question: "Most profiles miss Solana experience. Should I widen to any Rust backend?",
	delivery: "now",
});
const inbox = (await asCompany.roles.status.query({ roleId })).waitingOn.find(
	(w) => w.who === "company" && w.actions?.some((x) => x.id === "acknowledge"),
);
check(Boolean(inbox), `the company sees the agent's question: "${inbox?.what}"`);
await asCompany.roles.ackEscalation.mutate({
	roleId,
	activityId: inbox?.actions?.find((x) => x.id === "acknowledge")?.activityId ?? "",
});
check(
	!(await asCompany.roles.status.query({ roleId })).waitingOn.some((w) => w.what === inbox?.what),
	'"Got it" clears it',
);

// ---- 5. The company reviews the role itself ----------------------------------------------------

const switched = await asCompany.roles.setReviewer.mutate({ roleId, mode: "self" });
await submit(asCompany, [company], switched.unsignedTx);
await expectAppError(asAgent.agent.role.query({ roleId }), ["FORBIDDEN"], "the old agent lost access");
const manualId = await deliverViaQueue(asCompany, company, "Ola Manual", "company");
const queue = await asCompany.deliverables.queue.query({ roleId });
check(queue.find((d) => d.id === manualId)?.awaiting === "decision", "it's in the company's review queue");
const why = "Not senior enough for this role yet.";
const rej = await asCompany.deliverables.decide.mutate({ id: manualId, decision: "reject", reasonText: why });
if (!rej.unsignedTx) throw new Error("expected a reject tx");
await submit(asCompany, [company], rej.unsignedTx);
const r1 = await waitFor("the recruiter sees the company's reason", async () => {
	const d = (await asRecruiter.gigs.mine.query()).deliverables.find((x) => x.id === manualId);
	return d?.status === "REJECTED" && d.review?.reasons[0] === why && d;
});
check(r1.appeal === null, "no appeal yet");

await asRecruiter.submissions.appeal.mutate({
	id: manualId,
	reason: "Ola led the protocol team at her last job for 3 years.",
});
await expectAppError(
	asRecruiter.submissions.appeal.mutate({ id: manualId, reason: "Second try at the same appeal" }),
	["ALREADY_APPEALED"],
	"one appeal per rejection",
);
check(
	(await asCompany.deliverables.queue.query({ roleId })).find((d) => d.id === manualId)?.awaiting ===
		"appeal",
	"the appeal shows up in the company's queue",
);
const before = BigInt((await asRecruiter.me.get.query())?.usdcBalance ?? "0");
const over = await asCompany.deliverables.decide.mutate({
	id: manualId,
	decision: "accept",
	reasonText: "Fair point, we missed that.",
});
if (!over.unsignedTx) throw new Error("expected an overturn transfer");
await submit(asCompany, [company], over.unsignedTx);
const settled = (await asRecruiter.gigs.mine.query()).deliverables.find((x) => x.id === manualId);
const after = BigInt((await asRecruiter.me.get.query())?.usdcBalance ?? "0");
check(
	settled?.appeal?.status === "OVERTURNED" &&
		settled.appeal.paid &&
		after - before === BigInt(settled.appeal.paid),
	`appeal overturned: the company paid the recruiter $${Number(after - before) / 1e6} directly`,
);

const selfId = await deliverViaQueue(asCompany, company, "Ewa Selfaccept", "company");
check(
	(await asCompany.deliverables.decide.mutate({ id: selfId, decision: "accept", reasonText: "Strong fit." }))
		.unsignedTx === null,
	"accepting a sourced candidate first asks the candidate (nothing to sign)",
);
const link2 = await waitFor(
	"confirmation link for the company's pre-accept",
	async () =>
		(await asRecruiter.gigs.mine.query()).deliverables.find((d) => d.id === selfId)?.confirmation?.url,
);
await anon.candidate.confirm.mutate({ token: link2.split("/c/")[1] ?? "", interested: true });
check(
	(await asCompany.deliverables.queue.query({ roleId })).find((d) => d.id === selfId)?.awaiting === "pay",
	"after the candidate said yes, the queue offers Accept and pay",
);
const pay = await asCompany.deliverables.decide.mutate({
	id: selfId,
	decision: "accept",
	reasonText: "Strong fit, candidate confirmed.",
});
if (!pay.unsignedTx) throw new Error("expected an accept tx");
await submit(asCompany, [company], pay.unsignedTx);
await waitFor(
	"the company paid the sourcer itself",
	async () =>
		(await asRecruiter.gigs.mine.query()).deliverables.find((d) => d.id === selfId)?.status === "ACCEPTED",
);
check(
	(await asCompany.gigs.list.query({ roleId })).length <= 1,
	"still no hosted-agent gigs: the company is the gatekeeper now",
);
// ---- 6. Backstop: the own agent goes offline after the candidate confirmed ---------------------------

const r2 = await asCompany.roles.create.mutate({
	title: "Protocol backstop role",
	summary: "Own agent goes offline",
	jobDescription: "Senior Rust engineer for Solana programs.",
	criteria: JSON.parse(
		readFileSync(new URL("../agent/fixtures/criteria-senior-rust.json", import.meta.url), "utf8"),
	),
	taskType: "SOURCING",
	reviewWindowSeconds: 240,
	holdbackWindowSeconds: 600,
	holdbackBps: 0,
	deposit: toBaseUnits(20).toString(),
	reviewer: { mode: "custom", agentPubkey: ownAgent.address },
});
await submit(asCompany, [company], r2.unsignedTx);
const snap2 = await waitFor("the second role is funded", async () => {
	const s = await asAgent.agent.role.query({ roleId: r2.roleId }).catch(() => null);
	return s?.roleVault ? s : null;
});
const gig2 = { ...gig, title: "Find Rust engineers (backstop test)" };
const { ix: ix2, task: task2 } = await createTaskIx({
	authority: ownAgent.address,
	roleVault: address(snap2.roleVault),
	taskId: 0,
	type: "SOURCING",
	bounty: BigInt(gig2.bounty),
	maxDeliverables: 4,
	exclusive: false,
	briefHash: new Uint8Array(
		createHash("sha256")
			.update(canonical({ title: gig2.title, brief: gig2.brief, script: null }))
			.digest(),
	),
	holdbackBps: 0,
	confirmationAttestor: config.confirmationAttestor ? address(config.confirmationAttestor) : null,
});
const posted2 = await submit(
	asAgent,
	[ownAgent],
	await buildUnsignedTx([ix2], `Agent posts "${gig2.title}"`),
);
const { gigId: gigId2 } = await asAgent.agent.gig.register.mutate({
	roleId: r2.roleId,
	taskAddress: task2,
	signature: posted2.signature,
	gig: gig2,
});
async function deliverAndCosign(name: string) {
	const r = await asRecruiter.gigs.deliver.mutate({ gigId: gigId2, deliverable: candidate(name) });
	const { pendingId } = await asRecruiter.tx.submitForCosign.mutate({
		signedTx: await sign([recruiter], r.unsignedTx.transaction),
	});
	const item = (await asAgent.agent.cosign.list.query({ roleId: r2.roleId })).find((p) => p.id === pendingId);
	await asAgent.agent.cosign.submit.mutate({
		id: pendingId,
		signedTx: await sign([ownAgent], item?.transaction ?? ""),
	});
	return r.deliverableId;
}
const confirmedId = await deliverAndCosign("Basia Backstop");
const silentId = await deliverAndCosign("Cezary Silent");
await asAgent.agent.decision.mutate({
	deliverableId: confirmedId,
	action: "pre_accept",
	reason: "Strong",
	signature: null,
});
const link3 = await waitFor(
	"confirmation link",
	async () =>
		(await asRecruiter.gigs.mine.query()).deliverables.find((d) => d.id === confirmedId)?.confirmation?.url,
);
await anon.candidate.confirm.mutate({ token: link3.split("/c/")[1] ?? "", interested: true });
console.log("    (the own agent now goes silent; waiting for the review deadline)");
await waitFor(
	"past the deadline, Scout settled the confirmed candidate as the task's attestor",
	async () =>
		(await asRecruiter.gigs.mine.query()).deliverables.find((d) => d.id === confirmedId)?.status ===
		"ACCEPTED",
	180_000,
);
await expectAppError(
	asRecruiter.submissions.settle.mutate({ id: silentId }),
	["NOT_CONFIRMED"],
	"an unconfirmed sourced candidate is never paid by silence",
);

console.log("\nprotocol e2e passed");
process.exit(0);
