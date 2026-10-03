/** CLI commands for the agent-run gig flow (see cli.ts for usage). Uses the demo role fixtures. */
import { readFileSync } from "node:fs";
import {
	type AgentReview,
	type Criteria,
	Criteria as CriteriaSchema,
	fromBaseUnits,
	toBaseUnits,
} from "@scout/shared";
import {
	agentDecision,
	type CallDeliverable,
	type CallReview,
	type CallScript,
	pickForScreening,
	planGigs,
	providerLabel,
	referenceScript,
	reviewReference,
	reviewScreening,
	reviewSubmissionDetailed,
	screeningScript,
	shortlist,
} from "./index.ts";

const FIXTURES = new URL("./fixtures/", import.meta.url);
const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(name, FIXTURES), "utf-8")) as T;
const style = (code: number) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
const bold = style(1);
const dim = style(2);
const green = style(32);
const yellow = style(33);
const red = style(31);
const usd = (base: bigint) => `$${fromBaseUnits(base)}`;
const toneFor = (v: string) =>
	v === "ACCEPT" || v === "accept" || v === "ADVANCE"
		? green
		: v === "REJECT" || v === "reject" || v === "PASS"
			? red
			: yellow;

type DemoCandidate = { name: string; profileUrl: string; notes: string };
const role = fixture<{ title: string; criteria: Criteria }>("demo-role-senior-backend-ts.json");
const criteria = CriteriaSchema.parse(role.criteria);
const karolina = fixture<DemoCandidate>("demo-candidate-1-strong-karolina.json");

export async function planCommand(budgetUsd = 500) {
	const started = Date.now();
	const plan = await planGigs({ criteria, title: role.title, budget: toBaseUnits(budgetUsd) });
	console.log(bold(`Gig plan for ${role.title} · budget $${budgetUsd}`));
	for (const g of plan.gigs) {
		console.log(
			`  ${g.taskType.padEnd(15)} ${String(g.maxDeliverables).padStart(2)} × ${usd(g.bounty).padEnd(4)} ${g.exclusive ? "1 recruiter " : "open        "} ${dim(g.when)}  ${g.title}`,
		);
	}
	console.log(`  committed ${usd(plan.committed)}, reserve ${usd(plan.reserve)}`);
	console.log(`\n${bold("Sourcing brief")}: ${plan.gigs[0]?.brief}`);
	console.log(`${bold("Rationale")}: ${plan.rationale}`);
	console.log(dim(`\n${providerLabel()} · ${((Date.now() - started) / 1000).toFixed(1)}s`));
	return plan;
}

export async function scriptCommand(kind: "screening" | "reference" = "screening") {
	const started = Date.now();
	const script =
		kind === "screening"
			? await screeningScript({ criteria, candidate: karolina })
			: await referenceScript({ criteria, candidate: karolina });
	printScript(script);
	console.log(dim(`${providerLabel()} · ${((Date.now() - started) / 1000).toFixed(1)}s`));
	return script;
}

function printScript(script: CallScript) {
	console.log(
		bold(`${script.kind === "screening" ? "Screening" : "Reference"} script for ${script.candidate.name}`),
	);
	for (const q of script.questions) {
		console.log(`  ${dim(q.id)}\n    Q: ${q.question}\n    ${dim(`good: ${q.whatGoodLooksLike}`)}`);
	}
}

function printCallReview(label: string, review: CallReview, ms: number) {
	console.log(
		`\n${bold(label)}: ${toneFor(review.verdict)(`${review.verdict} ${review.score}/100`)} · candidate fit ${review.candidateFit} ${dim(`(${review.engine}, ${(ms / 1000).toFixed(1)}s)`)}`,
	);
	for (const r of review.reasons) console.log(`  - ${r}`);
	console.log(`  ${dim("for company:")} ${review.summaryForCompany}`);
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
	const started = Date.now();
	return [await fn(), Date.now() - started];
}

export async function reviewScreeningCommand(answersFile = "screening-karolina-good.json") {
	const script = await screeningScript({ criteria, candidate: karolina });
	const answers = fixture<Omit<CallDeliverable, "script">>(answersFile);
	const [review, ms] = await timed(() => reviewScreening({ script, ...answers }));
	printCallReview(`Screening deliverable (${answersFile})`, review, ms);
	const decision = agentDecision({ kind: "screening", review });
	console.log(`  agent: ${toneFor(decision.action)(decision.action)} — ${decision.reason}`);
	return review;
}

/** Full agent run on fixtures: plan → score sourced profiles → book screening → review → reference → shortlist. */
export async function demoGigs() {
	console.log(dim(`llm: ${providerLabel()}\n`));
	await planCommand(500);

	console.log(`\n${bold("Sourcing deliverables")}`);
	const files = [
		"demo-candidate-1-strong-karolina.json",
		"demo-candidate-2-medium-tomasz.json",
		"demo-candidate-3-weak-piotr.json",
	];
	const sourced: { id: string; candidate: DemoCandidate; review: AgentReview }[] = [];
	for (const [i, file] of files.entries()) {
		const candidate = fixture<DemoCandidate>(file);
		const details = await reviewSubmissionDetailed(criteria, candidate);
		const decision = agentDecision({ kind: "sourcing", review: details.review });
		console.log(
			`  ${candidate.name.padEnd(18)} ${toneFor(details.review.recommendation)(`${details.review.score} ${details.review.recommendation}`.padEnd(12))} → ${toneFor(decision.action)(decision.action)} ${dim(`${decision.reason} (${details.engine}, ${(details.latencyMs / 1000).toFixed(1)}s)`)}`,
		);
		if (decision.action === "accept") sourced.push({ id: `c${i + 1}`, candidate, review: details.review });
	}

	const toScreen = pickForScreening(sourced);
	console.log(
		`\n${bold("Booking screening calls")}: ${toScreen.map((c) => c.candidate.name).join(", ") || "none"}`,
	);
	const finalist = toScreen.find((c) => c.candidate.name === karolina.name) ?? toScreen[0];
	if (!finalist) return;

	const script = await screeningScript({
		criteria,
		candidate: { ...finalist.candidate, review: finalist.review },
	});
	printScript(script);
	for (const file of ["screening-lazy.json", "screening-karolina-good.json"]) {
		const answers = fixture<Omit<CallDeliverable, "script">>(file);
		const [review, ms] = await timed(() => reviewScreening({ script, ...answers }));
		printCallReview(`Screening deliverable (${file})`, review, ms);
		const decision = agentDecision({ kind: "screening", review });
		console.log(`  agent: ${toneFor(decision.action)(decision.action)} — ${decision.reason}`);
		if (file === "screening-karolina-good.json") (finalist as { screening?: CallReview }).screening = review;
	}

	const refScript = await referenceScript({ criteria, candidate: finalist.candidate });
	const refAnswers = fixture<Omit<CallDeliverable, "script">>("reference-karolina.json");
	const [reference, refMs] = await timed(() => reviewReference({ script: refScript, ...refAnswers }));
	printCallReview("Reference check", reference, refMs);

	const [list, listMs] = await timed(() =>
		shortlist({
			role: { title: role.title, criteria },
			candidates: sourced.map((c) => ({
				id: c.id,
				name: c.candidate.name,
				sourcing: c.review,
				...(c === finalist
					? { screening: (finalist as { screening?: CallReview }).screening, reference }
					: {}),
			})),
		}),
	);
	console.log(`\n${bold("Shortlist")} ${dim(`(${(listMs / 1000).toFixed(1)}s)`)}`);
	for (const e of list)
		console.log(`  ${e.rank}. ${bold(e.name)} · ${e.overall}/100 · ${e.stage}\n     ${e.summary}`);
}
