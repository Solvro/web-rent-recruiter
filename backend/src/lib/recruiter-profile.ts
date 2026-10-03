/**
 * A recruiter as the gig rules see them: skills (self / operator-verified / earned / seeded), 90-day stats per
 * gig type, and the quality score (verification v2 §8).
 */
import type { GigType } from "@scout/shared";
import { type Address, address } from "@solana/kit";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { scoutChainInfo } from "../solana/chain.ts";

export type SkillSource = "self" | "operator" | "earned" | "seeded";
export type Skill = { skill: string; source: SkillSource; verifiedBy: string | null; count?: number };
type Stat = { accepted: number; decided: number; advanced: number; flagged: number };
type Stats = Record<GigType | "ALL", Stat>;

const WINDOW_DAYS = 90;
const HALF_LIFE_DAYS = 90;
/** Rejections that say nothing about the recruiter's work: the candidate declined, or was already in the pipeline. */
const NOT_THE_RECRUITERS_FAULT = new Set(["NOT_INTERESTED", "ALREADY_IN_PIPELINE"]);

const empty = (): Stat => ({ accepted: 0, decided: 0, advanced: 0, flagged: 0 });

/** Wilson score lower bound (95%) of a success rate. */
export function wilsonLower(successes: number, trials: number, z = 1.96) {
	if (trials <= 0) return 0;
	const p = successes / trials;
	const denom = 1 + (z * z) / trials;
	const centre = p + (z * z) / (2 * trials);
	const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * trials)) / trials);
	return Math.max(0, (centre - margin) / denom);
}

/** quality = wilson(accepted, decided) × (1 + 0.5·advanced_rate) − 0.25·flagged, as 0–100. */
export function qualityScore(s: Stat) {
	const advancedRate = s.accepted ? s.advanced / s.accepted : 0;
	const raw = wilsonLower(s.accepted, s.decided) * (1 + 0.5 * advancedRate) - 0.25 * s.flagged;
	return Math.max(0, Math.min(100, Math.round(raw * 100)));
}

/** 90-day stats per gig type from deliverables (time-decayed weights), plus labelled seeded demo history. */
export type RealCounts = {
	/** Real work only (no seeded history), all time, unweighted. */
	accepted: Record<GigType, number>;
	rejected: number;
	seededAccepted: number;
};

export async function recruiterStats(
	wallet: string,
): Promise<{ stats: Stats; seeded: boolean; real: RealCounts }> {
	const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000);
	const rows = await db
		.select({
			type: schema.submissions.deliverableType,
			status: schema.submissions.status,
			rejectReason: schema.submissions.rejectReason,
			outcome: schema.submissions.outcome,
			appeal: schema.submissions.appeal,
			at: schema.submissions.submittedAt,
			id: schema.submissions.id,
		})
		.from(schema.submissions)
		.leftJoin(schema.gigs, eq(schema.gigs.id, schema.submissions.gigId))
		.where(
			and(
				// Show-up fees pay for time, not work: they don't count.
				isNull(schema.gigs.purpose),
				eq(schema.submissions.scoutWallet, wallet),
				// A recruiter's own withdrawal isn't a rejection of their work.
				eq(schema.submissions.withdrawn, false),
				eq(schema.submissions.confirmed, true),
				gt(schema.submissions.submittedAt, since),
			),
		);
	const stats = {
		ALL: empty(),
		SOURCING: empty(),
		SCREENING_CALL: empty(),
		REFERENCE_CHECK: empty(),
	} as Stats;
	// A company confirmed a candidate this recruiter sourced was fake, even if nothing was held back any more.
	const fakes = new Set(
		(
			await db
				.select({ id: schema.candidateFlags.submissionId })
				.from(schema.candidateFlags)
				.where(inArray(schema.candidateFlags.kind, ["FABRICATED", "CALL_DENIED"]))
		).map((f) => f.id),
	);
	const real: RealCounts = {
		accepted: { SOURCING: 0, SCREENING_CALL: 0, REFERENCE_CHECK: 0 },
		rejected: 0,
		seededAccepted: 0,
	};
	for (const r of rows) {
		if (r.status === "ACCEPTED" || r.appeal?.status === "OVERTURNED")
			real.accepted[(r.type ?? "SOURCING") as GigType] += 1;
		else if (r.status === "REJECTED") real.rejected += 1;
	}
	for (const r of rows) {
		if (r.status === "PENDING") continue;
		if (r.status === "REJECTED" && r.rejectReason && NOT_THE_RECRUITERS_FAULT.has(r.rejectReason)) continue;
		const w = 0.5 ** ((Date.now() - r.at.getTime()) / (HALF_LIFE_DAYS * 86_400_000));
		for (const key of ["ALL", r.type ?? "SOURCING"] as (GigType | "ALL")[]) {
			const s = stats[key];
			s.decided += w;
			// An overturned appeal counts as accepted: the company agreed the rejection was wrong.
			if (r.status === "ACCEPTED" || r.appeal?.status === "OVERTURNED") s.accepted += w;
			if (r.outcome === "ADVANCED") s.advanced += w;
			if (r.outcome === "FABRICATED" || fakes.has(r.id)) s.flagged += w;
		}
	}
	const seeded = await db
		.select()
		.from(schema.recruiterSeededStats)
		.where(eq(schema.recruiterSeededStats.wallet, wallet));
	for (const r of seeded) {
		real.seededAccepted += r.accepted;
		for (const key of ["ALL", r.gigType] as (GigType | "ALL")[]) {
			stats[key].accepted += r.accepted;
			stats[key].decided += r.decided;
			stats[key].advanced += r.advanced;
		}
	}
	for (const s of Object.values(stats)) {
		s.accepted = Math.round(s.accepted * 10) / 10;
		s.decided = Math.round(s.decided * 10) / 10;
	}
	return { stats, seeded: seeded.length > 0, real };
}

/** Self-declared + operator-verified + seeded skills, and earned ones (accepted gigs per type). */
export async function recruiterSkills(wallet: string, stats?: Stats, real?: RealCounts): Promise<Skill[]> {
	const rows = await db
		.select()
		.from(schema.recruiterSkills)
		.where(eq(schema.recruiterSkills.wallet, wallet));
	const out: Skill[] = rows.map((r) => ({ skill: r.skill, source: r.source, verifiedBy: r.verifiedBy }));
	const got = stats && real ? { stats, real } : await recruiterStats(wallet);
	const s = got.stats;
	// "Earned" counts only real accepted work; seeded demo history is listed as seeded, never as earned.
	const earned: [string, number, number][] = [
		["gig:sourcing", got.real.accepted.SOURCING, s.SOURCING.accepted],
		["gig:screening", got.real.accepted.SCREENING_CALL, s.SCREENING_CALL.accepted],
		["gig:reference", got.real.accepted.REFERENCE_CHECK, s.REFERENCE_CHECK.accepted],
	];
	for (const [skill, n, all] of earned) {
		if (n >= 1) out.push({ skill, source: "earned", verifiedBy: null, count: n });
		else if (all >= 1) out.push({ skill, source: "seeded", verifiedBy: null, count: Math.floor(all) });
	}
	if (s.SCREENING_CALL.accepted >= 3)
		out.push({ skill: "tech-screener", source: "earned", verifiedBy: null });
	return out;
}

/** The agent's RecruiterProfile shape (canClaimGig) + extras for the UI. */
export async function recruiterProfile(wallet: string) {
	const { stats, seeded, real } = await recruiterStats(wallet);
	const skills = await recruiterSkills(wallet, stats, real);
	const info = await scoutChainInfo(address(wallet) as Address).catch(() => null);
	return {
		wallet,
		skills: [...new Set(skills.map((s) => s.skill))],
		stats: Object.fromEntries(
			Object.entries(stats).map(([k, v]) => [k, { accepted: v.accepted, decided: v.decided }]),
		) as Record<GigType | "ALL", { accepted: number; decided: number }>,
		vouched: Boolean(info?.operator),
		details: { skills, stats, seeded, real, operator: info?.operator?.name ?? null },
	};
}

export function reputationScores(stats: Stats) {
	return {
		score: qualityScore(stats.ALL),
		byType: {
			SOURCING: qualityScore(stats.SOURCING),
			SCREENING_CALL: qualityScore(stats.SCREENING_CALL),
			REFERENCE_CHECK: qualityScore(stats.REFERENCE_CHECK),
		},
	};
}
