/**
 * Demo day: prepare a role up to "shortlist ready, waiting for Invite", through the real API as the demo personas
 * (no database shortcuts). Every run makes a new role, so it's safe to re-run.
 *
 *   pnpm demo:prepare                    # against http://localhost:8788
 *   API=http://localhost:8789 pnpm demo:prepare
 *
 * Hanna (client.json) creates and funds a $750 role from the example job description. Lucía (scout2.json) sources
 * Karolina and Piotr; the agent rejects Piotr. Karolina confirms on her /c page. Ola (recruiter.json) runs the
 * screening, the language check and the reference with the notetaker (the backend needs RECALL_MOCK=1).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Deliverable, GigView, UnsignedTx } from "@scout/shared";
import { toBaseUnits } from "@scout/shared";
import {
	createKeyPairSignerFromBytes,
	getBase64EncodedWireTransaction,
	getTransactionDecoder,
	type KeyPairSigner,
	partiallySignTransaction,
	signBytes,
} from "@solana/kit";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "../trpc/router.ts";

const API = `${process.env.API ?? "http://localhost:8788"}/trpc`;
const APP = (process.env.APP_URL ?? "http://localhost:5173").replace(/\/$/, "");
const BUDGET = Number(process.env.BUDGET_USD ?? 750);
const started = Date.now();
const t = () => `${Math.round((Date.now() - started) / 1000)}s`.padStart(5);
const step = (what: string) => console.log(`${t()}  ${what}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fixture = <T>(name: string) =>
	JSON.parse(readFileSync(new URL(`../agent/fixtures/${name}`, import.meta.url), "utf8")) as T;
const key = async (file: string) =>
	createKeyPairSignerFromBytes(
		Uint8Array.from(
			JSON.parse(readFileSync(resolve(homedir(), ".config/solana/superrecruiter", file), "utf8")),
		),
	);

async function waitFor<T>(
	what: string,
	get: () => Promise<T | null | undefined | false>,
	timeoutMs = 240_000,
) {
	const until = Date.now() + timeoutMs;
	for (;;) {
		const v = await get();
		if (v) return v;
		if (Date.now() > until) throw new Error(`Timed out waiting for: ${what}`);
		await sleep(1500);
	}
}

const client = (token: string | null, device: string) =>
	createTRPCClient<AppRouter>({
		links: [
			httpBatchLink({
				url: API,
				transformer: superjson,
				// Each persona on its own device (the backend won't auto-pay a candidate "yes" from the recruiter's).
				headers: () => ({
					"user-agent": `scout-demo-prepare (${device})`,
					...(token ? { authorization: `Bearer ${token}` } : {}),
				}),
			}),
		],
	});
type Client = ReturnType<typeof client>;

async function signIn(signer: KeyPairSigner, device: string) {
	const anon = client(null, device);
	const { message } = await anon.auth.nonce.mutate({ wallet: signer.address });
	const signature = await signBytes(signer.keyPair.privateKey, new TextEncoder().encode(message));
	const { token } = await anon.auth.verify.mutate({
		wallet: signer.address,
		message,
		signature: Buffer.from(signature).toString("base64"),
	});
	return client(token, device);
}

async function signAndSend(c: Client, signer: KeyPairSigner, unsigned: UnsignedTx | null) {
	if (!unsigned) return null;
	const tx = getTransactionDecoder().decode(Buffer.from(unsigned.transaction, "base64"));
	const signed = await partiallySignTransaction([signer.keyPair], tx);
	const r = await c.tx.submit.mutate({ signedTx: getBase64EncodedWireTransaction(signed) });
	step(`✓ ${unsigned.summary}`);
	return r;
}

// ---- Personas ---------------------------------------------------------------------------------------

const [hannaKey, luciaKey, olaKey] = await Promise.all([
	key("client.json"),
	key("scout2.json"),
	key("recruiter.json"),
]);
const [hanna, lucia, ola] = await Promise.all([
	signIn(hannaKey, "Hanna's laptop"),
	signIn(luciaKey, "Lucía's laptop"),
	signIn(olaKey, "Ola's laptop"),
]);
const candidatePhone = client(null, "Karolina's phone");
const me = await hanna.me.get.query();
if (!me || me.kind !== "company")
	throw new Error("Hanna isn't a company account here: run `pnpm seed` first.");
if (BigInt(me.usdcBalance) < toBaseUnits(BUDGET)) {
	throw new Error(
		`Hanna has $${Number(me.usdcBalance) / 1e6}, the role needs $${BUDGET}. Fund her (scripts/fund.mts) and re-run.`,
	);
}
const luciaMe = await lucia.me.get.query();
if (BigInt(luciaMe?.usdcBalance ?? "0") < toBaseUnits(10))
	throw new Error("Lucía needs at least $10 for sourcing bonds. Fund her (scripts/fund.mts) and re-run.");
step(`Hanna (${me.companyName}) has $${Math.floor(Number(me.usdcBalance) / 1e6)}`);

// ---- 1. Hanna creates and funds the role --------------------------------------------------------------

const jd = readFileSync(new URL("../agent/fixtures/demo-jd-senior-backend-ts.txt", import.meta.url), "utf8");
const draft = await hanna.roles.draft.mutate({ jobDescription: jd });
const created = await hanna.roles.create.mutate({
	title: draft.title,
	summary: draft.summary,
	jobDescription: jd,
	criteria: draft.criteria,
	taskType: "SOURCING",
	reviewWindowSeconds: 1200,
	deposit: toBaseUnits(BUDGET).toString(),
	...(draft.company ? { company: draft.company } : {}),
});
await signAndSend(hanna, hannaKey, created.unsignedTx);
const roleId = created.roleId;
const gigsOf = (type: GigView["type"]) => hanna.gigs.list.query({ roleId, type });
const sourcing = await waitFor("the agent's sourcing gig", async () => (await gigsOf("SOURCING"))[0]);
step(`✓ the agent posted "${sourcing.title}"`);

// ---- 2. Lucía sources Karolina and Piotr ----------------------------------------------------------------

type Fixture = Record<string, string>;
const asCandidate = (f: Fixture): Deliverable => ({
	type: "SOURCING",
	name: f.name ?? "",
	profileUrl: f.profileUrl ?? "",
	notes: f.notes ?? "",
	candidate: {
		avatarUrl: f.avatarUrl ?? null,
		currentTitle: f.currentTitle ?? null,
		currentCompany: f.currentCompany ?? null,
		location: f.location ?? null,
	},
});
async function deliver(c: Client, signer: KeyPairSigner, gigId: string, d: Deliverable) {
	const r = await c.gigs.deliver.mutate({ gigId, deliverable: d });
	await signAndSend(c, signer, r.unsignedTx);
	return r.deliverableId;
}
const karolina = await deliver(
	lucia,
	luciaKey,
	sourcing.id,
	asCandidate(fixture("demo-candidate-1-strong-karolina.json")),
);
const piotr = await deliver(
	lucia,
	luciaKey,
	sourcing.id,
	asCandidate(fixture("demo-candidate-3-weak-piotr.json")),
);

const link = await waitFor("the agent pre-accepts Karolina", async () => {
	const d = (await lucia.gigs.mine.query()).deliverables.find((x) => x.id === karolina);
	return d?.confirmation?.url ?? null;
});
step("✓ the agent pre-accepted Karolina; Lucía has her confirmation link");
await candidatePhone.candidate.confirm.mutate({
	token: link.split("/c/")[1] ?? "",
	interested: true,
	availability: "Tue/Thu afternoons, after 16:00",
	salaryExpectation: "32–36k PLN / month on B2B",
	timeZone: "Europe/Warsaw",
	contactEmail: "karolina.mazurek@example.com",
});
step("✓ Karolina confirmed on her phone");
await waitFor("Lucía is paid for Karolina", async () => {
	const d = (await lucia.gigs.mine.query()).deliverables.find((x) => x.id === karolina);
	return d?.status === "ACCEPTED";
});
step("✓ Lucía was paid for Karolina");
await waitFor("the agent rejects Piotr", async () => {
	const d = (await lucia.gigs.mine.query()).deliverables.find((x) => x.id === piotr);
	return d && d.status !== "PENDING" ? d : null;
}).then((d) => step(`✓ Piotr: ${d.status.toLowerCase()} (${d.review?.reasons[0] ?? ""})`));

// ---- 3. Ola runs the calls with the notetaker -----------------------------------------------------------

async function runCall(gig: GigView, extra: (prefill: Record<string, string>) => Partial<Deliverable>) {
	if (gig.claimant?.wallet !== olaKey.address)
		await signAndSend(ola, olaKey, (await ola.gigs.claim.mutate({ id: gig.id })).unsignedTx);
	await ola.recall.invite.mutate({ gigId: gig.id, meetingUrl: "https://meet.google.com/wis-labs-demo" });
	const rec = await waitFor(`the notetaker's transcript for "${gig.title}"`, async () => {
		const r = await ola.recall.status.query({ gigId: gig.id });
		if (r?.status === "failed") throw new Error(`The notetaker failed: ${r.failureReason}`);
		return r?.status === "done" ? r : null;
	});
	const full = await ola.gigs.byId.query({ id: gig.id });
	const prefill = Object.fromEntries((rec.prefill?.answers ?? []).map((a) => [a.questionId, a.answer]));
	// Where the notetaker couldn't place an answer, Ola types what she noted on the call: the call's fixture
	// answer for that question (same question id, or the closest one by words), like a recruiter filling gaps.
	const notes = fixture<{ answers: { questionId: string; answer: string }[] }>(
		gig.type === "REFERENCE_CHECK"
			? "reference-karolina.json"
			: gig.variant === "language"
				? "language-karolina-english.json"
				: "screening-karolina-good.json",
	).answers;
	const words = (x: string) =>
		new Set(
			x
				.toLowerCase()
				.split(/[^a-z0-9]+/)
				.filter((w) => w.length > 2),
		);
	const noted = (q: { id: string; question: string }, i: number) => {
		const exact = notes.find((n) => n.questionId === q.id);
		if (exact) return exact.answer;
		const want = words(`${q.id} ${q.question}`);
		const best = notes
			.map((n) => ({ n, score: [...words(n.questionId)].filter((w) => want.has(w)).length }))
			.sort((a, b) => b.score - a.score)[0];
		return (best && best.score > 0 ? best.n : notes[i % notes.length])?.answer ?? "";
	};
	const answers = (full.script ?? []).map((q, i) => ({
		questionId: q.id,
		answer: prefill[q.id] ?? noted(q, i),
	}));
	const base =
		gig.type === "REFERENCE_CHECK"
			? ({
					type: "REFERENCE_CHECK",
					refereeName: "Marek Nowicki",
					refereeRelation: "CTO at Kelp Labs, her manager for three years",
					answers,
					recommendation: "ADVANCE",
				} as const)
			: ({ type: "SCREENING_CALL", answers, recommendation: "ADVANCE" } as const);
	const id = await deliver(ola, olaKey, gig.id, { ...base, ...extra(prefill) } as Deliverable);
	const first = await waitFor(`the agent's decision on "${gig.title}"`, async () => {
		const d = (await ola.gigs.mine.query()).deliverables.find((x) => x.id === id);
		return d && (d.status !== "PENDING" || d.review?.verdict === "ESCALATE") ? d : null;
	});
	if (first.status !== "PENDING") return first;
	// The agent asked Hanna about it (its review can be cautious): she reads the notes and accepts, as she would.
	step(`  the agent asked Hanna about "${gig.title}" (${first.review?.reasons[0] ?? ""}); Hanna accepts it`);
	const ok = await hanna.deliverables.decide.mutate({
		id,
		decision: "accept",
		reasonText: "Read the notes and the transcript; this is fine.",
	});
	await signAndSend(hanna, hannaKey, ok.unsignedTx);
	return waitFor(`"${gig.title}" paid`, async () => {
		const d = (await ola.gigs.mine.query()).deliverables.find((x) => x.id === id);
		return d && d.status !== "PENDING" ? d : null;
	});
}

const callGig = (pick: (g: GigView) => boolean) =>
	waitFor("the next call gig", async () =>
		[...(await gigsOf("SCREENING_CALL")), ...(await gigsOf("REFERENCE_CHECK"))].find(
			(g) => g.status === "OPEN" && g.candidate?.id === karolina && pick(g),
		),
	);
const screening = await callGig((g) => g.type === "SCREENING_CALL" && g.variant !== "language");
const s = await runCall(screening, () => ({
	referee: { name: "Marek Nowicki", relation: "CTO at Kelp Labs, her manager", contact: "marek@example.com" },
}));
step(`✓ screening: ${s.status.toLowerCase()}`);
// The language check and the reference are booked together after the screening: Ola runs both at once.
const [language, reference] = await Promise.all([
	callGig((g) => g.variant === "language"),
	callGig((g) => g.type === "REFERENCE_CHECK"),
]);
const [l, r] = await Promise.all([
	runCall(language, () => ({ assessedLevel: "C1" })),
	runCall(reference, () => ({})),
]);
step(`✓ language check: ${l.status.toLowerCase()}`);
step(`✓ reference: ${r.status.toLowerCase()}`);

// ---- 4. Shortlist ------------------------------------------------------------------------------------

await waitFor("the shortlist", async () =>
	(await hanna.roles.shortlist.query({ roleId })).some(
		(x) => x.candidateId === karolina && x.decision === "NONE",
	),
);
step("✓ shortlist ready, waiting for Hanna's Invite");
const errors = (await hanna.roles.activity.query({ roleId })).items.filter((i) => i.kind === "ERROR");
if (errors.length)
	console.log(`       Warning: ${errors.length} error line(s) in Hanna's thread: ${errors[0]?.message}`);
const decisionsNeeded = (await hanna.roles.status.query({ roleId })).waitingOn.filter(
	(w) => w.who === "company",
);
if (decisionsNeeded.length > 1)
	console.log(`       Note: ${decisionsNeeded.length - 1} other item(s) wait for Hanna besides the invite.`);
console.log(`\nDone in ${t().trim()}. Open:\n  ${APP}/company/roles/${roleId}\n  (role id ${roleId})`);
process.exit(0);
