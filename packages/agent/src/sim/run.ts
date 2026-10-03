/**
 * Recruitment Monte Carlo. Offline: no model, no Jev, no network.
 *   pnpm --filter @scout/backend exec tsx src/agent/sim/run.ts [runs]
 */
import { ALL_DEFENSES, NO_DEFENSES, params } from "./model.ts";
import { runMany, type Summary } from "./simulate.ts";

process.env.LLM_PROVIDER = "offline";
process.env.REVIEW_ENGINE = "offline";

const runs = Number(process.argv[2] ?? 1000);
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const usd = (x: number | null) => (x == null ? "–" : `$${x.toFixed(0)}`);

function show(s: Summary) {
	console.log(`\n== ${s.name} (${s.runs} runs)`);
	console.log(
		`  P(≥3 passed screening in 21 days, within budget): ${pct(s.pSuccess)}   P(≥3 truly qualified): ${pct(s.pQualifiedShortlist)}`,
	);
	console.log(`  failures: budget ${s.failures.budget}, time ${s.failures.time}`);
	console.log(
		`  days to shortlist: ${s.days ? `p10 ${s.days.p10} · p50 ${s.days.p50} · p90 ${s.days.p90}` : "–"}   spend p50 ${usd(s.spent.p50)} · p90 ${usd(s.spent.p90)}`,
	);
	console.log(
		`  spend per truly qualified candidate: ${usd(s.spendPerQualified)}   P(≥1 hire from the shortlist): ${pct(s.pHireAvg)}`,
	);
	console.log(
		`  fake share of shortlist: ${pct(s.fakeLeakRate)}   paid to fakes/run: ${usd(s.paidToFakesAvg)}   no-show fees/run: ${usd(s.noShowCostAvg)}   bonds forfeited/run: ${usd(s.bondsForfeitedAvg)}`,
	);
	console.log(
		`  company interrupts/run: ${s.escalationsNowAvg.toFixed(1)}   digest items/run: ${s.escalationsDigestAvg.toFixed(1)}   follow-ups/run: ${s.followUpsAvg.toFixed(1)}   price raises/run: ${s.priceRaisesAvg.toFixed(1)}   replan rungs used: ${
			Object.entries(s.replanShare)
				.map(([k, v]) => `${k} ${pct(v)}`)
				.join(", ") || "none"
		}`,
	);
}

const scenarios = [
	params({ name: "Demo role · $300 · all defenses", budgetUsd: 300 }),
	params({ name: "Production · $1,500 · all defenses", budgetUsd: 1500 }),
	params({ name: "Production · $1,500 · NO defenses", budgetUsd: 1500, defenses: NO_DEFENSES }),
	params({
		name: "Production · $1,500 · defenses but no candidate confirmation",
		budgetUsd: 1500,
		defenses: { ...ALL_DEFENSES, candidateConfirmation: false },
	}),
	params({
		name: "Stress · $1,500 · half the recruiter supply, double no-shows",
		budgetUsd: 1500,
		deliveriesPerDay: 2.5,
		noShowInterested: 0.1,
		screeningCancel: 0.3,
	}),
];
for (const s of scenarios) show(runMany(s, runs));

console.log("\n== Sensitivity: P(success) by budget × sourcing bounty multiplier (all defenses)");
const budgets = [300, 400, 500, 750, 1000, 1500];
const mults = [0.75, 1, 1.25, 1.5];
console.log(`  budget  ${mults.map((m) => `×${m}`.padStart(8)).join("")}`);
for (const b of budgets) {
	const row = mults.map((m) =>
		pct(
			runMany(params({ name: "", budgetUsd: b, bountyMultiplier: m }), Math.min(runs, 400)).pSuccess,
		).padStart(8),
	);
	console.log(`  $${String(b).padEnd(6)}${row.join("")}`);
}
console.log(
	"\nModel, not proof: outcomes depend on the assumptions in src/agent/sim/model.ts (see docs/strategy/recruitment-realism.md).",
);
