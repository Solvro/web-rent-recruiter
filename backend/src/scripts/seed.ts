/**
 * Demo data for read-only views (task board, scout profiles). Seeded roles have no on-chain vault: the live demo
 * role is created through the app. Usage:
 *   pnpm seed            # upsert demo data
 *   pnpm seed --reset    # wipe all tables first
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { type AgentReview, type Criteria, toBaseUnits } from "@scout/shared";
import { createKeyPairSignerFromBytes, createKeyPairSignerFromPrivateKeyBytes } from "@solana/kit";
import { sql } from "drizzle-orm";
import { closeDb, db, runMigrations, schema } from "../db/index.ts";
import { candidateHash, newRoleSalt, toHex } from "../lib/candidate-hash.ts";

const reset = process.argv.includes("--reset");

async function walletFromFile(path: string, fallbackSeed: number) {
	const full = resolve(homedir(), path);
	if (existsSync(full)) {
		return (await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(full, "utf8")))))
			.address;
	}
	return deterministicWallet(fallbackSeed);
}
const deterministicWallet = async (n: number) =>
	(await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(n))).address;

const c = (id: string, label: string, weight: number) => ({ id, label, weight });

const roles: {
	company: "demoCompany" | "otherCompany";
	title: string;
	summary: string;
	jobDescription: string;
	criteria: Criteria;
	bountyUsdc: number;
	maxCandidates: number;
	accepted: number;
	pending: number;
}[] = [
	{
		company: "otherCompany",
		title: "Senior Rust Engineer, Payments Infrastructure",
		summary: "Own the ledger and settlement services behind cross-border payouts. Remote within ±3h of CET.",
		jobDescription:
			"Fernway is a cross-border payouts platform used by 1,200 marketplaces. We're hiring a Senior Rust Engineer to own our ledger and settlement services. You will design idempotent payment flows, run Postgres at high write volume, and work with our compliance team on reconciliation. Requirements: 5+ years of backend experience, 2+ years of production Rust, experience with double-entry ledgers or payment systems, strong Postgres skills. Nice to have: experience with ISO 20022, Kafka, or on-call leadership. Remote within ±3h of CET. Salary 150k–190k EUR. English required; Polish or German a plus.",
		criteria: {
			mustHave: [
				c("rust-prod", "2+ years of production Rust", 5),
				c("payments", "Built payment, ledger or settlement systems", 5),
				c("postgres", "Strong Postgres at high write volume", 4),
			],
			niceToHave: [
				c("iso20022", "ISO 20022 / SEPA experience", 2),
				c("kafka", "Kafka or event streaming", 2),
			],
			seniority: "SENIOR",
			location: { mode: "REMOTE", places: ["Europe (CET ±3h)"] },
			salaryRange: { min: 150000, max: 190000, currency: "EUR", period: "YEAR" },
			languages: ["English"],
			dealBreakers: [c("no-backend", "No backend ownership in the last 3 years", 5)],
		},
		bountyUsdc: 30,
		maxCandidates: 8,
		accepted: 2,
		pending: 1,
	},
	{
		company: "otherCompany",
		title: "Product Designer, B2B Onboarding",
		summary: "Redesign self-serve onboarding for a finance product. Hybrid in Warsaw, 2 days a week.",
		jobDescription:
			"Fernway is looking for a Product Designer to own self-serve onboarding for our merchant dashboard. You will run discovery with customers, prototype in Figma, and ship with two engineering squads. Requirements: 3+ years designing B2B SaaS, a portfolio with end-to-end case studies, comfort with data and experiments. Nice to have: fintech or compliance-heavy flows, design systems work. Hybrid in Warsaw (2 days/week). Salary 18k–24k PLN/month.",
		criteria: {
			mustHave: [
				c("b2b-saas", "3+ years designing B2B SaaS", 5),
				c("case-studies", "Portfolio with end-to-end case studies", 4),
			],
			niceToHave: [
				c("fintech", "Fintech or compliance-heavy flows", 3),
				c("design-system", "Design systems work", 2),
			],
			seniority: "MID",
			location: { mode: "HYBRID", places: ["Warsaw"] },
			salaryRange: { min: 18000, max: 24000, currency: "PLN", period: "MONTH" },
			languages: ["English", "Polish"],
			dealBreakers: [],
		},
		bountyUsdc: 20,
		maxCandidates: 10,
		accepted: 1,
		pending: 0,
	},
	{
		company: "otherCompany",
		title: "Founding Account Executive, DACH",
		summary: "First sales hire for the German-speaking market. Remote in Germany or Austria.",
		jobDescription:
			"Fernway is opening the DACH market and needs its first Account Executive there. You will run the full cycle from outbound to close with mid-market marketplaces. Requirements: 4+ years of B2B SaaS closing experience, native-level German, a track record of hitting quota, experience selling to finance or operations buyers. Nice to have: payments or fintech sales, first-sales-hire experience. Remote in Germany or Austria. OTE 120k–150k EUR.",
		criteria: {
			mustHave: [
				c("closing", "4+ years closing B2B SaaS deals", 5),
				c("german", "Native-level German", 5),
				c("quota", "Documented quota attainment", 4),
			],
			niceToHave: [
				c("fintech-sales", "Payments or fintech sales", 3),
				c("first-hire", "Was a first sales hire before", 2),
			],
			seniority: "SENIOR",
			location: { mode: "REMOTE", places: ["Germany", "Austria"] },
			salaryRange: { min: 120000, max: 150000, currency: "EUR", period: "YEAR" },
			languages: ["German", "English"],
			dealBreakers: [c("no-german", "Cannot sell in German", 5)],
		},
		bountyUsdc: 40,
		maxCandidates: 5,
		accepted: 0,
		pending: 1,
	},
];

const candidates = [
	{
		name: "Tomasz Wieczorek",
		profileUrl: "https://www.linkedin.com/in/tomasz-wieczorek-rust",
		notes:
			"6y backend, 3y Rust at a PSP building a settlement engine. Open to remote; notice period 1 month.",
		review: { score: 88, recommendation: "ADVANCE" },
	},
	{
		name: "Ana Ribeiro",
		profileUrl: "https://www.linkedin.com/in/ana-ribeiro-ledger",
		notes: "Led ledger migration at a neobank (Go → Rust). Strong Postgres. Lives in Lisbon, wants remote.",
		review: { score: 81, recommendation: "ADVANCE" },
	},
	{
		name: "Jonas Becker",
		profileUrl: "https://www.linkedin.com/in/jonas-becker-ae",
		notes:
			"Native German, 5y AE at a logistics SaaS, 118% of quota last year. Interested, wants a call next week.",
		review: { score: 74, recommendation: "MAYBE" },
	},
	{
		name: "Zofia Nowak",
		profileUrl: "https://dribbble.com/zofia-nowak",
		notes: "4y product designer at a Warsaw B2B SaaS; portfolio has two onboarding case studies.",
		review: { score: 79, recommendation: "ADVANCE" },
	},
] as const;

function review(
	criteria: Criteria,
	score: number,
	recommendation: AgentReview["recommendation"],
): AgentReview {
	const all = [...criteria.mustHave, ...criteria.niceToHave];
	return {
		score,
		recommendation,
		summary:
			recommendation === "ADVANCE"
				? "Strong match on the must-haves; worth a first call."
				: "Partial match; one must-have needs confirmation in a call.",
		verdicts: all.map((cr, i) => ({
			criterionId: cr.id,
			verdict: i < criteria.mustHave.length ? (score > 80 ? "MET" : "PARTIAL") : "UNKNOWN",
			reasoning:
				i < criteria.mustHave.length
					? `Notes mention experience relevant to "${cr.label}".`
					: "Not covered in the notes.",
		})),
	};
}

await runMigrations();

if (reset) {
	await db.execute(
		sql`truncate table agent_reviews, submissions, tx_log, roles, accounts restart identity cascade`,
	);
	console.log("tables truncated");
}

const demoCompany = await walletFromFile(".config/solana/superrecruiter/client.json", 1);
const demoScout = await walletFromFile(".config/solana/superrecruiter/recruiter.json", 2);
const otherCompany = await deterministicWallet(3);
const scouts = [demoScout, await deterministicWallet(4), await deterministicWallet(5)];

const accountRows = [
	{ wallet: demoCompany, kind: "company" as const, displayName: "Hanna Lis", companyName: "Kestrel Labs" },
	{ wallet: otherCompany, kind: "company" as const, displayName: "Piotr Zając", companyName: "Fernway" },
	{ wallet: scouts[0], kind: "scout" as const, displayName: "Marta Kowalczyk", companyName: null },
	{ wallet: scouts[1], kind: "scout" as const, displayName: "Daniel Okafor", companyName: null },
	{ wallet: scouts[2], kind: "scout" as const, displayName: "Lena Fischer", companyName: null },
];
for (const a of accountRows) {
	await db
		.insert(schema.accounts)
		.values({ ...a, avatarUrl: null })
		.onConflictDoUpdate({
			target: schema.accounts.wallet,
			set: { kind: a.kind, displayName: a.displayName, companyName: a.companyName },
		});
}

const existingTitles = new Set(
	(await db.select({ title: schema.roles.title }).from(schema.roles)).map((r) => r.title),
);
let candidateIdx = 0;
for (const r of roles) {
	if (existingTitles.has(r.title)) continue;
	const bounty = toBaseUnits(r.bountyUsdc);
	const deposited = bounty * BigInt(r.maxCandidates);
	const paid = bounty * BigInt(r.accepted);
	const [role] = await db
		.insert(schema.roles)
		.values({
			companyWallet: r.company === "demoCompany" ? demoCompany : otherCompany,
			title: r.title,
			summary: r.summary,
			jobDescription: r.jobDescription,
			criteria: r.criteria,
			roleSalt: newRoleSalt(),
			bounty,
			maxCandidates: r.maxCandidates,
			reviewWindowSeconds: 72 * 3600,
			feeBps: 1000,
			status: "OPEN",
			deposited,
			paid,
			remaining: deposited - paid,
			acceptedCount: r.accepted,
			pendingCount: r.pending,
		})
		.returning();

	const statuses = [
		...Array<"ACCEPTED">(r.accepted).fill("ACCEPTED"),
		...Array<"PENDING">(r.pending).fill("PENDING"),
	];
	for (const [i, status] of statuses.entries()) {
		const cand = candidates[candidateIdx++ % candidates.length];
		const [sub] = await db
			.insert(schema.submissions)
			.values({
				roleId: role.id,
				scoutWallet: scouts[i % scouts.length],
				candidateName: cand.name,
				profileUrl: cand.profileUrl,
				notes: cand.notes,
				consent: true,
				candidateHash: toHex(candidateHash(role.roleSalt, cand.profileUrl)),
				confirmed: true,
				status,
				submittedAt: new Date(Date.now() - (i + 1) * 26 * 3600 * 1000),
				reviewDeadline: new Date(Date.now() + 48 * 3600 * 1000),
			})
			.returning();
		await db.insert(schema.agentReviews).values({
			submissionId: sub.id,
			review: review(r.criteria, cand.review.score, cand.review.recommendation),
		});
	}
}

console.log(`seeded: demo company ${demoCompany} (Kestrel Labs), demo scout ${demoScout} (Marta Kowalczyk)`);
await closeDb();
