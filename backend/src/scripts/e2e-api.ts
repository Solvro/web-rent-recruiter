/**
 * End-to-end check of an agent-run role (docs/agent-gigs.md) through the tRPC API, like the app uses it.
 *
 *   NODE_OPTIONS=--experimental-eventsource API=http://localhost:8788 \
 *     pnpm --filter @scout/backend exec tsx --env-file=.env src/scripts/e2e-api.ts
 *
 * Needs a running backend with the agent runner on, the demo company (~/.config/solana/superrecruiter/client.json)
 * funded with mock USDC. Recruiters are throwaway keypairs, so the demo recruiters stay clean.
 *
 * Flow: company funds the agent → agent posts a sourcing gig → recruiter A sources 3 candidates (+ a duplicate
 * from B is blocked) → agent reviews and pays → agent posts a screening gig with a script → B claims (C is
 * refused) and delivers answers → agent accepts → reference gig → C delivers → shortlist → company asks the
 * agent a question (streamed reply) → company invites the finalist (holdbacks released).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
	type Deliverable,
	fromBaseUnits,
	type GigView,
	type LiveEvent,
	toBaseUnits,
	type UnsignedTx,
} from "@scout/shared";
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
import {
	createTRPCClient,
	httpBatchLink,
	httpSubscriptionLink,
	splitLink,
	TRPCClientError,
} from "@trpc/client";
import superjson from "superjson";
import { findAta, relayer, requireDeployment } from "../solana/chain.ts";
import { sendAsRelayer } from "../solana/tx.ts";
import type { AppRouter } from "../trpc/router.ts";

const API = `${process.env.API ?? "http://localhost:8788"}/trpc`;
const TIMEOUT = Number(process.env.STEP_TIMEOUT_MS ?? 120_000);
const load = async (p: string) =>
	createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(resolve(homedir(), p), "utf8"))));
const fixture = (name: string) =>
	JSON.parse(readFileSync(new URL(`../agent/fixtures/${name}`, import.meta.url), "utf8")) as Record<
		string,
		string
	>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usd = (base: string | bigint) => `$${fromBaseUnits(base)}`;

function check(cond: boolean, what: string) {
	if (!cond) throw new Error(`check failed: ${what}`);
	console.log(`  ✓ ${what}`);
}

/** Poll until `get` returns a truthy value. */
async function waitFor<T>(
	label: string,
	get: () => Promise<T | null | undefined | false>,
	timeout = TIMEOUT,
) {
	const start = Date.now();
	for (;;) {
		const v = await get();
		if (v) {
			console.log(`  ✓ ${label} (${Math.round((Date.now() - start) / 1000)}s)`);
			return v;
		}
		if (Date.now() - start > timeout) throw new Error(`timed out waiting for: ${label}`);
		await sleep(2000);
	}
}

const makeClient = (token: string | null) =>
	createTRPCClient<AppRouter>({
		links: [
			splitLink({
				condition: (op) => op.type === "subscription",
				true: httpSubscriptionLink({
					url: API,
					transformer: superjson,
					connectionParams: token ? { token } : undefined,
				}),
				false: httpBatchLink({
					url: API,
					transformer: superjson,
					// Signed-out calls play the candidate's phone (a different device than the recruiters').
					headers: () =>
						token
							? { authorization: `Bearer ${token}` }
							: { "user-agent": "Mozilla/5.0 (iPhone; candidate)" },
				}),
			}),
		],
	});
const sessions = new Map<string, Client>();
/** Sign-In-With-Solana with the keypair, then a client that sends the session token. */
async function signIn(signer: KeyPairSigner) {
	const anonClient = makeClient(null);
	const { message } = await anonClient.auth.nonce.mutate({ wallet: signer.address });
	const signature = await signBytes(signer.keyPair.privateKey, new TextEncoder().encode(message));
	const { token } = await anonClient.auth.verify.mutate({
		wallet: signer.address,
		message,
		signature: Buffer.from(signature).toString("base64"),
	});
	const client = makeClient(token);
	sessions.set(signer.address, client);
	return client;
}
type Client = ReturnType<typeof makeClient>;
const anon = makeClient(null);

async function expectAppError(p: Promise<unknown>, appCode: string, what: string) {
	try {
		await p;
	} catch (err) {
		if (err instanceof TRPCClientError && err.data?.appCode === appCode) {
			if ((err.data as { stack?: string }).stack) throw new Error(`${what}: the error leaked a stack trace`);
			console.log(`  ✓ ${what} (${appCode})`);
			return err as TRPCClientError<AppRouter>;
		}
		throw err;
	}
	throw new Error(`${what}: expected ${appCode}`);
}

async function signAndSubmit(signers: KeyPairSigner[], unsigned: UnsignedTx | null) {
	if (!unsigned) return null;
	const tx = getTransactionDecoder().decode(Buffer.from(unsigned.transaction, "base64"));
	const signed = await partiallySignTransaction(
		signers.map((s) => s.keyPair),
		tx,
	);
	// The relayer only accepts transactions from a signed-in signer: submit with the first signer's session.
	const client = sessions.get(signers[0]?.address ?? "") ?? anon;
	const r = await client.tx.submit.mutate({ signedTx: getBase64EncodedWireTransaction(signed) });
	console.log(`  ✓ ${unsigned.summary}\n    ${r.explorerUrl}`);
	return r;
}

// ---- Setup -----------------------------------------------------------------------------

const company = await load(".config/solana/superrecruiter/client.json");
const asCompany = await signIn(company);
const recruiters = await Promise.all([
	generateKeyPairSigner(),
	generateKeyPairSigner(),
	generateKeyPairSigner(),
]);
const [sourcer, screener, referee] = recruiters;
const [asSourcer, asScreener, asReferee] = (await Promise.all(recruiters.map(signIn))) as [
	Client,
	Client,
	Client,
];
for (const [i, c] of [asSourcer, asScreener, asReferee].entries()) {
	await c.me.upsert.mutate({ kind: "scout", displayName: `E2E recruiter ${"ABC"[i]}` });
}
if (!(await asCompany.me.get.query())) {
	await asCompany.me.upsert.mutate({
		kind: "company",
		displayName: "E2E company",
		companyName: "E2E test company",
	});
}
const balance = async (c: Client) => BigInt((await c.me.get.query())?.usdcBalance ?? "0");

// Screening/reference gigs require experienced recruiters (the agent co-signs only eligible claims).
// Give the throwaway screener/referee labelled demo history + skills, like the seeded personas.
{
	const { db, schema } = await import("../db/index.ts");
	for (const r of [screener, referee]) {
		await db.insert(schema.recruiterSkills).values([
			{ wallet: r.address, skill: "engineer:rust", source: "seeded" },
			{ wallet: r.address, skill: "tech-screener", source: "seeded" },
			{ wallet: r.address, skill: "lang:en:C2", source: "seeded" },
		]);
		await db.insert(schema.recruiterSeededStats).values([
			{ wallet: r.address, gigType: "SOURCING", accepted: 12, decided: 14, advanced: 3 },
			{ wallet: r.address, gigType: "SCREENING_CALL", accepted: 4, decided: 5, advanced: 2 },
		]);
	}
	console.log("  ✓ screener + referee given seeded demo history (eligible for calls)");
}

// v3.1: unvouched recruiters post a small bond per sourcing deliverable → give each throwaway recruiter $5.
{
	const d = requireDeployment();
	const mint = address(d.usdcMint);
	const payer = await relayer();
	const ixs = [];
	for (const r of recruiters) {
		const ata = await findAta(r.address, mint);
		ixs.push(
			getCreateAssociatedTokenIdempotentInstruction({ payer, ata, owner: r.address, mint }),
			getTransferCheckedInstruction({
				source: await findAta(company.address, mint),
				mint,
				destination: ata,
				authority: company,
				amount: toBaseUnits(20),
				decimals: 6,
			}),
		);
	}
	const { signature } = await sendAsRelayer(ixs, [company]);
	console.log(`  ✓ funded the recruiters with $20 each for bonds (${signature.slice(0, 8)}…)`);
}
console.log(`company USDC: ${usd(await balance(asCompany))}`);

const events: LiveEvent[] = [];
// As the company: agent chat / timeline events are company-only.
const sub = asCompany.events.subscribe(undefined, {
	onData: (e) => events.push(e),
	onError: (e) => console.warn(e),
});
const anonEvents: LiveEvent[] = [];
const anonSub = anon.events.subscribe(undefined, { onData: (e) => anonEvents.push(e) });

// ---- 1. The company hires the agent ----------------------------------------------------------

const jd = readFileSync(new URL("../agent/fixtures/demo-jd-senior-backend-ts.txt", import.meta.url), "utf8");
const draft = await asCompany.roles.draft.mutate({ jobDescription: jd });
const DEPOSIT = toBaseUnits(
	Number(process.env.BUDGET_USD ?? fixture("demo-role-senior-backend-ts.json").budgetUsd ?? 500),
);
const created = await asCompany.roles.create.mutate({
	title: draft.title,
	summary: draft.summary,
	jobDescription: jd,
	criteria: draft.criteria,
	taskType: "SOURCING",
	reviewWindowSeconds: Number(process.env.REVIEW_WINDOW ?? 300),
	holdbackWindowSeconds: Number(process.env.HOLDBACK_WINDOW ?? 600),
	holdbackBps: 3000,
	deposit: DEPOSIT.toString(),
});
await signAndSubmit([company], created.unsignedTx);
const roleId = created.roleId;

const gigsOf = (type: GigView["type"]) => asCompany.gigs.list.query({ roleId, type });
const sourcing = await waitFor("agent posted a sourcing gig", async () => (await gigsOf("SOURCING"))[0]);
{
	const r = await asCompany.roles.byId.query({ id: roleId });
	const floor = process.env.DEMO_FAST === "1" ? 1200 : 0;
	check(
		r.reviewWindowSeconds >= floor && r.holdbackWindowSeconds >= floor,
		`windows long enough for a candidate's yes and for "Came to the interview" (review ${r.reviewWindowSeconds}s, holdback ${r.holdbackWindowSeconds}s)`,
	);
}
console.log(`    "${sourcing.title}" · ${usd(sourcing.bounty)} × ${sourcing.maxDeliverables}`);

// ---- 2. Sourcing ----------------------------------------------------------------------------

const deliver = async (c: Client, signer: KeyPairSigner, gigId: string, deliverable: Deliverable) => {
	const r = await c.gigs.deliver.mutate({ gigId, deliverable });
	await signAndSubmit([signer], r.unsignedTx);
	return r.deliverableId;
};
const asCandidate = (f: Record<string, string>): Deliverable => ({
	type: "SOURCING",
	name: f.name,
	profileUrl: f.profileUrl,
	notes: f.notes,
	consent: true,
	candidate: {
		avatarUrl: f.avatarUrl,
		currentTitle: f.currentTitle,
		currentCompany: f.currentCompany,
		location: f.location,
	},
});
// E2E_ONLY=loop: the company in the loop: live "thinking" lines, a slow stage with one-click fixes.
if (process.env.E2E_ONLY === "loop") {
	const details = new Set<string>();
	const watch = setInterval(() => {
		void asCompany.roles.status.query({ roleId }).then((st) => {
			if (st.now.busy && st.now.detail) details.add(st.now.detail);
		});
	}, 250);
	const slow = await waitFor(
		"sourcing is slower than expected and the cockpit offers a raise",
		async () => {
			const st = await asCompany.roles.status.query({ roleId });
			const item = st.waitingOn.find((w) => w.gigId === sourcing.id && w.slow);
			return item?.actions?.find((x) => x.id === "raise_price") ? item : null;
		},
		240_000,
	);
	const raise = slow.actions?.find((x) => x.id === "raise_price");
	console.log(`    "${slow.what}" expected by ${slow.expectedBy} → ${raise?.label}`);
	const raised = await asCompany.roles.raiseGigPrice.mutate({
		gigId: sourcing.id,
		bounty: raise?.bounty ?? "0",
	});
	const after = await asCompany.gigs.byId.query({ id: raised.gigId });
	check(
		after.bounty === raise?.bounty &&
			after.status === "OPEN" &&
			after.priceHistory.length === 1 &&
			(await asCompany.gigs.byId.query({ id: sourcing.id })).status === "CLOSED",
		`price raised ${usd(sourcing.bounty)}→${usd(after.bounty)} (old task closed, new one open)`,
	);
	await expectAppError(
		asCompany.roles.raiseGigPrice.mutate({ gigId: raised.gigId, bounty: after.bounty }),
		"NOT_A_RAISE",
		"never lowers or repeats a price",
	);
	const pipe = (await asCompany.roles.status.query({ roleId })).pipeline;
	check(
		pipe.sourcingSlots === sourcing.maxDeliverables,
		`a raise keeps the slot count (${pipe.sourcingSlots})`,
	);
	const line = (await asCompany.roles.activity.query({ roleId })).items.find((i) => i.kind === "REPRICED");
	check(
		Boolean(line?.message.includes("more from your uncommitted budget")),
		`the raise says what it costs: "${line?.message}"`,
	);

	const k = await deliver(
		asSourcer,
		sourcer,
		raised.gigId,
		asCandidate(fixture("demo-candidate-1-strong-karolina.json")),
	);
	const pending = await waitFor("agent pre-accepted Karolina", async () => {
		const d = (await asSourcer.gigs.mine.query()).deliverables.find((x) => x.id === k);
		return d?.confirmation?.url ? d.confirmation : null;
	});
	const fresh = await asSourcer.candidate.resendConfirmation.mutate({ deliverableId: k });
	check(Boolean(fresh.url) && fresh.url !== pending.url, "the sourcer got a fresh confirmation link");
	await expectAppError(
		anon.candidate.view.query({ token: pending.url?.split("/c/")[1] ?? "" }),
		"LINK_NOT_FOUND",
		"the old link stopped working",
	);
	check(
		(await asCompany.candidate.resendConfirmation.mutate({ deliverableId: k })).url === null,
		"the company can trigger a new link but never sees it",
	);
	// The recruiter answers her own link from her own device: not paid automatically, the company decides.
	const third = await asSourcer.candidate.resendConfirmation.mutate({ deliverableId: k });
	await asSourcer.candidate.confirm.mutate({ token: third.url?.split("/c/")[1] ?? "", interested: true });
	const held = await waitFor("a same-device yes goes to the company", async () => {
		const st = await asCompany.roles.status.query({ roleId });
		return st.waitingOn.find((w) => w.deliverableId === k && w.who === "company") ?? null;
	});
	check(
		(await asSourcer.gigs.work.query({ deliverableId: k })).work.status === "PENDING",
		`not paid: "${held.what}"`,
	);
	const ok = await asCompany.deliverables.decide.mutate({
		id: k,
		decision: "accept",
		reasonText: "I called her myself.",
	});
	if (ok.unsignedTx) await signAndSubmit([company], ok.unsignedTx);
	await waitFor(
		"paid once the company accepted",
		async () => (await asSourcer.gigs.work.query({ deliverableId: k })).work.status === "ACCEPTED",
	);

	// A question to the agent never spends; a proposed change waits for Yes / No.
	const spentBefore = (await asCompany.roles.status.query({ roleId })).budget.committed;
	const { proposeChange } = await import("../api/proposals.ts");
	const yes = await proposeChange(roleId, {
		kind: "extra_sourcing",
		summary: "Open 5 more profile slots at $32 each ($160 from the reserve)?",
		input: { count: 5 },
	});
	const no = await proposeChange(roleId, {
		kind: "pause_gigs",
		summary: "Pause the screening calls?",
		input: { taskTypes: ["SCREENING_CALL"] },
	});
	const inbox = (await asCompany.roles.status.query({ roleId })).waitingOn.filter((w) =>
		w.actions?.some((a) => a.id === "approve_proposal"),
	);
	check(
		inbox.length === 2 && (await asCompany.roles.status.query({ roleId })).budget.committed === spentBefore,
		"the agent's proposals wait in the inbox; nothing is spent yet",
	);
	await asCompany.roles.decideProposal.mutate({ roleId, proposalId: no.proposalId, approve: false });
	const r = await asCompany.roles.decideProposal.mutate({
		roleId,
		proposalId: yes.proposalId,
		approve: true,
	});
	check(
		BigInt((await asCompany.roles.status.query({ roleId })).budget.committed) > BigInt(spentBefore),
		`Yes ran it ("${r.message}"), No changed nothing`,
	);
	await expectAppError(
		asCompany.roles.decideProposal.mutate({ roleId, proposalId: yes.proposalId, approve: true }),
		"ALREADY_DECIDED",
		"a proposal is answered once",
	);

	const before = (await asCompany.roles.byId.query({ id: roleId })).criteria;
	const target = before.mustHave.at(-1);
	const loosened = await asCompany.roles.loosenRequirement.mutate({ roleId, criterionId: target?.id ?? "" });
	const now = (await asCompany.roles.byId.query({ id: roleId })).criteria;
	check(
		!now.mustHave.some((c) => c.label === target?.label) &&
			now.niceToHave.some((c) => c.label === target?.label),
		`"${target?.label}" is a nice-to-have now (${loosened.rescoring} pending profiles re-scored)`,
	);
	clearInterval(watch);
	check(details.size > 0, `live thinking lines: ${[...details].slice(0, 4).join(" · ")}`);
	console.log("\nloop e2e passed");
	process.exit(0);
}

const strong = fixture("demo-candidate-1-strong-karolina.json");
const karolina = await deliver(asSourcer, sourcer, sourcing.id, asCandidate(strong));
await deliver(asSourcer, sourcer, sourcing.id, asCandidate(fixture("demo-candidate-2-medium-tomasz.json")));
await deliver(asSourcer, sourcer, sourcing.id, asCandidate(fixture("demo-candidate-3-weak-piotr.json")));
await expectAppError(
	asScreener.gigs.deliver.mutate({
		gigId: sourcing.id,
		deliverable: asCandidate(fixture("demo-candidate-4-duplicate-karolina.json")),
	}),
	"DUPLICATE_CANDIDATE",
	"duplicate candidate blocked, first recruiter keeps the credit",
);

const sourced = await waitFor("agent reviewed every sourced candidate", async () => {
	const mine = await asSourcer.gigs.mine.query();
	return mine.deliverables.length === 3 && mine.deliverables.every((d) => d.review)
		? mine.deliverables
		: null;
});
for (const d of sourced) {
	const name = d.deliverable.type === "SOURCING" ? d.deliverable.name : "";
	console.log(
		`    ${name}: ${d.review?.verdict} (${d.review?.candidateReview?.score ?? "-"}) ${d.status} · ${d.review?.reasons[0] ?? ""}`,
	);
}
// The agent may ask the sourcer one more fact (FOLLOW_UP): answer it and wait for the re-review.
for (const d of sourced.filter((x) => x.review?.verdict === "FOLLOW_UP" && x.status === "PENDING")) {
	const index = (d.followUps ?? []).findIndex((f) => !f.answer);
	check(
		index >= 0,
		`agent asked about ${d.deliverable.type === "SOURCING" ? d.deliverable.name : d.id}: "${d.followUps?.[index]?.question}"`,
	);
	await asSourcer.gigs.answerFollowUp.mutate({
		id: d.id,
		index,
		answer: "Built the liquidation engine for a lending protocol on Solana (2023-2024), ~$40M TVL.",
	});
	const re = await waitFor("agent re-reviewed after the answer", async () => {
		const x = (await asSourcer.gigs.mine.query()).deliverables.find((y) => y.id === d.id);
		return x && x.review?.verdict !== "FOLLOW_UP" && x.review ? x : null;
	});
	Object.assign(d, re);
}
// Escalated ones are the company's call: accept the borderline, reject the rest.
for (const d of sourced.filter((x) => x.review?.verdict === "ESCALATE" && x.status === "PENDING")) {
	const st = await asCompany.roles.status.query({ roleId });
	const queue = await asCompany.deliverables.queue.query({ roleId });
	check(
		st.waitingOn.some((w) => w.who === "company" && w.deliverableId === d.id) &&
			queue.some((q) => q.id === d.id && q.awaiting === "decision"),
		"an escalated candidate is in the company's cockpit and review queue",
	);
	const ok = (d.review?.candidateReview?.score ?? 0) >= 50;
	const r = await asCompany.submissions.decide.mutate(
		ok ? { id: d.id, decision: "accept" } : { id: d.id, decision: "reject", reasonCode: "NOT_MATCHING" },
	);
	await signAndSubmit([company], r.unsignedTx);
}
// Verification v2: the agent only pre-accepts; Karolina herself confirms through the recruiter's link.
const pre = sourced.find((d) => d.id === karolina);
check(
	pre?.status === "PENDING" && pre.confirmation?.status === "PENDING" && Boolean(pre.confirmation.url),
	"agent pre-accepted Karolina; the recruiter got a confirmation link (nothing paid yet)",
);
check((await balance(asSourcer)) <= toBaseUnits(20), "no payout before the candidate confirms");
check(
	!process.env.PUBLIC_APP_URL || Boolean(pre?.confirmation?.url?.startsWith(process.env.PUBLIC_APP_URL)),
	`the candidate's link uses the public app URL (${pre?.confirmation?.url?.split("/c/")[0]})`,
);
check(
	Date.parse(pre?.confirmation?.expiresAt ?? "0") - Date.now() >
		(process.env.DEMO_FAST === "1" ? 15 * 60_000 : 0),
	`the candidate has until ${pre?.confirmation?.expiresAt} to confirm`,
);
{
	// Piotr's rejection forfeited the sourcer's bond into the role: it's shown apart from the company's deposit.
	// The bond event and the vault's total_deposited land in separate updates: wait until both are in.
	const b = await waitFor("Piotr's forfeited bond recorded", async () => {
		const x = (await asCompany.roles.byId.query({ id: roleId })).budget;
		return BigInt(x.bondsForfeited ?? "0") > 0n && BigInt(x.deposited) === DEPOSIT ? x : null;
	});
	check(
		BigInt(b.deposited) === DEPOSIT,
		`budget: deposited ${usd(b.deposited)} (the company's), forfeited bonds ${usd(b.bondsForfeited ?? "0")} apart`,
	);
}
const token = pre?.confirmation?.url?.split("/c/")[1] ?? "";
const page = await anon.candidate.view.query({ token });
check(
	page.candidateFirstName === "Karolina" &&
		!JSON.stringify(page).includes("budget") &&
		page.status === "PENDING",
	`candidate page shows "${page.roleTitle}" at "${page.companyDescriptor}" (${page.salaryLabel ?? "no range"})`,
);
await anon.candidate.confirm.mutate({
	token,
	interested: true,
	availability: "Tue/Thu afternoons",
	timeZone: "Europe/Warsaw",
	contactEmail: "karolina.e2e@example.com",
});
check(
	(await anon.candidate.view.query({ token })).recruiterSlug !== undefined,
	"the candidate page links the recruiter's public profile",
);
await expectAppError(
	anon.candidate.confirm.mutate({ token, interested: false }),
	"ALREADY_ANSWERED",
	"a link answers only once",
);
await waitFor("Karolina confirmed → agent paid the sourcer", async () => {
	const d = (await asSourcer.gigs.mine.query()).deliverables.find((x) => x.id === karolina);
	return d?.status === "ACCEPTED" && d.confirmation?.status === "YES";
});
check((await balance(asSourcer)) > 0n, `sourcer was paid instantly (${usd(await balance(asSourcer))})`);

// ---- 3. Screening ---------------------------------------------------------------------------

const screening = await waitFor("agent booked a screening call with a script", async () =>
	(await gigsOf("SCREENING_CALL")).find((g) => g.candidate?.id === karolina && g.script?.length),
);
console.log(`    "${screening.title}" · ${usd(screening.bounty)} · ${screening.script?.length} questions`);

// E2E_ONLY=noshow: the candidate misses the screening twice → the gig closes (off- and on-chain), no penalty.
if (process.env.E2E_ONLY === "noshow") {
	await signAndSubmit([screener], (await asScreener.gigs.claim.mutate({ id: screening.id })).unsignedTx);
	// A rejected delivery can be sent again (even with the same notes): it gets a new on-chain Submission.
	const lazy = fixture("screening-lazy.json") as unknown as {
		answers: { questionId: string; answer: string }[];
	};
	const lazyDeliverable: Deliverable = {
		type: "SCREENING_CALL",
		answers: (screening.script ?? []).map((q, i) => ({
			questionId: q.id,
			answer: lazy.answers[i % lazy.answers.length]?.answer || "Good.",
		})),
		recommendation: "ADVANCE",
	};
	const firstTry = await deliver(asScreener, screener, screening.id, lazyDeliverable);
	await waitFor(
		"the agent rejected the lazy notes",
		async () =>
			(await asScreener.gigs.mine.query()).deliverables.find((d) => d.id === firstTry)?.status === "REJECTED",
	);
	await expectAppError(
		asScreener.gigs.deliver.mutate({ gigId: screening.id, deliverable: lazyDeliverable }),
		"NOT_CLAIMANT",
		"a rejection releases the call: take it again first",
	);
	await signAndSubmit([screener], (await asScreener.gigs.claim.mutate({ id: screening.id })).unsignedTx);
	const secondTry = await deliver(asScreener, screener, screening.id, lazyDeliverable);
	check(secondTry !== firstTry, "the same notes can be delivered again after a rejection");
	await waitFor(
		"the second try was decided too",
		async () =>
			(await asScreener.gigs.mine.query()).deliverables.find((d) => d.id === secondTry)?.status ===
			"REJECTED",
	);
	await signAndSubmit([screener], (await asScreener.gigs.claim.mutate({ id: screening.id })).unsignedTx);
	const statsBefore = (await asScreener.me.get.query())?.reputation;
	const first = await asScreener.gigs.noShow.mutate({ gigId: screening.id });
	check(first.noShows === 1 && first.status === "OPEN", `no-show 1: rescheduled, until ${first.deadline}`);
	const second = await asScreener.gigs.noShow.mutate({ gigId: screening.id });
	check(second.noShows === 2 && second.status === "CLOSED", "no-show 2: the gig closes");
	const { fetchProgramAccount, invalidateCached } = await import("../solana/chain.ts");
	const taskAddress = address(screening.taskAddress ?? "");
	await waitFor("the Task is closed on-chain too", async () => {
		invalidateCached(taskAddress);
		const t = await fetchProgramAccount<{ status: unknown }>("Task", taskAddress);
		return JSON.stringify(t?.status ?? "").includes("Closed");
	});
	check(!(await gigsOf("SCREENING_CALL")).some((g) => g.id === screening.id), "it's off the board");
	await expectAppError(
		asScreener.gigs.noShow.mutate({ gigId: screening.id }),
		"NO_OPEN_GIG",
		"a closed call takes no more no-shows",
	);
	check(
		JSON.stringify((await asScreener.me.get.query())?.reputation) === JSON.stringify(statsBefore),
		"the recruiter's reputation is unchanged",
	);
	const timeline = (await asCompany.roles.activity.query({ roleId })).items.map((i) => i.message);
	check(
		timeline.some((m) => m.includes("missed the call twice")),
		"the company's timeline says why",
	);
	console.log("\nno-show e2e passed");
	process.exit(0);
}
const publicView = await anon.gigs.byId.query({ id: screening.id });
check(
	publicView.redacted &&
		publicView.candidate?.name === null &&
		publicView.script === null &&
		!JSON.stringify(publicView).includes("Mazurek"),
	`before it's taken, the board shows only "${publicView.candidate?.summary.headline}, ${publicView.candidate?.summary.city}"`,
);
await expectAppError(
	asSourcer.gigs.deliver.mutate({
		gigId: screening.id,
		deliverable: {
			type: "SCREENING_CALL",
			answers: [{ questionId: "x", answer: "x" }],
			recommendation: "ADVANCE",
		},
	}),
	"NOT_CLAIMANT",
	"delivering without taking the gig is refused",
);
await signAndSubmit([screener], (await asScreener.gigs.claim.mutate({ id: screening.id })).unsignedTx);
await expectAppError(
	asReferee.gigs.claim.mutate({ id: screening.id }),
	"GIG_TAKEN",
	"a second recruiter can't take it",
);
const claimantView = await asScreener.gigs.byId.query({ id: screening.id });
check(
	!claimantView.redacted && claimantView.candidate?.name === "Karolina Mazurek",
	"the claimant sees the candidate and the script",
);
check(
	(await asReferee.gigs.byId.query({ id: screening.id })).redacted,
	"everyone else still sees the redacted gig",
);
check(
	claimantView.candidate?.availability === "Tue/Thu afternoons" &&
		(await asReferee.gigs.byId.query({ id: screening.id })).candidate?.availability == null,
	"the claimant sees when Karolina is available (from her confirmation page); others don't",
);
check(Boolean(claimantView.post?.mustHave.length), "the gig carries the job post");

/** Concrete, evidence-backed answers per topic (what the agent pays for), like a real screening call. */
const BANK: [RegExp, string][] = [
	[
		/typescript|type ?script|\bts\b/i,
		"7 years backend, the last 3 in TypeScript on Node.js. At Fleetline she migrated the tracking service from JavaScript to strict TypeScript (zod at the edges, no any), and reviews most backend PRs. She walked me through how she types WebSocket message envelopes with discriminated unions.",
	],
	[
		/stream|queue|websocket|real.?time|sse|event/i,
		"She designed and runs the WebSocket tracking service for 40k drivers: Node.js + ws, Redis pub/sub for fan-out, BullMQ for retries. She cut p95 delivery latency from 900 ms to 180 ms in Q2 by batching position updates, and explained backpressure handling when a client falls behind.",
	],
	[
		/on.?call|incident|production|reliab|outage/i,
		"She is on the on-call rotation (one week in five). Her last incident: Redis failover dropped 3% of socket sessions; she added reconnect with resume tokens and wrote the postmortem. MTTR on her pages is under 20 minutes.",
	],
	[
		/ai|agent|llm|tool.?call|model/i,
		"Built a side-project agent with tool calling on Cloudflare Workers (OpenAI function calling, 6 tools, durable objects for memory). Not in production at work yet, but she can explain evals and prompt-injection risks she ran into.",
	],
	[
		/motivat|why|leave|move|interest/i,
		"She wants to work closer to product and on AI features; Fleetline is consolidating into a platform team and her scope is shrinking. She was clearly excited about an agent runtime role and asked good questions about the team.",
	],
	[
		/salary|comp|pay|rate|expect|budget/i,
		"Expects 32k PLN/month on B2B, flexible to 30k for strong equity. That fits the 28-36k band.",
	],
	[
		/office|location|hybrid|warsaw|relocat|remote/i,
		"Lives in Warsaw (Mokotów), fine with 2 office days a week, no relocation needed.",
	],
	[/notice|start|availab|when/i, "One-month notice on B2B, could start in early November."],
	[
		/english|language|communicat/i,
		"Fluent English (C1), ran the call in English without trouble; presents at the internal tech guild monthly.",
	],
];
type FixtureCall = { answers: { questionId: string; answer: string }[]; transcript?: string };
const SCREENING = fixture("screening-karolina-good.json") as unknown as FixtureCall;
const REFERENCE = fixture("reference-karolina.json") as unknown as FixtureCall;
const LANGUAGE = fixture("language-karolina-english.json") as unknown as FixtureCall;
const words = (t: string) =>
	new Set(
		t
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((w) => w.length > 2 && !["the", "and", "you", "your", "what", "how", "for"].includes(w)),
	);
/** The fixture answer whose question id shares the most words with this script question. */
function fromFixture(f: FixtureCall, q: { id: string; question: string }) {
	const want = words(`${q.id} ${q.question}`);
	let best: { score: number; answer: string } | null = null;
	for (const a of f.answers) {
		const score = [...words(a.questionId)].filter((w) => want.has(w)).length;
		if (score > 0 && (!best || score > best.score)) best = { score, answer: a.answer };
	}
	return best?.answer;
}
const answerFrom = (f: FixtureCall) => (q: { id: string; question: string; whatGoodLooksLike?: string }) =>
	fromFixture(f, q) ?? answer(q);
const answer = (q: { id: string; question: string; whatGoodLooksLike?: string }) =>
	BANK.find(([re]) => re.test(`${q.id} ${q.question}`))?.[1] ??
	`On this, she gave a specific example from Fleetline: she owned the public API used by 120 customers, versioned it twice without breaking clients, and measured adoption per version. (${q.whatGoodLooksLike ?? ""})`;
const questions = screening.script ?? [];
await expectAppError(
	asScreener.gigs.deliver.mutate({
		gigId: screening.id,
		deliverable: {
			type: "SCREENING_CALL",
			answers: questions.slice(1).map((q) => ({ questionId: q.id, answer: answerFrom(SCREENING)(q) })),
			recommendation: "ADVANCE",
		},
	}),
	"INCOMPLETE_ANSWERS",
	"incomplete script is refused",
);
check(
	claimantView.candidate?.contact?.email === "karolina.e2e@example.com" &&
		(await asReferee.gigs.byId.query({ id: screening.id })).candidate?.contact == null,
	"the screener gets Karolina's contact from her confirmation; others don't",
);
const screeningId = await deliver(asScreener, screener, screening.id, {
	type: "SCREENING_CALL",
	answers: questions.map((q) => ({ questionId: q.id, answer: answerFrom(SCREENING)(q) })),
	recommendation: "ADVANCE",
	referee: { name: "Marek Nowicki", relation: "Her manager at Kelp Labs", contact: "marek@example.com" },
});
const screened = await waitFor("agent reviewed the screening notes", async () =>
	(await asScreener.gigs.mine.query()).deliverables.find((d) => d.id === screeningId && d.review),
);
console.log(`    verdict ${screened.review?.verdict}: ${screened.review?.reasons.slice(0, 2).join(" · ")}`);
if (screened.review?.verdict === "ESCALATE" && screened.status === "PENDING") {
	await signAndSubmit(
		[company],
		(await asCompany.submissions.decide.mutate({ id: screeningId, decision: "accept" })).unsignedTx,
	);
}
// Unrecorded call: the agent pre-accepts; the candidate confirms the call happened through the SOURCER's link.
const unpaid = await balance(asScreener);
const mineScreening = (await asScreener.gigs.mine.query()).deliverables.find((d) => d.id === screeningId);
check(
	mineScreening?.status === "PENDING" &&
		mineScreening.confirmation?.status === "PENDING" &&
		mineScreening.confirmation.url === null,
	"unrecorded call: nothing paid yet, and the screener never sees the candidate's link",
);
const callLink = await confirmCall(screeningId, { inspect: true });
check(Boolean(callLink), 'the sourcer got the candidate\'s "did the call happen?" link');
await waitFor(
	"screening paid after the candidate confirmed the call",
	async () =>
		(await asScreener.gigs.mine.query()).deliverables.find((d) => d.id === screeningId)?.status ===
		"ACCEPTED",
);
const paidNow = await waitFor(
	"the screener's balance went up",
	async () => {
		const b = await balance(asScreener);
		return b > unpaid ? b : null;
	},
	30_000,
);
console.log(`    screener ${usd(unpaid)}→${usd(paidNow)}`);
{
	const d = (await asScreener.gigs.mine.query()).deliverables.find((x) => x.id === screeningId);
	check(
		BigInt(d?.payout?.now ?? "0") > 0n && BigInt(d?.payout?.platformFee ?? "0") > 0n,
		`the screener's deliverable shows the real split (${usd(d?.payout?.now ?? "0")} now, ${usd(d?.payout?.later ?? "0")} later, fee ${usd(d?.payout?.platformFee ?? "0")})`,
	);
	const g = await waitFor(
		"the filled screening gig closes",
		async () => {
			const x = await asScreener.gigs.byId.query({ id: screening.id });
			return x.status === "CLOSED" ? x : null;
		},
		30_000,
	);
	check(!(await gigsOf("SCREENING_CALL")).some((x) => x.id === g.id), "and leaves the board");
}

const REF_BANK: [RegExp, string][] = [
	[
		/relation|know|work.*with|capacity|how long/i,
		"Marek was her engineering manager at Fleetline for two years (2023-2025) and did her performance reviews.",
	],
	[
		/strength|best|excel/i,
		"Ownership: she led the driver-tracking rewrite end to end (40k drivers, latency down 5x) and kept stakeholders informed weekly.",
	],
	[
		/weak|improv|grow|develop/i,
		"She can over-polish before shipping; she now timeboxes with a written cut line, which Marek saw work on the API v2 launch.",
	],
	[/rehire|again|recommend|hire/i, "Yes, without hesitation; he tried to bring her onto his new team."],
	[
		/pressure|incident|on.?call|deadline/i,
		"During the Black Friday Redis failover she ran the incident calmly, coordinated three engineers and restored service in 18 minutes.",
	],
	[
		/team|collab|mentor|conflict/i,
		"Mentored two junior engineers to mid level; resolves disagreements with short written proposals rather than long meetings.",
	],
];
const referenceAnswer = (q: { id: string; question: string }) =>
	REF_BANK.find(([re]) => re.test(`${q.id} ${q.question}`))?.[1] ??
	"He gave a concrete example: she owned the public API used by 120 customers and shipped two versions without breaking anyone.";

/**
 * An unrecorded call the agent (or company) pre-accepted: the candidate says yes through the sourcer's link.
 * Returns the link, or null if the call was decided without a check (recorded, rejected).
 */
async function confirmCall(deliverableId: string, opts: { inspect?: boolean } = {}) {
	const check2 = await waitFor(`call check for ${deliverableId.slice(0, 8)}`, async () => {
		const mine = await asScreener.gigs.mine.query();
		const d = mine.deliverables.find((x) => x.id === deliverableId);
		if (d && (d.status !== "PENDING" || !d.confirmation)) return { url: null };
		for (const s of (await asSourcer.gigs.mine.query()).deliverables)
			for (const c of s.callChecks ?? [])
				if (c.deliverableId === deliverableId && c.url) return { url: c.url };
		return null;
	});
	if (!check2.url) return null;
	const token = check2.url.split("/c/")[1] ?? "";
	if (opts.inspect) {
		const page = await anon.candidate.view.query({ token });
		check(
			page.kind === "call" && page.callWith === "E2E recruiter B",
			`candidate page asks: "Did you talk to ${page.callWith} (${page.callKind}) about ${page.roleTitle}?"`,
		);
	}
	await anon.candidate.confirm.mutate({ token, interested: true });
	return check2.url;
}

/** Take and deliver every open call gig the agent posted beyond Karolina's (e.g. a screening for Tomasz). */
const handled = new Set<string>();
async function clearOtherCalls(skip: string[]) {
	const open = [...(await gigsOf("SCREENING_CALL")), ...(await gigsOf("REFERENCE_CHECK"))].filter(
		(g) => g.status === "OPEN" && !skip.includes(g.id) && !handled.has(g.id) && g.slotsLeft > 0,
	);
	for (const g of open) {
		handled.add(g.id);
		if (!g.claimant)
			await signAndSubmit([screener], (await asScreener.gigs.claim.mutate({ id: g.id })).unsignedTx);
		const full = await asScreener.gigs.byId.query({ id: g.id });
		const fx = g.variant === "language" ? LANGUAGE : g.type === "REFERENCE_CHECK" ? REFERENCE : SCREENING;
		const answers = (full.script ?? []).map((q) => ({ questionId: q.id, answer: answerFrom(fx)(q) }));
		const deliverable: Deliverable =
			g.type === "REFERENCE_CHECK"
				? {
						type: "REFERENCE_CHECK",
						refereeName: "Marek Nowicki",
						refereeRelation: "CTO and co-founder of Kelp Labs, her manager for two years",
						answers,
						recommendation: "ADVANCE",
					}
				: {
						type: "SCREENING_CALL",
						answers,
						recommendation: g.variant === "language" ? "ADVANCE" : "MAYBE",
						...(g.variant === "language" && LANGUAGE.transcript ? { transcript: LANGUAGE.transcript } : {}),
					};
		const id = await deliver(asScreener, screener, g.id, deliverable);
		const d = await waitFor(
			`agent reviewed the ${g.type.toLowerCase()} for ${full.candidate?.name}`,
			async () => (await asScreener.gigs.mine.query()).deliverables.find((x) => x.id === id && x.review),
		);
		if (d.review?.verdict === "ESCALATE" && d.status === "PENDING")
			await signAndSubmit(
				[company],
				(await asCompany.submissions.decide.mutate({ id, decision: "accept" })).unsignedTx,
			);
		if (g.type === "SCREENING_CALL") await confirmCall(id);
	}
}

// ---- 4. Reference ---------------------------------------------------------------------------

const reference = await waitFor("agent posted a reference check", async () =>
	(await gigsOf("REFERENCE_CHECK")).find((g) => g.candidate?.id === karolina),
);
await signAndSubmit([referee], (await asReferee.gigs.claim.mutate({ id: reference.id })).unsignedTx);

// ---- Screening quality: time zones, no-show + show-up fee, a fake-candidate report ---------------------
await asReferee.me.upsert.mutate({
	kind: "scout",
	displayName: "E2E recruiter C",
	timeZone: "Europe/Lisbon",
});
const booked = await asReferee.gigs.byId.query({ id: reference.id });
check(
	booked.candidateTimeZone === "Europe/Warsaw" && booked.recruiterTimeZone === "Europe/Lisbon",
	"booking shows both time zones (candidate Europe/Warsaw, recruiter Europe/Lisbon)",
);
await asReferee.recall.invite.mutate({
	gigId: reference.id,
	meetingUrl: "https://meet.google.com/abc-defg-hij",
});
const joined = await waitFor("the notetaker joined the call", async () => {
	const r = await asReferee.recall.status.query({ gigId: reference.id });
	return r && ["in_call", "recording", "processing", "done"].includes(r.status) ? r : null;
});
check(
	joined.simulated === true && joined.statusText.startsWith("Demo recording (simulated)"),
	`a simulated recording says so: "${joined.statusText}"`,
);
check(
	(await asReferee.gigs.byId.query({ id: reference.id })).candidate?.referee?.name === "Marek Nowicki",
	"the reference caller sees the referee Karolina named on her screening",
);
const ns = await asReferee.gigs.noShow.mutate({ gigId: reference.id });
check(
	ns.noShows === 1 && ns.status === "OPEN" && ns.showUpFee !== null,
	`no-show 1: rescheduled until ${ns.deadline.slice(11, 16)} UTC, show-up fee ${usd(ns.showUpFee?.amount ?? "0")} offered`,
);
const refBefore = await balance(asReferee);
await signAndSubmit(
	[referee],
	(await asReferee.gigs.claimShowUpFee.mutate({ gigId: reference.id })).unsignedTx,
);
const paidFee = await asReferee.gigs.byId.query({ id: reference.id });
check(
	paidFee.showUpFee?.status === "PAID" && (await balance(asReferee)) > refBefore,
	`show-up fee paid from the role budget (${usd(refBefore)}→${usd(await balance(asReferee))})`,
);
check(
	!(await asReferee.gigs.mine.query()).deliverables.some((d) => d.gigTitle.startsWith("Show-up fee")) &&
		!(await gigsOf("SCREENING_CALL")).some((g) => g.title.startsWith("Show-up fee")),
	"the show-up fee task stays off the board and out of deliverables",
);
await expectAppError(
	asReferee.gigs.claimShowUpFee.mutate({ gigId: reference.id }),
	"ALREADY_PAID",
	"the fee is paid once",
);
await asReferee.gigs.report.mutate({
	gigId: reference.id,
	reason: "The referee didn't recognise the candidate's name.",
});
const held = await asReferee.gigs.byId.query({ id: reference.id });
const waiting = await asCompany.roles.status.query({ roleId });
check(
	held.reported === true &&
		held.status === "PAUSED" &&
		waiting.waitingOn.some((w) => w.what.includes("possibly fake")),
	"report puts the gig on hold and asks the company",
);
await asCompany.roles.dismissReport.mutate({ roleId, candidateId: karolina });
check(
	(await asReferee.gigs.byId.query({ id: reference.id })).status === "OPEN",
	"the company dismissed it; the call continues",
);
const referenceId = await deliver(asReferee, referee, reference.id, {
	type: "REFERENCE_CHECK",
	refereeName: "Marek Nowak",
	refereeRelation: "Engineering manager at Fleetline, managed Karolina for 2 years",
	answers: (reference.script ?? []).map((q) => ({
		questionId: q.id,
		answer: fromFixture(REFERENCE, q) ?? referenceAnswer(q),
	})),
	recommendation: "ADVANCE",
});
await expectAppError(
	asReferee.gigs.noShow.mutate({ gigId: reference.id }),
	"CALL_HAPPENED",
	"after sending notes, the call can't be marked a no-show",
);
const referenced = await waitFor("agent reviewed the reference", async () =>
	(await asReferee.gigs.mine.query()).deliverables.find((d) => d.id === referenceId && d.review),
);
console.log(
	`    verdict ${referenced.review?.verdict}: ${referenced.review?.reasons.slice(0, 2).join(" · ")}`,
);
check(
	!referenced.review?.reasons.some((x) => /too short|no usable answer/i.test(x)),
	"the recorded reference passes the duration check and every answer counts",
);
check(
	!referenced.review?.reasons.some((x) => (reference.script ?? []).some((q) => x.includes(q.id))),
	"review reasons never show internal question ids",
);
if (referenced.review?.verdict === "ESCALATE" && referenced.status === "PENDING") {
	await signAndSubmit(
		[company],
		(await asCompany.submissions.decide.mutate({ id: referenceId, decision: "accept" })).unsignedTx,
	);
}

// ---- 5. Shortlist + talking to the agent -----------------------------------------------------

const shortlist = await waitFor("shortlist ready with screening + reference", async () => {
	await clearOtherCalls([screening.id, reference.id]);
	const items = await asCompany.roles.shortlist.query({ roleId });
	const k = items.find((i) => i.candidateId === karolina);
	return k?.screening && k.reference ? items : null;
});
// ---- The company's candidates panel, one person in full, the ledger -----------------------------------
{
	const list = await asCompany.roles.candidates.query({ roleId });
	const k = list.find((c) => c.candidateId === karolina);
	check(
		k?.stage === "SHORTLISTED" && k.confirmed,
		`candidates panel: ${list.map((c) => `${c.name.split(" ")[0]} ${c.stage}`).join(", ")}`,
	);
	const detail = await asCompany.roles.candidate.query({ roleId, candidateId: karolina });
	const screen = detail.calls.find((c) => c.kind === "screening" && c.status === "ACCEPTED");
	const ref = detail.calls.find((c) => c.kind === "reference");
	check(
		Boolean(detail.review?.verdicts.length) &&
			detail.candidateAnswers?.availability === "Tue/Thu afternoons" &&
			detail.candidateAnswers.timeZone === "Europe/Warsaw" &&
			Boolean(screen?.questions.every((q) => q.question && q.answer)) &&
			Boolean(ref?.referee?.name && ref.transcript?.length) &&
			detail.payments.length >= 3 &&
			detail.payments.every((p) => p.signature),
		`Karolina in full: ${detail.review?.verdicts.length} verdicts, ${screen?.questions.length} screening Q→A, reference with ${ref?.transcript?.length} transcript lines, ${detail.payments.length} payments`,
	);
	check(ref?.recordingUrl === null, "RECALL_MOCK: no media URL (a live Recall bot returns a fresh one)");
	const note = await asCompany.candidates.addNote.mutate({
		candidateId: karolina,
		text: "Ask about the Kraków office.",
	});
	check(
		(await asCompany.roles.candidate.query({ roleId, candidateId: karolina })).notes.some(
			(n) => n.id === note.id,
		),
		"private company note added",
	);
	await asCompany.candidates.deleteNote.mutate({ noteId: note.id });
	check(
		!(await asCompany.roles.candidate.query({ roleId, candidateId: karolina })).notes.length,
		"and deleted",
	);
	await expectAppError(
		asScreener.roles.candidate.query({ roleId, candidateId: karolina }),
		"FORBIDDEN",
		"recruiters can't read the company's candidate file",
	);
	const ledger = await asCompany.roles.payments.query({ roleId });
	check(
		["sourcing", "screening", "reference", "show_up_fee"].every((k) => ledger.some((p) => p.kind === k)) &&
			ledger.every((p) => p.signature),
		`payments ledger: ${ledger.length} payments (${[...new Set(ledger.map((p) => p.kind))].join(", ")})`,
	);
	const work = await asScreener.gigs.work.query({ deliverableId: screeningId });
	check(
		work.kind === "screening" &&
			work.work.gigVariant === "standard" &&
			!work.editable &&
			Boolean(work.call?.questions.every((q) => q.answer)) &&
			Boolean(work.criteria?.mustHave.length),
		"My work: the screener sees their call in full (questions, answers, review, payout)",
	);
	await expectAppError(
		asReferee.gigs.work.query({ deliverableId: screeningId }),
		"FORBIDDEN",
		"only the recruiter who delivered it",
	);
	const me = await asScreener.me.get.query();
	const profile = await anon.scouts.profile.query({ wallet: screener.address });
	check(
		me?.earned === profile.reputation.totalEarned,
		`earnings and public profile agree (${usd(me?.earned ?? "0")})`,
	);
}

const cockpit = await asCompany.roles.status.query({ roleId });
const detail = await asCompany.roles.byId.query({ id: roleId });
check(
	cockpit.budget.available === detail.budget.available &&
		cockpit.waitingOn.some((w) => w.who === "company") &&
		cockpit.pipeline.confirmed >= 1 &&
		cockpit.pipeline.referenceDone >= 1,
	`cockpit: "${cockpit.now.text}", waiting on ${cockpit.waitingOn.map((w) => w.who).join("/")}, $${Number(cockpit.budget.available) / 1e6} available (same as the role view)`,
);
for (const s of shortlist) console.log(`    #${s.score ?? "-"} ${s.name}: ${s.agentNote}`);

const { messageId } = await asCompany.roles.message.mutate({
	roleId,
	text: "Quick update please: how many candidates are left in the pipeline and how much budget is left?",
});
await waitFor(
	"agent replied to the company (streamed)",
	async () => events.some((e) => e.type === "agent.message" && e.final && e.roleId === roleId),
	180_000,
);
const reply = events.filter((e) => e.type === "agent.message" && e.final && e.roleId === roleId).at(-1);
console.log(`    agent: ${reply?.message?.slice(0, 200)}`);
const thread = (await asCompany.roles.activity.query({ roleId })).items;
check(
	thread.some((i) => i.id === messageId && i.kind === "COMPANY_MESSAGE"),
	"thread keeps the company message",
);

// A question never changes anything (I5): no new gigs, nothing committed, no proposal.
{
	const st0 = await asCompany.roles.status.query({ roleId });
	const gigs0 = (await asCompany.gigs.list.query({ roleId, includeClosed: true })).length;
	const finals0 = events.filter((e) => e.type === "agent.message" && e.final && e.roleId === roleId).length;
	await asCompany.roles.message.mutate({
		roleId,
		text: "Why are you sending me Rust engineers? Isn't this a different kind of role?",
	});
	await waitFor(
		"agent answered the question",
		async () =>
			events.filter((e) => e.type === "agent.message" && e.final && e.roleId === roleId).length > finals0,
		180_000,
	);
	const st1 = await asCompany.roles.status.query({ roleId });
	check(
		st1.budget.committed === st0.budget.committed &&
			(await asCompany.gigs.list.query({ roleId, includeClosed: true })).length === gigs0 &&
			!st1.waitingOn.some((w) => w.actions?.some((a) => a.id === "approve_proposal")),
		"a question to the agent spends nothing and changes no gigs",
	);
}

// ---- 6. Company decision ---------------------------------------------------------------------

const before = await Promise.all([asSourcer, asScreener, asReferee].map(balance));
const invite = await asCompany.roles.decide.mutate({ roleId, candidateId: karolina, decision: "invite" });
check(invite.unsignedTx === null, "invite is a decision only (nothing to sign)");
const decided = await asCompany.roles.shortlist.query({ roleId });
{
	const st = await asCompany.roles.status.query({ roleId });
	const item = st.waitingOn.find(
		(w) => w.deliverableId === karolina && w.actions?.some((a) => a.id === "attended"),
	);
	check(
		Boolean(item?.actions?.some((a) => a.id === "no_show")),
		"after the invite: Came to the interview / Didn't come",
	);
}
check(
	decided.find((i) => i.candidateId === karolina)?.decision === "INVITED",
	"Karolina invited to interview",
);
const afterInvite = await Promise.all([asSourcer, asScreener, asReferee].map(balance));
check(
	afterInvite.every((b, i) => b === (before[i] ?? 0n)),
	"inviting doesn't release holdbacks",
);
const attended = await asCompany.roles.decide.mutate({ roleId, candidateId: karolina, decision: "attended" });
check(
	(attended.releases ?? []).length >= 2 && (attended.releases ?? []).every((r) => BigInt(r.amount) > 0n),
	`release per recruiter: ${(attended.releases ?? []).map((r) => `${r.recruiter} ${usd(r.amount)}`).join(", ")}`,
);
if (attended.unsignedTx) await signAndSubmit([company], attended.unsignedTx);
check(
	(await asCompany.roles.shortlist.query({ roleId })).find((i) => i.candidateId === karolina)?.decision ===
		"ATTENDED",
	"Karolina came to the interview",
);
const after = await Promise.all([asSourcer, asScreener, asReferee].map(balance));
check(
	after.every((b, i) => b > (before[i] ?? 0n)),
	`attendance released every held-back payout (${after.map((b, i) => `${usd(before[i] ?? 0n)}→${usd(b)}`).join(", ")})`,
);

// The company reports a sourced candidate as fake: do-not-contact everywhere.
const piotr = sourced.find(
	(d) => d.deliverable.type === "SOURCING" && d.deliverable.name.startsWith("Piotr"),
);
// The company passes on / hides candidates; a recruiter edits and withdraws a fresh delivery.
{
	const tomasz = sourced.find(
		(d) => d.deliverable.type === "SOURCING" && d.deliverable.name.startsWith("Tomasz"),
	);
	if (tomasz) {
		const r = await asCompany.candidates.remove.mutate({ candidateId: tomasz.id });
		if (r.unsignedTx) await signAndSubmit([company], r.unsignedTx);
		const list = await asCompany.roles.candidates.query({ roleId });
		const all = await asCompany.roles.candidates.query({ roleId, includeRemoved: true });
		check(
			!list.some((c) => c.candidateId === tomasz.id) &&
				all.some((c) => c.candidateId === tomasz.id && c.removed),
			"removing a candidate passes and hides them (still listed with includeRemoved)",
		);
	}
	const { db: tdb, schema: tschema } = await import("../db/index.ts");
	const { eq: teq } = await import("drizzle-orm");
	// The server's review grace period (REVIEW_GRACE_SECONDS) keeps a fresh delivery undecided for a while; with it
	// off, pause the agent instead (test-only, like the seeded history).
	const graceOff = process.env.REVIEW_GRACE_SECONDS === "0";
	if (graceOff)
		await tdb.update(tschema.roles).set({ agentPaused: true }).where(teq(tschema.roles.id, roleId));
	const fresh = fixture("candidate-strong-rust.json");
	const late = await deliver(asSourcer, sourcer, sourcing.id, {
		...asCandidate({ ...fresh, profileUrl: `https://www.linkedin.com/in/e2e-late-${Date.now()}` }),
	});
	await asSourcer.gigs.edit.mutate({ deliverableId: late, note: "Edited: also led a Solana audit." });
	const edited = await asSourcer.gigs.work.query({ deliverableId: late });
	check(
		edited.editable && edited.note === "Edited: also led a Solana audit.",
		"the recruiter edited their note while it was undecided",
	);
	const w = await asSourcer.gigs.withdraw.mutate({ deliverableId: late });
	if (graceOff)
		await tdb.update(tschema.roles).set({ agentPaused: false }).where(teq(tschema.roles.id, roleId));
	const after = await asSourcer.gigs.work.query({ deliverableId: late });
	check(
		after.work.status === "REJECTED" && after.rejectText === "Withdrawn by the recruiter." && !after.editable,
		`withdrawn before the agent decided (bond kept: ${usd(w.bondKept)})`,
	);
}
if (piotr) {
	const rep = await asCompany.roles.reportCandidate.mutate({
		roleId,
		candidateId: piotr.id,
		reason: "Profile photo and employment history are invented.",
	});
	if (rep.unsignedTx) await signAndSubmit([company], rep.unsignedTx);
	await expectAppError(
		deliver(asReferee, referee, sourcing.id, asCandidate(fixture("demo-candidate-3-weak-piotr.json"))),
		"DO_NOT_CONTACT",
		"a reported fake candidate can't be submitted again",
	);
	const piotrView = (await asSourcer.gigs.mine.query()).deliverables.find((d) => d.id === piotr.id);
	check(
		piotrView?.deposit?.status === "KEPT" && BigInt(piotrView.deposit.amount) > 0n,
		`Piotr's rejection kept the bond (${usd(piotrView?.deposit?.amount ?? "0")}) and the recruiter sees it`,
	);
	const { createBackendPorts } = await import("../agent-runner/backend-ports.ts");
	const why = await createBackendPorts(roleId).getDecisionLog({ candidateName: "piotr", limit: 5 });
	check(
		why.some((d) => d.action === "reject" && d.candidateName?.startsWith("Piotr")),
		`the agent can explain Piotr's rejection: "${why.find((d) => d.action === "reject")?.reason}"`,
	);
	// The fixtures are reused by every run: lift this run's do-not-contact flag again.
	const { db, schema } = await import("../db/index.ts");
	const { eq } = await import("drizzle-orm");
	await db.delete(schema.candidateFlags).where(eq(schema.candidateFlags.roleId, roleId));
}

// Money: what the role spent adds up to the ledger; a recruiter can cash out; profiles count real work.
{
	const detail = await asCompany.roles.byId.query({ id: roleId });
	const ledger = await asCompany.roles.payments.query({ roleId });
	const sum = ledger.filter((l) => l.kind !== "appeal").reduce((n, l) => n + BigInt(l.bounty ?? "0"), 0n);
	check(
		BigInt(detail.budget.spent ?? "-1") === sum && BigInt(detail.budget.fees ?? "0") > 0n,
		`spent ${usd(detail.budget.spent ?? "0")} = the ledger's plan prices (fees ${usd(detail.budget.fees ?? "0")})`,
	);
	const k = (await asSourcer.gigs.mine.query()).deliverables.find((d) => d.id === karolina);
	check(k?.deposit?.status === "RETURNED", "Karolina's acceptance returned the sourcer's bond");
	const was = await balance(asScreener);
	await signAndSubmit(
		[screener],
		(await asScreener.me.cashOut.mutate({ to: referee.address, amount: toBaseUnits(1).toString() }))
			.unsignedTx,
	);
	const now = await waitFor(
		"cash out landed",
		async () => {
			const b = await balance(asScreener);
			return b < was ? b : null;
		},
		30_000,
	);
	check(was - now === toBaseUnits(1), "the screener cashed out $1 to another account");
	await expectAppError(
		asScreener.me.cashOut.mutate({ to: referee.address, amount: toBaseUnits(1_000_000).toString() }),
		"INSUFFICIENT_FUNDS",
		"can't send more than the balance",
	);
	await asScreener.me.upsert.mutate({
		kind: "scout",
		displayName: "E2E recruiter B",
		bio: "I screen Rust engineers.",
	});
	const prof = await anon.scouts.profile.query({ wallet: screener.address });
	check(
		prof.bio === "I screen Rust engineers." && (prof.score?.acceptedByType?.SCREENING_CALL ?? 0) >= 1,
		`public profile: bio and real accepted calls (${prof.score?.acceptedByType?.SCREENING_CALL} screening, seeded ${prof.score?.seededAccepted})`,
	);
}

const activity = await asCompany.roles.activity.query({ roleId });
check(
	activity.items
		.filter((i) => i.kind !== "COMPANY_MESSAGE" && i.kind !== "AGENT_MESSAGE")
		.every(
			(i) =>
				!/\b(ACCEPT|REJECT|ESCALATE|ADVANCE|MAYBE|PASS)\b/.test(i.message) && /^[A-Z0-9$"“]/.test(i.message),
		) &&
		!activity.items.some((i) => i.kind === "REVIEWED") &&
		activity.items.some((i) =>
			/^Karolina confirmed the screening happened → paid \S+ \$[\d.]+ \(\d+\)/.test(i.message),
		) &&
		activity.items.some((i) => /^Accepted Karolina's reference check \(\d+\) and paid /.test(i.message)),
	'the thread: one plain sentence per decision (e.g. "Accepted Karolina\'s screening (96) and paid …")',
);
check(
	!activity.items.some(
		(i) => /no recording/i.test(`${i.message} ${i.detail ?? ""}`) && i.message.includes("reference"),
	),
	"the recorded reference isn't described as unrecorded",
);
check(
	activity.items.some((i) => /^Planned: \d+ profiles?, /.test(i.message)),
	'the plan line is one short sentence ("Planned: 17 profiles, …")',
);
check(
	!activity.items.some((i) => i.kind === "DELIVERY_RECEIVED" && i.deliverableId === karolina) &&
		activity.items.some((i) => i.deliverableId === karolina && /delivered Karolina Mazurek/.test(i.message)),
	'one line per sourced candidate (no separate "sourced" line once decided)',
);
check(
	activity.items
		.filter((i) => i.kind === "PLANNED")
		.every((i) => i.message.length <= 200 && !/[.!?]\s+[A-Z$]/.test(i.message)),
	"the plan is one line on the timeline (the breakdown is in its detail)",
);
console.log(`\nagent status: ${activity.status}\ntimeline:`);
for (const a of activity.items) console.log(`  ${a.kind.padEnd(18)} ${a.message.slice(0, 140)}`);
sub.unsubscribe();
anonSub.unsubscribe();
check(
	!anonEvents.some((e) => e.type.startsWith("agent.") || e.message),
	`anonymous listeners got no agent chat or timeline text (${anonEvents.length} events)`,
);
const types = new Set(events.filter((e) => e.roleId === roleId).map((e) => e.type));
check(types.has("role.status"), "role.status events streamed to the company");
console.log(`\nevents seen: ${[...types].join(", ")}`);
