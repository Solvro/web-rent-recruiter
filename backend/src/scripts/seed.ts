/**
 * Demo data from docs/research/demo-use-cases.json (anonymized composites, fictional people and companies).
 *
 *   pnpm reset:demo        # chain: close old roles, fresh scout keypairs (devnet), refill company USDC
 *   pnpm seed --reset      # DB: wipe, then seed accounts + read-only roles for the CURRENT keypairs
 *
 * Run them in that order: the seed maps personas onto whatever keypairs reset:demo just wrote.
 *
 * What it creates:
 * - Demo company wallet (client.json) as the main role's company. The main role itself is NOT seeded: it is
 *   created live in the demo (paste backend/src/agent/fixtures/demo-jd-senior-backend-ts.txt).
 * - Ola (recruiter.json = app "scout") and Lucía (scout2.json = app "scout2") with NO history, so their
 *   on-chain reputation starts at 0/0 and the demo shows the first payout.
 * - Andreea on a seeded wallet, with history on the read-only roles (her specialty: Java, DACH sales).
 * - The 3 other roles as OPEN but unfunded (no vault): visible on the task board, submit returns 409.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { type AgentReview, type Criteria, toBaseUnits } from "@scout/shared";
import {
	type Address,
	createKeyPairSignerFromBytes,
	createKeyPairSignerFromPrivateKeyBytes,
} from "@solana/kit";
import { eq, sql } from "drizzle-orm";
import { closeDb, db, runMigrations, schema } from "../db/index.ts";
import { env } from "../env.ts";
import { demoAvatar } from "../lib/avatars.ts";
import { candidateHash, newRoleSalt, toHex } from "../lib/candidate-hash.ts";
import { splitBounty } from "../lib/money.ts";
import { backfillSlugs } from "../lib/slug.ts";
import { loadDeployment } from "../solana/chain.ts";

type UseCases = {
	recruiters: { key: string; displayName: string; country: string; specialty: string }[];
	roles: {
		key: string;
		demo?: boolean;
		title: string;
		company: string;
		locationLabel: string;
		salaryLabel: string;
		jobDescription: string;
		criteria: Criteria;
		bountyUsd: number;
		maxCandidates: number;
	}[];
};

const data = JSON.parse(
	readFileSync(resolve(env.repoRoot, "docs/research/demo-use-cases.json"), "utf8"),
) as UseCases;
const reset = process.argv.includes("--reset");

/** Canonical demo story (Stream C): backend/src/agent/fixtures/demo-manifest.json → role file. */
const DEMO_ROLE = JSON.parse(
	readFileSync(new URL("../agent/fixtures/demo-role-senior-backend-ts.json", import.meta.url), "utf8"),
) as { title: string; company: string; founder: string; budgetUsd: number };

const avatar = demoAvatar;

/** Short, generic company names shown in the UI (no real clients). Keyed by role. */
const COMPANY: Record<string, { companyName: string; contact: string }> = {
	// The live demo role's company comes from Stream C's canonical fixture (demo-manifest.json).
	"senior-backend-ts": { companyName: DEMO_ROLE.company, contact: DEMO_ROLE.founder },
	"forward-deployed-engineer": {
		companyName: "Pre-seed robotics startup · Zürich",
		contact: "Felix Brunner",
	},
	"account-executive-dach": { companyName: "Growth-stage B2B SaaS · Kraków", contact: "Agnieszka Sowa" },
	"java-backend-insurance": { companyName: "Enterprise insurtech vendor · Poland", contact: "Marek Duda" },
};

/** Read-only history so the seeded roles and Andreea's profile don't look empty. Fictional, `-demo` slugs. */
const HISTORY: Record<
	string,
	{
		name: string;
		card: { currentTitle: string; currentCompany: string; location: string };
		profileUrl: string;
		notes: string;
		status: "ACCEPTED" | "PENDING";
		score: number;
		recommendation: AgentReview["recommendation"];
	}[]
> = {
	"java-backend-insurance": [
		{
			name: "Marek Zieliński",
			profileUrl: "https://linkedin.com/in/marek-zielinski-java-demo",
			card: {
				currentTitle: "Lead Java Developer",
				currentCompany: "Regional insurer (P&C)",
				location: "Łódź, Poland",
			},
			notes:
				"9 years of Java, the last 5 on a policy administration system at a Polish insurer (Spring Boot, Kafka, Oracle → Postgres migration). Led a team of 4. Lives in Łódź, fine with 3 office days. Wants 26k PLN B2B; 1 month notice.",
			status: "ACCEPTED",
			score: 88,
			recommendation: "ADVANCE",
		},
		{
			name: "Julia Kowalska",
			profileUrl: "https://linkedin.com/in/julia-kowalska-backend-demo",
			card: {
				currentTitle: "Senior Kotlin/Java Engineer",
				currentCompany: "Payments bank",
				location: "Gdańsk, Poland",
			},
			notes:
				"6 years of Java/Kotlin in banking (payments, Spring). No insurance domain yet but has done claims-like workflow engines. Based in Gdańsk, hybrid OK. Expects 24k PLN employment contract.",
			status: "PENDING",
			score: 71,
			recommendation: "MAYBE",
		},
	],
	"account-executive-dach": [
		{
			name: "Lukas Brandt",
			profileUrl: "https://linkedin.com/in/lukas-brandt-sales-demo",
			card: {
				currentTitle: "Account Executive, DACH",
				currentCompany: "CMMS SaaS vendor",
				location: "Kraków, Poland",
			},
			notes:
				"Native German, moved to Kraków in 2024. 4 years closing mid-market SaaS deals for a CMMS vendor (facility managers, plant maintenance), 112% of quota last year. Wants base 20k PLN + commission.",
			status: "ACCEPTED",
			score: 84,
			recommendation: "ADVANCE",
		},
	],
	"forward-deployed-engineer": [],
};

const keypairAddress = async (path: string, fallbackSeed: number): Promise<Address> => {
	const full = resolve(homedir(), path);
	if (existsSync(full)) {
		const bytes = Uint8Array.from(JSON.parse(readFileSync(full, "utf8")) as number[]);
		return (await createKeyPairSignerFromBytes(bytes)).address;
	}
	return seededAddress(fallbackSeed);
};
const seededAddress = async (n: number) =>
	(await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(n))).address;

function review(
	criteria: Criteria,
	score: number,
	recommendation: AgentReview["recommendation"],
): AgentReview {
	return {
		score,
		recommendation,
		summary:
			recommendation === "ADVANCE"
				? "Meets every must-have in the notes; worth a first call this week."
				: "Solid background, but one must-have is only partly covered and needs a call to confirm.",
		verdicts: [
			...criteria.mustHave.map((c, i) => ({
				criterionId: c.id,
				verdict: (score >= 80 || i > 0 ? "MET" : "PARTIAL") as "MET" | "PARTIAL",
				reasoning: `The notes describe experience that matches "${c.label}".`,
			})),
			...criteria.niceToHave.map((c) => ({
				criterionId: c.id,
				verdict: "UNKNOWN" as const,
				reasoning: "Not mentioned in the recruiter's notes.",
			})),
		],
	};
}

function splitColumns(bounty: bigint) {
	const s = splitBounty(bounty, 1000, 0, env.holdbackBps);
	return { payoutNow: s.now, payoutLater: s.later, operatorFee: s.operatorFee, platformFee: s.platformFee };
}

await runMigrations();
if (reset) {
	await db.execute(
		sql`truncate table agent_reviews, submissions, tx_log, roles, accounts restart identity cascade`,
	);
	console.log("tables truncated");
}

// ---- Accounts ----------------------------------------------------------------

const demoCompany = await keypairAddress(".config/solana/superrecruiter/client.json", 1);
const recruiterWallets: Record<string, Address> = {
	ola: await keypairAddress(".config/solana/superrecruiter/recruiter.json", 2),
	lucia: await keypairAddress(".config/solana/superrecruiter/scout2.json", 3),
	andreea: await seededAddress(4),
};
const companyWallets: Record<string, Address> = {};
for (const [i, role] of data.roles.entries()) {
	companyWallets[role.key] = role.demo ? demoCompany : await seededAddress(10 + i);
}

const accounts = [
	...data.roles.map((r) => ({
		wallet: companyWallets[r.key],
		kind: "company" as const,
		displayName: COMPANY[r.key]?.contact ?? "Hiring manager",
		companyName: COMPANY[r.key]?.companyName ?? r.company,
	})),
	...data.recruiters.map((r) => ({
		wallet: recruiterWallets[r.key],
		kind: "scout" as const,
		displayName: r.displayName,
		companyName: null,
	})),
];
for (const a of accounts) {
	const set = {
		kind: a.kind,
		displayName: a.displayName,
		companyName: a.companyName,
		avatarUrl: avatar(a.displayName),
	};
	await db
		.insert(schema.accounts)
		.values({ wallet: a.wallet, ...set })
		.onConflictDoUpdate({ target: schema.accounts.wallet, set });
}

// ---- Read-only roles (everything except the live demo role) -------------------

const existingTitles = new Set(
	(await db.select({ title: schema.roles.title }).from(schema.roles)).map((r) => r.title),
);
for (const r of data.roles) {
	if (r.demo || existingTitles.has(r.title)) continue;
	const history = HISTORY[r.key] ?? [];
	const accepted = history.filter((h) => h.status === "ACCEPTED").length;
	const pending = history.filter((h) => h.status === "PENDING").length;
	const bounty = toBaseUnits(r.bountyUsd);
	const deposited = bounty * BigInt(r.maxCandidates);
	const paid = bounty * BigInt(accepted);
	const [role] = await db
		.insert(schema.roles)
		.values({
			companyWallet: companyWallets[r.key],
			title: r.title,
			summary: `${r.locationLabel}. ${r.salaryLabel}.`,
			jobDescription: r.jobDescription,
			criteria: r.criteria,
			roleSalt: newRoleSalt(),
			bounty,
			maxCandidates: r.maxCandidates,
			reviewWindowSeconds: 72 * 3600,
			feeBps: 1000,
			holdbackBps: env.holdbackBps,
			holdbackWindowSeconds: env.holdbackWindowSeconds,
			status: "OPEN",
			deposited,
			paid,
			remaining: deposited - paid,
			acceptedCount: accepted,
			pendingCount: pending,
		})
		.returning();

	for (const [i, h] of history.entries()) {
		const submittedAt = new Date(Date.now() - (i + 1) * 30 * 3600 * 1000);
		const [sub] = await db
			.insert(schema.submissions)
			.values({
				roleId: role.id,
				scoutWallet: recruiterWallets.andreea,
				candidateName: h.name,
				candidateAvatarUrl: avatar(h.name),
				candidateTitle: h.card.currentTitle,
				candidateCompany: h.card.currentCompany,
				candidateLocation: h.card.location,
				profileUrl: h.profileUrl,
				notes: h.notes,
				consent: true,
				candidateHash: toHex(candidateHash(role.roleSalt, h.profileUrl)),
				confirmed: true,
				status: h.status,
				// Old placements: confirmed long ago, held-back part already paid out.
				...(h.status === "ACCEPTED"
					? {
							...splitColumns(bounty),
							holdbackDeadline: new Date(submittedAt.getTime() + 96 * 3600 * 1000),
							outcome: "ADVANCED" as const,
							laterStatus: "RELEASED" as const,
						}
					: {}),
				submittedAt,
				reviewDeadline: new Date(submittedAt.getTime() + 72 * 3600 * 1000),
			})
			.returning();
		await db
			.insert(schema.agentReviews)
			.values({ submissionId: sub.id, review: review(r.criteria, h.score, h.recommendation) });
	}
}

const main = data.roles.find((r) => r.demo);
console.log(`seeded ${accounts.length} accounts and ${data.roles.length - 1} read-only roles`);
console.log(
	`  company  ${demoCompany}  ${COMPANY[main?.key ?? ""]?.companyName} (creates "${DEMO_ROLE.title}" live)`,
);
console.log(`  scout    ${recruiterWallets.ola}  Ola Wiśniewska`);
console.log(`  scout2   ${recruiterWallets.lucia}  Lucía Fernández`);
console.log("  fixtures backend/src/agent/fixtures/demo-*");
// ---- Demo personas: skills + seeded history (labelled "seeded demo history" in the UI, never on-chain) ----
// Ola (vouched by the demo operator) qualifies for screening and reference gigs; Lucía is a sourcing recruiter.
const operatorName =
	(loadDeployment() as unknown as { operator?: { name?: string } } | null)?.operator?.name ?? "the operator";
const PERSONAS: {
	wallet: Address;
	skills: { skill: string; source: "self" | "operator" | "seeded" }[];
	stats: {
		gigType: "SOURCING" | "SCREENING_CALL" | "REFERENCE_CHECK";
		accepted: number;
		decided: number;
		advanced: number;
	}[];
}[] = [
	{
		wallet: recruiterWallets.ola,
		skills: [
			{ skill: "engineer:rust", source: "self" },
			{ skill: "engineer:solana", source: "self" },
			{ skill: "lang:pl:native", source: "self" },
			{ skill: "lang:en:C2", source: "self" },
			{ skill: "tech-screener", source: "operator" },
		],
		stats: [
			{ gigType: "SOURCING", accepted: 14, decided: 17, advanced: 5 },
			{ gigType: "SCREENING_CALL", accepted: 6, decided: 7, advanced: 3 },
			{ gigType: "REFERENCE_CHECK", accepted: 3, decided: 3, advanced: 1 },
		],
	},
	{
		wallet: recruiterWallets.lucia,
		skills: [
			{ skill: "engineer:typescript", source: "self" },
			{ skill: "lang:es:native", source: "self" },
			{ skill: "lang:en:C2", source: "self" },
		],
		stats: [{ gigType: "SOURCING", accepted: 4, decided: 6, advanced: 1 }],
	},
	{
		wallet: recruiterWallets.andreea,
		skills: [
			{ skill: "engineer:java", source: "self" },
			{ skill: "lang:ro:native", source: "self" },
			{ skill: "lang:de:C2", source: "self" },
		],
		stats: [{ gigType: "SOURCING", accepted: 9, decided: 12, advanced: 2 }],
	},
];
for (const p of PERSONAS) {
	await db.delete(schema.recruiterSkills).where(eq(schema.recruiterSkills.wallet, p.wallet));
	await db.delete(schema.recruiterSeededStats).where(eq(schema.recruiterSeededStats.wallet, p.wallet));
	await db.insert(schema.recruiterSkills).values(
		p.skills.map((k) => ({
			wallet: p.wallet,
			skill: k.skill,
			source: k.source,
			verifiedBy: k.source === "operator" ? operatorName : null,
		})),
	);
	await db.insert(schema.recruiterSeededStats).values(p.stats.map((x) => ({ wallet: p.wallet, ...x })));
}
// One line each on the public profile (editable by the recruiter).
const BIOS: [Address, string][] = [
	[
		recruiterWallets.ola,
		"Tech recruiter in Kraków; I screen Rust and backend engineers and write notes companies can act on.",
	],
	[
		recruiterWallets.lucia,
		"Sourcer in Valencia; I find senior engineers in the Solana and DeFi community before they hit the job boards.",
	],
	[
		recruiterWallets.andreea,
		"Recruiter in Bucharest for Java teams and DACH sales roles; fluent in German and English.",
	],
];
for (const [wallet, bio] of BIOS)
	await db.update(schema.accounts).set({ bio }).where(eq(schema.accounts.wallet, wallet));
console.log(
	`  personas: skills + seeded demo history (Ola: screening-eligible, verified by ${operatorName})`,
);

await backfillSlugs(db);
await closeDb();
