/**
 * Try the agent without the UI.
 *   pnpm --filter @scout/backend agent demo
 *   pnpm --filter @scout/backend agent compare   # jev vs llm vs offline on the demo candidates
 *   pnpm --filter @scout/backend agent draft jd-senior-rust-solana.txt
 *   pnpm --filter @scout/backend agent budget criteria-senior-rust.json
 *   pnpm --filter @scout/backend agent review criteria-senior-rust.json candidate-strong-rust.json
 * File arguments resolve against the cwd first, then src/agent/fixtures/.
 * LLM_PROVIDER=offline forces the deterministic heuristics; REVIEW_ENGINE picks jev|llm|offline.
 */
import { existsSync, readFileSync } from "node:fs";
import { type AgentReview, type Criteria, Criteria as CriteriaSchema, fromBaseUnits } from "@scout/shared";
import {
	defaultReviewEngine,
	draftRole,
	pipelineSummary,
	providerLabel,
	type ReviewDetails,
	type ReviewEngine,
	reviewSubmissionDetailed,
	suggestBudget,
} from "./index.ts";
import { allCriteria } from "./scoring.ts";

const FIXTURES = new URL("./fixtures/", import.meta.url);

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const color = (code: number) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
const green = color(32);
const yellow = color(33);
const red = color(31);

function read(path: string): string {
	if (existsSync(path)) return readFileSync(path, "utf-8");
	const fixture = new URL(path, FIXTURES);
	if (existsSync(fixture)) return readFileSync(fixture, "utf-8");
	throw new Error(`File not found: ${path}`);
}
const readJson = (path: string): unknown => JSON.parse(read(path));
const readCandidate = (path: string) => readJson(path) as { name: string; profileUrl: string; notes: string };

function printCriteria(title: string, summary: string, criteria: Criteria) {
	console.log(`${bold(title)}\n${summary}\n`);
	const list = (name: string, items: Criteria["mustHave"]) =>
		items.length &&
		console.log(`${bold(name)}\n${items.map((c) => `  [${c.weight}] ${c.label} ${dim(c.id)}`).join("\n")}`);
	list("Must have", criteria.mustHave);
	list("Nice to have", criteria.niceToHave);
	list("Deal breakers", criteria.dealBreakers);
	const salary = criteria.salaryRange
		? `${criteria.salaryRange.min}-${criteria.salaryRange.max} ${criteria.salaryRange.currency}/${criteria.salaryRange.period.toLowerCase()}`
		: "not stated";
	console.log(
		dim(
			`${criteria.seniority} · ${criteria.location.mode} ${criteria.location.places.join(", ")} · ${criteria.languages.join(", ")} · salary ${salary}`,
		),
	);
}

async function printBudget(criteria: Criteria, title?: string) {
	const budget = await suggestBudget(criteria, { title });
	const bounty = fromBaseUnits(budget.bounty);
	console.log(
		`\n${bold("Suggested budget")}: ${bounty} USDC × ${budget.maxCandidates} candidates = ${bounty * budget.maxCandidates} USDC`,
	);
	console.log(budget.rationale);
	return budget;
}

const tone = (review: AgentReview) =>
	review.recommendation === "ADVANCE" ? green : review.recommendation === "MAYBE" ? yellow : red;
const meta = (d: ReviewDetails) =>
	`${d.engine} · ${(d.latencyMs / 1000).toFixed(1)}s · $${d.costUsd.toFixed(5)} · summary ${d.summarySource}`;

function printReview(name: string, criteria: Criteria, details: ReviewDetails) {
	const { review } = details;
	console.log(
		`\n${bold(name)}: ${tone(review)(`${review.score}/100 ${review.recommendation}`)} ${dim(meta(details))}`,
	);
	const labels = new Map(allCriteria(criteria).map((c) => [c.id, c.label]));
	for (const v of review.verdicts) {
		const mark = { MET: green("✓"), PARTIAL: yellow("~"), NOT_MET: red("✗"), UNKNOWN: dim("?") }[v.verdict];
		const p = details.probabilities?.[v.criterionId];
		const probs = p ? dim(` [yes ${p.yes.toFixed(2)} info ${p.info.toFixed(2)}]`) : "";
		console.log(`  ${mark} ${labels.get(v.criterionId) ?? v.criterionId}${probs} ${dim(`— ${v.reasoning}`)}`);
	}
	console.log(`  ${review.summary}`);
}

/** Every review engine on the demo fixtures: score, latency and cost side by side. */
async function compare() {
	const criteria = CriteriaSchema.parse(readJson("criteria-senior-rust.json"));
	const engines: ReviewEngine[] = ["jev", "llm", "offline"];
	console.log(dim(`llm provider: ${providerLabel()}\n`));
	for (const file of ["candidate-strong-rust.json", "candidate-weak-rust.json"]) {
		const candidate = readCandidate(file);
		console.log(bold(candidate.name));
		for (const engine of engines) {
			const d = await reviewSubmissionDetailed(criteria, candidate, engine);
			console.log(
				`  ${engine.padEnd(8)} ${tone(d.review)(`${d.review.score} ${d.review.recommendation}`.padEnd(12))} ${dim(meta(d))}`,
			);
		}
	}
}

async function demo() {
	console.log(dim(`llm: ${providerLabel()} · review engine: ${defaultReviewEngine()}\n`));
	const jd = read("jd-senior-rust-solana.txt");
	const draft = await draftRole(jd);
	printCriteria(draft.title, draft.summary, draft.criteria);
	const budget = await printBudget(draft.criteria, draft.title);

	const reviews: AgentReview[] = [];
	for (const file of ["candidate-strong-rust.json", "candidate-weak-rust.json"]) {
		const candidate = readCandidate(file);
		const details = await reviewSubmissionDetailed(draft.criteria, candidate);
		reviews.push(details.review);
		printReview(candidate.name, draft.criteria, details);
	}

	const deposited = budget.bounty * 10n;
	const summary = await pipelineSummary({
		title: draft.title,
		bounty: budget.bounty,
		deposited,
		paid: budget.bounty,
		remaining: deposited - budget.bounty,
		maxCandidates: budget.maxCandidates,
		acceptedCount: 1,
		pendingCount: 0,
		rejectedCount: 1,
		recentReviews: reviews,
	});
	console.log(`\n${bold("Pipeline summary")}\n${summary}`);

	console.log(`\n${dim("—".repeat(60))}\n`);
	const design = await draftRole(read("jd-founding-product-designer.txt"));
	printCriteria(design.title, design.summary, design.criteria);
	await printBudget(design.criteria, design.title);
	const lena = readCandidate("candidate-designer.json");
	printReview(lena.name, design.criteria, await reviewSubmissionDetailed(design.criteria, lena));
}

const [command, ...args] = process.argv.slice(2);
const start = Date.now();
switch (command) {
	case "draft": {
		const draft = await draftRole(read(args[0] ?? "jd-senior-rust-solana.txt"));
		printCriteria(draft.title, draft.summary, draft.criteria);
		console.log(`\n${dim(JSON.stringify(draft.criteria))}`);
		break;
	}
	case "budget":
		await printBudget(CriteriaSchema.parse(readJson(args[0] ?? "criteria-senior-rust.json")));
		break;
	case "review": {
		const criteria = CriteriaSchema.parse(readJson(args[0] ?? "criteria-senior-rust.json"));
		const candidate = readCandidate(args[1] ?? "candidate-strong-rust.json");
		printReview(candidate.name, criteria, await reviewSubmissionDetailed(criteria, candidate));
		break;
	}
	case "compare":
		await compare();
		break;
	case "demo":
		await demo();
		break;
	default:
		console.log(
			"Usage: agent <demo | compare | draft <jd.txt> | budget <criteria.json> | review <criteria.json> <candidate.json>>",
		);
		process.exit(command ? 1 : 0);
}
console.log(dim(`\n${providerLabel()} · ${((Date.now() - start) / 1000).toFixed(1)}s`));
