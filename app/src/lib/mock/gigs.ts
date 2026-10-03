/**
 * In-browser stand-in for the agent orchestrator (docs/agent-gigs.md). It plans gigs for a funded role, reviews
 * every deliverable a few seconds after it arrives, pays for accepted work, books screening and reference calls
 * for strong candidates and builds the shortlist. A simulated recruiter (Andreea) fills gigs nobody picks up, so a
 * company-only demo still moves. Everything time-based runs in `tick()`, so it survives reloads.
 * Responses use the shared gig schemas (packages/shared/src/gigs.ts).
 */
import type {
	AgentActivity,
	AgentReview,
	AppealView,
	Criteria,
	Deliverable,
	DeliverableView,
	GigType,
	GigView,
	RoleStatusView,
	ScriptQuestion,
} from "@scout/shared";
import {
	explorerTxUrl,
	type RecruiterReputation as RecruiterReputationSchema,
	type RecruiterSkill as RecruiterSkillSchema,
	toBaseUnits,
} from "@scout/shared";
import type { z } from "zod";
import languageCheck from "../../../../backend/src/agent/fixtures/language-karolina-english.json";
import referenceGood from "../../../../backend/src/agent/fixtures/reference-karolina.json";
import screeningGood from "../../../../backend/src/agent/fixtures/screening-karolina-good.json";
import { canClaimGig, gigRequirements, repriceRule } from "../../../../backend/src/agent/gigs/pure";
import { formatMoney } from "../format";
import type { CandidateCall, CandidateDetail, CandidateStage, RoleCandidate } from "../gigs/candidates";
import { planGigs, withLevel } from "../gigs/plan";
import type { RoleActivityView, ShortlistItemView } from "../gigs/schemas";
import { splitBounty } from "../payout";
import { PERSONAS } from "../personas";
import {
	answerConfirmation,
	confirmationFor,
	confirmationOf,
	confirmProcedures,
	createConfirmation,
} from "./confirm";
import fixtures from "./demo-data.json";
import { avatarFor, candidateInfo } from "./people";
import { hasRecording, recallProcedures, transcriptOf } from "./recall";
import {
	ANDREEA,
	candidateHash,
	db,
	ensureSeeded,
	fakeSignature,
	type MockRole,
	mockEvents,
	newId,
	normalizeProfileUrl,
	persist,
	registerTx,
	reviewFor,
} from "./store";

// ---- state -------------------------------------------------------------------------------------------------

type Person = { id: string; name: string; profileUrl: string };

type MockGig = {
	id: string;
	roleId: string;
	type: GigType;
	variant: "standard" | "language" | null;
	title: string;
	brief: string;
	bounty: bigint;
	holdbackBps: number;
	maxDeliverables: number;
	acceptedCount: number;
	exclusive: boolean;
	claimant: string | null;
	status: "OPEN" | "CLOSED";
	candidate: Person | null;
	script: ScriptQuestion[] | null;
	createdAt: string;
	claimedAt?: string;
	/** Times the candidate didn't join the call. */
	noShows?: number;
	/** Raises by the agent when nobody takes the gig, oldest first. */
	priceHistory?: { bounty: bigint; at: string; reason: string }[];
};

type MockDelivery = {
	id: string;
	gigId: string;
	roleId: string;
	scout: string;
	type: GigType;
	payload: Deliverable;
	hash: string | null;
	status: "PENDING" | "ACCEPTED" | "REJECTED";
	reasons: string[];
	reviewedAt: string | null;
	candidateReview: AgentReview | null;
	submittedAt: string;
	reviewAt: number;
	split: { now: bigint; later: bigint; operatorFee: bigint; platformFee: bigint } | null;
	laterStatus: "NONE" | "HELD" | "RELEASED" | "REFUNDED";
	laterReleasesAt: string | null;
	outcome: "NONE" | "ADVANCED";
	settlementTx: string | null;
	followUps?: { question: string; askedAt: string; answer: string | null; answeredAt: string | null }[];
	/** MAYBE: waiting for the company to say yes or no in the thread. */
	escalated?: boolean;
	/** The role is reviewed by the company or its own agent: logged once as waiting. */
	awaitingReviewer?: boolean;
	/** Sourcing: pre-accepted by the agent, paid only after the candidate confirms on /c/<token>. */
	confirmToken?: string | null;
	confirmExpiresAt?: number | null;
};

type MockShortlist = {
	candidateId: string;
	roleId: string;
	sourceDeliveryId: string;
	agentNote: string;
	screening: { summary: string; recommendation: string; recruiter: string } | null;
	reference: { summary: string; recommendation: string; recruiter: string } | null;
	decision: "NONE" | "INVITED" | "ATTENDED" | "PASSED";
	decidedAt: string | null;
};

/** One line of the agent thread: shared AgentActivity, plus a "why" the UI can expand. */
type Entry = {
	id: string;
	roleId: string;
	kind: AgentActivity["kind"];
	message: string;
	detail: string | null;
	gigId: string | null;
	deliverableId: string | null;
	signature: string | null;
	createdAt: string;
};

type Agenda = { at: number; roleId: string; action: string; ref?: string };

const g = {
	gigs: new Map<string, MockGig>(),
	deliveries: new Map<string, MockDelivery>(),
	entries: new Map<string, Entry[]>(),
	shortlist: new Map<string, MockShortlist>(),
	agenda: [] as Agenda[],
	started: new Set<string>(),
	paused: new Set<string>(),
	/** Who checks the work per role (default: the Scout agent). */
	reviewers: new Map<string, Reviewer>(),
	/** Recruiters' requests to look again at a rejection, by deliverable. */
	appeals: new Map<string, AppealView>(),
};
type Reviewer = { mode: "scout" | "custom" | "self"; agentPubkey: string | null };
const reviewerOf = (roleId: string): Reviewer =>
	g.reviewers.get(roleId) ?? { mode: "scout", agentPubkey: null };

const KEY = "scout.mock-gigs.v3";
const big = (_k: string, v: unknown) => (typeof v === "bigint" ? { $big: v.toString() } : v);
const unbig = (_k: string, v: unknown) =>
	v && typeof v === "object" && "$big" in v ? BigInt((v as { $big: string }).$big) : v;

function save() {
	try {
		sessionStorage.setItem(
			KEY,
			JSON.stringify(
				{
					gigs: [...g.gigs],
					deliveries: [...g.deliveries],
					entries: [...g.entries],
					shortlist: [...g.shortlist],
					agenda: g.agenda,
					started: [...g.started],
					paused: [...g.paused],
					reviewers: [...g.reviewers],
					appeals: [...g.appeals],
				},
				big,
			),
		);
	} catch {
		// storage unavailable
	}
	persist();
}

function load() {
	try {
		const raw = sessionStorage.getItem(KEY);
		if (!raw) return false;
		const d = JSON.parse(raw, unbig);
		g.gigs = new Map(d.gigs);
		g.deliveries = new Map(d.deliveries);
		g.entries = new Map(d.entries);
		g.shortlist = new Map(d.shortlist);
		g.agenda = d.agenda;
		g.started = new Set(d.started);
		g.paused = new Set(d.paused);
		g.reviewers = new Map(d.reviewers ?? []);
		g.appeals = new Map(d.appeals ?? []);
		return true;
	} catch {
		return false;
	}
}

export function resetGigs() {
	try {
		sessionStorage.removeItem(KEY);
	} catch {
		// ignore
	}
}

// ---- helpers -----------------------------------------------------------------------------------------------

const SECOND = 1000;
const HOLDBACK_WINDOW_MS = 15 * 60 * SECOND;
const REVIEW_DELAY_MS = 4 * SECOND;
/** How long a candidate has to confirm (48 h in production). */
const CONFIRM_WINDOW_MS = 5 * 60 * SECOND;
const first = (name: string) => name.split(" ")[0] ?? name;
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const displayName = (wallet: string) => db.profiles.get(wallet)?.displayName ?? "A recruiter";

function log(roleId: string, kind: Entry["kind"], message: string, extra: Partial<Entry> = {}) {
	const list = g.entries.get(roleId) ?? [];
	list.push({
		id: newId("act"),
		roleId,
		kind,
		message,
		detail: null,
		gigId: null,
		deliverableId: null,
		signature: null,
		createdAt: iso(),
		...extra,
	});
	g.entries.set(roleId, list.slice(-80));
	mockEvents.emit({ type: kind === "AGENT_MESSAGE" ? "agent.message" : "agent.tool", roleId });
}

function screeningScript(criteria: Criteria, name: string): ScriptQuestion[] {
	const who = first(name);
	const place = criteria.location.places[0] ?? "the office city";
	return [
		...criteria.mustHave.slice(0, 3).map((c) => ({
			id: `q-${c.id}`,
			question: `${c.label}: ask ${who} for a concrete example. What did they build, and what was their part?`,
			whatGoodLooksLike: "A specific system, its size, and what they personally did.",
			criterionId: c.id,
		})),
		{
			id: "q-move",
			question: `Why is ${who} open to a move, and when could they start? Is ${criteria.location.mode === "REMOTE" ? "the time zone" : `working in ${place}`} fine?`,
			whatGoodLooksLike: "A real reason, a start date, a clear yes or no on location.",
		},
		{
			id: "q-salary",
			question: "What salary are they expecting?",
			whatGoodLooksLike: "A range and the contract type.",
		},
	];
}

function languageScript(language: string, name: string): ScriptQuestion[] {
	const who = first(name);
	return [
		{
			id: "l-work",
			question: `In ${language}: ask ${who} to describe their current project.`,
			whatGoodLooksLike: "Fluency, vocabulary, how naturally they explain.",
		},
		{
			id: "l-hard",
			question: `In ${language}: ask about a hard technical trade-off they made.`,
			whatGoodLooksLike: "Can they argue a point, not just describe.",
		},
		{
			id: "l-level",
			question: "Which level did you hear (B2, C1, C2) and why?",
			whatGoodLooksLike: "A level and one concrete reason.",
		},
	];
}

function referenceScript(name: string): ScriptQuestion[] {
	const who = first(name);
	return [
		{
			id: "r-how",
			question: `How did you work with ${who}, and for how long?`,
			whatGoodLooksLike: "Role, team, duration.",
		},
		{ id: "r-best", question: `What was ${who} best at?`, whatGoodLooksLike: "One concrete example." },
		{ id: "r-support", question: `Where did ${who} need support?`, whatGoodLooksLike: "An honest weakness." },
		{
			id: "r-again",
			question: `Would you hire ${who} again? Why?`,
			whatGoodLooksLike: "A clear yes or no with a reason.",
		},
	];
}

/** "Senior Rust Engineer" → "Senior Rust Engineers"; titles with a qualifier stay as they are. */
const plural = (title: string) => (title.includes(",") ? `candidates for ${title}` : `${title}s`);

function postGig(
	role: MockRole,
	type: GigType,
	candidate?: Person,
	variant: "standard" | "language" | null = null,
) {
	const kind = variant === "language" ? "LANGUAGE_CHECK" : type;
	const plan = planOf(role).gigs.find((p) => p.kind === kind);
	const language = role.criteria.languages[0] ?? "English";
	const price = plan?.price ?? toBaseUnits(5);
	const who = candidate?.name ?? "";
	const place = role.criteria.location.places[0];
	const gig: MockGig = {
		id: newId("gig"),
		roleId: role.id,
		type,
		variant: type === "SCREENING_CALL" ? (variant ?? "standard") : null,
		title:
			variant === "language"
				? `Language check with ${who}: ${withLevel(language)}`
				: type === "SOURCING"
					? `Find ${plural(role.title.replace(/\s*\(.*\)/, ""))}${place ? ` in ${place}` : ""}`
					: type === "SCREENING_CALL"
						? `Screening call with ${who}`
						: `Reference call for ${who}`,
		brief:
			variant === "language"
				? `A 15-minute call in ${language} with ${first(who)}. Ask the agent's questions and note the level you heard.`
				: type === "SOURCING"
					? "Profiles that meet the must-haves and are open to a move. Paid per profile the agent accepts."
					: type === "SCREENING_CALL"
						? `A 30-minute call with ${first(who)}. Go through the agent's questions and write down the answers. Paid for complete, concrete answers.`
						: `Talk to someone who worked with ${first(who)} and answer the agent's questions.`,
		bounty: price,
		// The last 30% of a screening arrives when the candidate reaches the company (demo script).
		holdbackBps: type === "SCREENING_CALL" && variant !== "language" ? 3000 : 0,
		maxDeliverables: type === "SOURCING" ? (plan?.count ?? 20) : 1,
		acceptedCount: 0,
		exclusive: type !== "SOURCING",
		claimant: null,
		status: "OPEN",
		candidate: candidate ?? null,
		script:
			variant === "language"
				? languageScript(language.replace(/\s*\(.*\)$/, ""), who)
				: type === "SCREENING_CALL"
					? screeningScript(role.criteria, who)
					: type === "REFERENCE_CHECK"
						? referenceScript(who)
						: null,
		createdAt: iso(),
	};
	g.gigs.set(gig.id, gig);
	mockEvents.emit({ type: "gig.posted", roleId: role.id });
	return gig;
}

function schedule(roleId: string, inMs: number, action: string, ref?: string) {
	g.agenda.push({ at: Date.now() + inMs, roleId, action, ref });
}

// ---- the agent run -----------------------------------------------------------------------------------------

/** The role's plan for what the company put in (seeded roles: their whole deposit). */
const planOf = (role: MockRole) => planGigs(role.criteria, Math.max(50, Number(role.deposited / 1_000_000n)));

/** Called when a role is funded: plan, post the sourcing gig, and line up the simulated market. */
export function startAgent(roleId: string) {
	const role = db.roles.get(roleId);
	if (!role || g.started.has(roleId)) return;
	g.started.add(roleId);
	const plan = planOf(role);
	log(roleId, "PLANNED", "Planned the work", {
		detail: [
			...plan.gigs.map((p) => `${p.label}: ${p.count} × ${formatMoney(p.price)}`),
			`${formatMoney(plan.reserve)} in reserve`,
		].join(" · "),
	});
	log(
		roleId,
		"AGENT_MESSAGE",
		"I'm finding candidates first. You'll hear from me when someone is worth your time.",
	);
	const gig = postGig(role, "SOURCING");
	log(
		roleId,
		"GIG_POSTED",
		`Posted ${gig.maxDeliverables} sourcing gigs at ${formatMoney(gig.bounty)} each`,
		{
			gigId: gig.id,
		},
	);
	schedule(roleId, 8 * SECOND, "sim-source", "tomasz");
	schedule(roleId, 14 * SECOND, "sim-source", "piotr");
	schedule(roleId, 120 * SECOND, "sim-source", "karolina");
	save();
}

const SIM_CANDIDATES: Record<string, { name: string; profileUrl: string; notes: string }> = {
	...Object.fromEntries(
		fixtures.demoSubmissions
			.filter((s) => !s.intent.startsWith("duplicate"))
			.map((s) => [first(s.candidate.name).toLowerCase(), s.candidate]),
	),
	marek: {
		name: "Marek Zieliński",
		profileUrl: "https://linkedin.com/in/marek-zielinski-backend-demo",
		notes:
			"Founding engineer at a computer-vision startup: 6 years of TypeScript and Node.js backends in production, built their real-time WebSocket event pipeline and the public API customers use, on call. Fluent English, moving to Warsaw, fine with 2 office days.",
	},
};

async function simDeliverSourcing(roleId: string, key: string) {
	const c = SIM_CANDIDATES[key];
	const gig = [...g.gigs.values()].find(
		(x) => x.roleId === roleId && x.type === "SOURCING" && x.status === "OPEN",
	);
	if (!c || !gig) return;
	const hash = await candidateHash(db.roles.get(roleId)?.salt ?? "", c.profileUrl);
	if ([...g.deliveries.values()].some((d) => d.roleId === roleId && d.hash === hash)) return;
	addDelivery(
		gig,
		ANDREEA,
		{ type: "SOURCING", name: c.name, profileUrl: c.profileUrl, notes: c.notes, consent: true },
		hash,
	);
}

/** Stream C's canonical deliverables (backend/src/agent/fixtures), mapped onto the mock scripts in order. */
const SIM_SCREENING_BY_ID = new Map(screeningGood.answers.map((a) => [a.questionId, a.answer]));
const SIM_SCREENING = (q: ScriptQuestion, i: number) =>
	SIM_SCREENING_BY_ID.get(q.id) ??
	(q.id === "q-move"
		? `${SIM_SCREENING_BY_ID.get("q-motivation")} ${SIM_SCREENING_BY_ID.get("q-only-remote")}`
		: q.id === "q-salary"
			? SIM_SCREENING_BY_ID.get("q-logistics")
			: undefined) ??
	screeningGood.answers[i]?.answer ??
	"Answered with concrete examples.";
const SIM_LANGUAGE = languageCheck.answers.map((a) => a.answer);
const SIM_REFERENCE = referenceGood.answers.map((a) => a.answer);

function simScreening(gig: MockGig) {
	if (gig.claimant && gig.claimant !== ANDREEA) return;
	gig.claimant = ANDREEA;
	if (gig.variant === "language") {
		const script = gig.script ?? [];
		addDelivery(gig, ANDREEA, {
			type: "SCREENING_CALL",
			recommendation: "ADVANCE",
			assessedLevel: "C1",
			answers: script.map((q, i) => ({
				questionId: q.id,
				answer:
					i === script.length - 1
						? "C1: fluent and precise, one small article slip she corrected herself."
						: (SIM_LANGUAGE[i] ?? "Clear."),
			})),
		});
		return;
	}
	addDelivery(gig, ANDREEA, {
		type: "SCREENING_CALL",
		recommendation: "ADVANCE",
		answers: (gig.script ?? []).map((q, i) => ({
			questionId: q.id,
			answer: SIM_SCREENING(q, i),
		})),
	});
}

function simReference(gig: MockGig) {
	if (gig.claimant && gig.claimant !== ANDREEA) return;
	gig.claimant = ANDREEA;
	const who = first(gig.candidate?.name ?? "");
	const strong = who === "Karolina";
	const answers = strong
		? SIM_REFERENCE
		: [
				`I worked with ${who} for a year and a half on the same product team.`,
				"Reliable and fast on the pipeline work, very good at explaining trade-offs to product.",
				"Early on, saying no to scope creep. Grew out of it quickly.",
				"Yes. A solid senior hire, happiest with a clear owner role.",
			];
	addDelivery(gig, ANDREEA, {
		type: "REFERENCE_CHECK",
		refereeName: "Former engineering manager",
		refereeRelation: "Managed them for two years",
		recommendation: "ADVANCE",
		answers: (gig.script ?? []).map((q, i) => ({ questionId: q.id, answer: answers[i] ?? "Positive." })),
	});
}

function addDelivery(
	gig: MockGig,
	scout: string,
	payload: Deliverable,
	hash: string | null = null,
	id = newId("dlv"),
) {
	const d: MockDelivery = {
		id,
		gigId: gig.id,
		roleId: gig.roleId,
		scout,
		type: gig.type,
		payload,
		hash,
		status: "PENDING",
		reasons: [],
		reviewedAt: null,
		candidateReview: null,
		submittedAt: iso(),
		reviewAt: Date.now() + REVIEW_DELAY_MS,
		split: null,
		laterStatus: "NONE",
		laterReleasesAt: null,
		outcome: "NONE",
		settlementTx: null,
	};
	g.deliveries.set(d.id, d);
	mockEvents.emit({ type: "gig.delivered", roleId: gig.roleId, submissionId: d.id });
	// Narrate every arrival, so nothing changes silently in the company's thread.
	log(gig.roleId, "DELIVERY_RECEIVED", `${displayName(scout)} delivered ${whatOf(d)}`, {
		gigId: gig.id,
		deliverableId: d.id,
		detail: reviewerOf(gig.roleId).mode === "scout" ? "Checking it now." : undefined,
	});
	if (reviewerOf(gig.roleId).mode !== "scout") d.awaitingReviewer = true;
	return d;
}

function pay(d: MockDelivery, gig: MockGig) {
	const role = db.roles.get(gig.roleId);
	const scout = db.profiles.get(d.scout);
	if (!role) return null;
	const split = splitBounty(gig.bounty, role.feeBps, gig.holdbackBps, scout?.operator?.feeBps ?? 0);
	const paidNow = gig.bounty - split.later;
	role.balance -= paidNow;
	role.paid += paidNow;
	role.heldBack += split.later;
	d.split = {
		now: split.now,
		later: split.later,
		operatorFee: split.operatorFee,
		platformFee: split.platformFee,
	};
	d.laterStatus = split.later > 0n ? "HELD" : "NONE";
	d.laterReleasesAt = split.later > 0n ? iso(Date.now() + HOLDBACK_WINDOW_MS) : null;
	d.settlementTx = fakeSignature();
	if (scout) {
		scout.balance += split.now;
		scout.earned += split.now;
	}
	gig.acceptedCount++;
	if (gig.acceptedCount >= gig.maxDeliverables) gig.status = "CLOSED";
	mockEvents.emit({
		type: "submission.accepted",
		roleId: role.id,
		submissionId: d.id,
		signature: d.settlementTx,
		scout: d.scout,
		payout: split.now.toString(),
	});
	return d.settlementTx;
}

function releaseHeld(d: MockDelivery, advanced: boolean) {
	const role = db.roles.get(d.roleId);
	const later = d.split?.later ?? 0n;
	if (!role || d.laterStatus !== "HELD") return;
	role.balance -= later;
	role.heldBack -= later;
	role.paid += later;
	d.laterStatus = "RELEASED";
	if (advanced) d.outcome = "ADVANCED";
	const scout = db.profiles.get(d.scout);
	if (scout) {
		scout.balance += later;
		scout.earned += later;
		if (advanced) scout.advanced++;
	}
	mockEvents.emit({
		type: advanced ? "submission.outcome" : "submission.released",
		roleId: role.id,
		submissionId: d.id,
		signature: fakeSignature(),
		scout: d.scout,
		payout: later.toString(),
	});
}

/** "a profile: Karolina Mazurek" / "screening notes for Karolina Mazurek" */
function whatOf(d: MockDelivery) {
	const gig = g.gigs.get(d.gigId);
	if (d.payload.type === "SOURCING") return `a profile: ${d.payload.name}`;
	if (d.payload.type === "REFERENCE_CHECK")
		return `a reference check for ${gig?.candidate?.name ?? "a candidate"}`;
	return `${gig?.variant === "language" ? "a language check" : "screening notes"} for ${gig?.candidate?.name ?? "a candidate"}`;
}

/** The company (or its own agent) accepts: the same next steps as when the Scout agent accepts. */
function acceptByReviewer(d: MockDelivery) {
	const role = db.roles.get(d.roleId);
	if (!role) return;
	d.awaitingReviewer = false;
	if (d.payload.type === "SOURCING") {
		d.candidateReview ??= reviewFor(role.criteria, {
			name: d.payload.name,
			profileUrl: d.payload.profileUrl,
			notes: d.payload.notes,
		});
		d.reviewedAt = null;
		preAccept(d);
		return;
	}
	review(d);
}

function reject(d: MockDelivery, reason: string) {
	d.status = "REJECTED";
	d.reasons = [reason];
	d.reviewedAt = iso();
}

/** The agent's review of one deliverable. */
function review(d: MockDelivery) {
	const gig = g.gigs.get(d.gigId);
	const role = db.roles.get(d.roleId);
	if (!gig || !role) return;
	const from = displayName(d.scout);
	const p = d.payload;
	const ids = { gigId: gig.id, deliverableId: d.id };

	if (p.type === "SOURCING") {
		const r = reviewFor(role.criteria, { name: p.name, profileUrl: p.profileUrl, notes: p.notes });
		d.candidateReview = r;
		if (r.score < 50) {
			reject(d, `Doesn't meet the must-haves (score ${r.score})`);
			log(role.id, "DELIVERY_REJECTED", `Passed on ${p.name}'s profile`, { ...ids, detail: r.summary });
			return;
		}
		if (r.score < 75) {
			// MAYBE: the agent doesn't pay on its own; it asks the company.
			d.escalated = true;
			// A real recruiter can fill the gap the agent saw.
			if (d.scout !== ANDREEA)
				d.followUps = [
					{
						question: `What is the strongest sign that ${first(p.name)} meets: ${role.criteria.mustHave[1]?.label ?? "the must-haves"}?`,
						askedAt: iso(),
						answer: null,
						answeredAt: null,
					},
				];
			log(role.id, "ESCALATED", `Asked you about ${p.name}'s profile · ${r.score}`, {
				...ids,
				detail: r.summary,
			});
			log(
				role.id,
				"AGENT_MESSAGE",
				`${first(p.name)} is a maybe. I won't pay ${formatMoney(gig.bounty)} without your yes.`,
			);
			return;
		}
		preAccept(d);
		return;
	}

	const thin = p.answers.filter((a) => a.answer.trim().length < 12).length;
	const expected = gig.script?.length ?? 0;
	if (thin > 0 || p.answers.length < expected) {
		reject(
			d,
			`${thin || expected - p.answers.length} answer${thin === 1 ? " is" : "s are"} missing or too short`,
		);
		log(role.id, "DELIVERY_REJECTED", `Sent back the notes for ${gig.candidate?.name}`, {
			...ids,
			detail: d.reasons[0],
		});
		gig.claimant = d.scout; // they can try again
		return;
	}
	d.status = "ACCEPTED";
	d.reviewedAt = iso();
	const sig = pay(d, gig);
	const candidateId = gig.candidate?.id ?? "";
	const entry = g.shortlist.get(candidateId);

	if (p.type === "SCREENING_CALL" && gig.variant === "language") {
		log(role.id, "DELIVERY_ACCEPTED", `Language check for ${gig.candidate?.name} passed`, {
			...ids,
			detail: `From ${from}. ${p.answers.at(-1)?.answer ?? ""}`,
			signature: sig,
		});
		return;
	}

	if (p.type === "SCREENING_CALL") {
		log(role.id, "DELIVERY_ACCEPTED", `Screening notes for ${gig.candidate?.name} check out`, {
			...ids,
			detail: `From ${from}. Every question answered with concrete examples.`,
			signature: sig,
		});
		const source = g.deliveries.get(candidateId);
		g.shortlist.set(candidateId, {
			candidateId,
			roleId: role.id,
			sourceDeliveryId: candidateId,
			agentNote: source?.candidateReview?.summary ?? "",
			screening: {
				summary: p.answers
					.slice(0, 2)
					.map((a) => a.answer)
					.join(" "),
				recommendation: p.recommendation,
				recruiter: from,
			},
			reference: entry?.reference ?? null,
			decision: entry?.decision ?? "NONE",
			decidedAt: entry?.decidedAt ?? null,
		});
		log(role.id, "SHORTLISTED", `Added ${gig.candidate?.name} to your shortlist`, ids);
		log(
			role.id,
			"AGENT_MESSAGE",
			`${first(gig.candidate?.name ?? "")} looks strong. The call notes are in your shortlist${p.recommendation === "ADVANCE" ? ", and I'm checking a reference now" : ""}.`,
		);
		if (p.recommendation === "ADVANCE" && gig.candidate) {
			const rg = postGig(role, "REFERENCE_CHECK", gig.candidate);
			log(role.id, "GIG_POSTED", `Asked for a reference check on ${gig.candidate.name}`, {
				gigId: rg.id,
				detail: formatMoney(rg.bounty),
			});
			schedule(
				role.id,
				(first(gig.candidate.name) === "Karolina" ? 120 : 15) * SECOND,
				"sim-reference",
				rg.id,
			);
		}
		return;
	}

	log(role.id, "DELIVERY_ACCEPTED", `Reference check passed for ${gig.candidate?.name}`, {
		...ids,
		detail: `${p.refereeName}: ${p.answers.at(-1)?.answer ?? ""}`,
		signature: sig,
	});
	if (entry)
		entry.reference = {
			summary: `${p.refereeName}: ${p.answers[1]?.answer ?? ""} ${p.answers.at(-1)?.answer ?? ""}`.trim(),
			recommendation: p.recommendation,
			recruiter: from,
		};
}

/** Pre-accepted: nothing is paid until the candidate confirms they are open to a conversation. */
function preAccept(d: MockDelivery) {
	const gig = g.gigs.get(d.gigId);
	const role = db.roles.get(d.roleId);
	const p = d.payload;
	const r = d.candidateReview;
	if (!gig || !role || p.type !== "SOURCING" || !r) return;
	const from = displayName(d.scout);
	const ids = { gigId: gig.id, deliverableId: d.id };
	const location = role.criteria.location;
	const salary = role.criteria.salaryRange;
	d.confirmExpiresAt = Date.now() + CONFIRM_WINDOW_MS;
	d.confirmToken = createConfirmation({
		candidateFirstName: first(p.name),
		recruiterName: from,
		roleTitle: role.title,
		companyDescriptor: role.companyName,
		// One public sentence about the company from its job post; never the internal brief.
		summary:
			role.jobDescription
				.split("\n")
				.map((l) => l.trim())
				.find((l) => l.length > 60)
				?.split(/(?<=\.)\s/)[0] ?? "",
		expiresAt: iso(d.confirmExpiresAt),
		location:
			location.mode === "REMOTE"
				? "Remote"
				: [location.places.join(", "), location.mode === "HYBRID" ? "hybrid" : null]
						.filter(Boolean)
						.join(", ") || null,
		salaryLabel: salary
			? `${salary.min.toLocaleString("en-US")}–${salary.max.toLocaleString("en-US")} ${salary.currency} a ${salary.period === "YEAR" ? "year" : "month"}`
			: null,
	});
	log(
		role.id,
		"REVIEWED",
		`${r.score >= 75 ? `${p.name}'s profile fits · ${r.score}` : `Taking ${p.name}, as you asked`}. Waiting for ${first(p.name)} to confirm`,
		{
			...ids,
			detail: `From ${from}. ${r.summary} I pay once ${first(p.name)} confirms they are open to a call.`,
		},
	);
	// Simulated recruiters' candidates answer on their own; the demo recruiter sends the link herself.
	if (d.scout === ANDREEA) schedule(role.id, 6 * SECOND, "sim-confirm", d.id);
}

/** The candidate said yes: now the sourcing work is accepted and paid, and the next gigs follow. */
function acceptSourcing(d: MockDelivery) {
	const gig = g.gigs.get(d.gigId);
	const role = db.roles.get(d.roleId);
	const p = d.payload;
	const r = d.candidateReview;
	if (!gig || !role || p.type !== "SOURCING" || !r) return;
	const from = displayName(d.scout);
	const ids = { gigId: gig.id, deliverableId: d.id };
	d.status = "ACCEPTED";
	d.reviewedAt = iso();
	const sig = pay(d, gig);
	log(role.id, "DELIVERY_ACCEPTED", `${first(p.name)} confirmed. Accepted ${p.name}'s profile · ${r.score}`, {
		...ids,
		detail: `From ${from}. ${r.summary}`,
		signature: sig,
	});
	const booked = [...g.gigs.values()].filter(
		(x) => x.roleId === role.id && x.type === "SCREENING_CALL",
	).length;
	const cap = planOf(role).gigs.find((x) => x.kind === "SCREENING_CALL")?.count ?? 3;
	if (r.score >= 75 && booked < cap && !g.paused.has(role.id)) {
		const sg = postGig(role, "SCREENING_CALL", { id: d.id, name: p.name, profileUrl: p.profileUrl });
		log(role.id, "GIG_POSTED", `Booked a screening call for ${p.name}`, {
			gigId: sg.id,
			detail: `${sg.script?.length ?? 0} questions in the script · ${formatMoney(sg.bounty)}`,
		});
		// Nobody takes it? Andreea does, after a while. The demo recruiter (Ola) usually takes Karolina's.
		schedule(role.id, (first(p.name) === "Karolina" ? 150 : 12) * SECOND, "sim-screening", sg.id);
		// Same gig type, different script: a short language check.
		const lg = postGig(
			role,
			"SCREENING_CALL",
			{ id: d.id, name: p.name, profileUrl: p.profileUrl },
			"language",
		);
		log(
			role.id,
			"GIG_POSTED",
			`Booked a language check, ${withLevel(role.criteria.languages[0] ?? "English")}, for ${p.name}`,
			{
				gigId: lg.id,
				detail: `${lg.script?.length ?? 0} questions · ${formatMoney(lg.bounty)}`,
			},
		);
		schedule(role.id, 20 * SECOND, "sim-screening", lg.id);
	}
}

/** Scripted replies to the company's instructions; the backend runs the real agent. */
function reply(roleId: string, text: string) {
	const role = db.roles.get(roleId);
	if (!role) return;
	const lower = text.toLowerCase();
	if (/\b(pause|stop|hold)\b/.test(lower)) {
		g.paused.add(roleId);
		log(roleId, "PAUSED", "Paused new screening calls");
		log(
			roleId,
			"AGENT_MESSAGE",
			"Paused. I won't book new screening calls until you tell me to continue. Profiles in review will still be checked.",
		);
		return;
	}
	if (/\b(resume|continue|go on|start again)\b/.test(lower)) {
		g.paused.delete(roleId);
		log(roleId, "RESUMED", "Resumed screening calls");
		log(roleId, "RESUMED", "Resumed");
		log(roleId, "AGENT_MESSAGE", "Back on it. I'll book screenings for strong profiles again.");
		return;
	}
	const why = /\bwhy\b/.test(lower)
		? (g.entries.get(roleId) ?? [])
				.filter((e) => e.kind === "DELIVERY_REJECTED")
				.find((e) =>
					e.message
						.split(/\s+/)
						.some((w) => w.length > 3 && lower.includes(w.toLowerCase().replace(/[^a-ząćęłńóśźż]/g, ""))),
				)
		: undefined;
	if (why) {
		log(
			roleId,
			"AGENT_MESSAGE",
			`${why.detail ?? "It didn't meet the must-haves."} I didn't pay for that profile, and the recruiter saw the same reason.`,
		);
		return;
	}
	if (/how many|so far|progress|how is it going|how's it going/.test(lower)) {
		const p = roleStatus(roleId).pipeline;
		log(
			roleId,
			"AGENT_MESSAGE",
			`${p.sourcingAccepted} of ${p.sourcingSlots} profiles accepted, ${p.confirmed} confirmed by the candidate, ${p.screeningDone} screened, ${p.shortlisted} on your shortlist.`,
		);
		return;
	}
	if (/waiting|what.*(doing|up to)|status/.test(lower)) {
		const s = roleStatus(roleId);
		const lines = s.waitingOn.map(
			(w) =>
				`· ${w.what.replace(/^You to/, "You to")}${w.deadline ? ` (until ${new Date(w.deadline).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})` : ""}`,
		);
		log(
			roleId,
			"AGENT_MESSAGE",
			lines.length
				? `Right now I'm waiting for:\n${lines.join("\n")}`
				: "Nothing is pending. I'm watching for new deliveries.",
		);
		return;
	}
	const asked = [...g.deliveries.values()].find(
		(d) => d.roleId === roleId && d.escalated && d.status === "PENDING" && !d.confirmToken,
	);
	if (asked && asked.payload.type === "SOURCING" && /\b(yes|take|ok|go ahead|no|skip|pass)\b/.test(lower)) {
		const name = asked.payload.name;
		asked.escalated = false;
		if (/\b(no|skip|pass)\b/.test(lower)) {
			reject(asked, "The company decided not to take this profile");
			log(roleId, "DELIVERY_REJECTED", `Passed on ${name}'s profile`, {
				gigId: asked.gigId,
				deliverableId: asked.id,
				detail: "You said no.",
			});
			log(roleId, "AGENT_MESSAGE", `OK, I passed on ${first(name)}. Nothing was paid.`);
		} else {
			preAccept(asked);
			log(
				roleId,
				"AGENT_MESSAGE",
				`OK. I'll pay for ${first(name)} once they confirm they're open to a call.`,
			);
		}
		return;
	}
	const skill = text.match(/\b(golang|go|rust|python|java|kotlin|kubernetes|aws|react)\b/i)?.[1];
	if (skill || /\bmore\b/.test(lower)) {
		const gig = [...g.gigs.values()].find((x) => x.roleId === roleId && x.type === "SOURCING");
		if (skill) {
			const label = /^go(lang)?$/i.test(skill) ? "Go" : skill[0].toUpperCase() + skill.slice(1);
			role.criteria.niceToHave.push({ id: `extra-${label.toLowerCase()}`, label, weight: 3 });
			log(roleId, "CRITERIA_UPDATED", `Added ${label} to the nice-to-haves`);
		}
		if (gig) {
			gig.maxDeliverables += 10;
			gig.status = "OPEN";
			log(roleId, "GIG_POSTED", `Opened 10 more profile slots · ${formatMoney(gig.bounty)} each`, {
				gigId: gig.id,
			});
		}
		log(
			roleId,
			"AGENT_MESSAGE",
			`Done. I'm asking recruiters for 10 more profiles${skill ? `, preferring people with ${skill}` : ""}.`,
		);
		return;
	}
	log(roleId, "AGENT_MESSAGE", "Noted. I'll take that into account for the next candidates.");
}

let ticking = false;
/** Runs everything that is due: agent reviews, replies and the simulated market. */
export async function tick() {
	if (ticking) return;
	ticking = true;
	try {
		await ensureGigs();
		const now = Date.now();
		let changed = false;
		for (const d of g.deliveries.values())
			if (d.status === "PENDING" && !d.reviewedAt && !d.confirmToken && !d.escalated && d.reviewAt <= now) {
				const reviewer = reviewerOf(d.roleId);
				if (reviewer.mode === "scout") review(d);
				else if (!d.awaitingReviewer) d.awaitingReviewer = true;
				else continue;
				changed = true;
			}
		for (const d of g.deliveries.values()) {
			if (d.status !== "PENDING" || !d.confirmToken) continue;
			const answer = confirmationOf(d.confirmToken)?.status;
			const expired = answer === "PENDING" && (d.confirmExpiresAt ?? Infinity) <= now;
			if (expired) answerConfirmation(d.confirmToken, "EXPIRED");
			if (answer === "YES") acceptSourcing(d);
			else if (answer === "NO" || answer === "EXPIRED" || expired) {
				const name = d.payload.type === "SOURCING" ? d.payload.name : "the candidate";
				reject(
					d,
					answer === "NO"
						? `${first(name)} isn't open to a move right now`
						: `${first(name)} didn't confirm in time`,
				);
				log(d.roleId, "DELIVERY_REJECTED", `${name} didn't confirm`, {
					gigId: d.gigId,
					deliverableId: d.id,
					detail: d.reasons[0],
				});
			} else continue;
			changed = true;
		}
		const due = g.agenda.filter((a) => a.at <= now);
		if (due.length) {
			g.agenda = g.agenda.filter((a) => a.at > now);
			changed = true;
			for (const a of due) {
				const gig = a.ref ? g.gigs.get(a.ref) : undefined;
				if (a.action === "sim-source" && a.ref) await simDeliverSourcing(a.roleId, a.ref);
				if (a.action === "sim-screening" && gig?.status === "OPEN") simScreening(gig);
				if (a.action === "sim-reference" && gig?.status === "OPEN") simReference(gig);
				if (a.action === "reply" && a.ref) reply(a.roleId, a.ref);
				const dlv = a.ref ? g.deliveries.get(a.ref) : undefined;
				if (a.action === "sim-confirm" && dlv?.confirmToken) answerConfirmation(dlv.confirmToken, "YES");
			}
		}
		for (const d of g.deliveries.values())
			if (d.laterStatus === "HELD" && d.laterReleasesAt && Date.parse(d.laterReleasesAt) <= now) {
				releaseHeld(d, false);
				changed = true;
			}
		if (changed) save();
	} finally {
		ticking = false;
	}
}

// ---- seed --------------------------------------------------------------------------------------------------

let seeded: Promise<void> | null = null;
export function ensureGigs() {
	seeded ??= (async () => {
		await ensureSeeded();
		if (load()) return;
		// Other companies' roles: live gigs for the board, plus some paid history for Ola.
		const others = [...db.roles.values()].filter((r) => r.companyWallet !== PERSONAS.company.mockAddress);
		for (const role of others) {
			g.started.add(role.id);
			postGig(role, "SOURCING");
		}
		const fde = others.find((r) => r.title.startsWith("Forward Deployed"));
		const src = fde && [...g.gigs.values()].find((x) => x.roleId === fde.id && x.type === "SOURCING");
		if (fde && src) {
			for (const [i, name] of ["Marek Zieliński", "Julia Kowalska"].entries()) {
				const d = addDelivery(src, PERSONAS.scout.mockAddress, {
					type: "SOURCING",
					name,
					profileUrl: `https://linkedin.com/in/${name.toLowerCase().replace(/[^a-z]+/g, "-")}-fde-demo`,
					notes: "Seeded history",
					consent: true,
				});
				d.status = "ACCEPTED";
				d.reviewedAt = d.submittedAt = iso(Date.now() - (4 - i) * 86_400_000);
				pay(d, src);
				releaseHeld(d, true);
			}
			const julia = [...g.deliveries.values()].find(
				(d) => d.payload.type === "SOURCING" && d.payload.name === "Julia Kowalska",
			);
			if (julia) {
				const jg = postGig(fde, "SCREENING_CALL", {
					id: julia.id,
					name: "Julia Kowalska",
					profileUrl: "https://linkedin.com/in/julia-kowalska-fde-demo",
				});
				// Nobody took it for a day: the agent raised the price (its own repricing rule).
				const usd = Number(jg.bounty / 1_000_000n);
				const raise = repriceRule({
					gig: { taskType: "SCREENING_CALL", bounty: usd, maxDeliverables: 1, acceptedCount: 0 },
					hoursOpen: 30,
					claims: 0,
					deliveries: 0,
					maxBounty: usd * 2,
					budgetAvailable: usd * 4,
				});
				if (raise.action === "raise") {
					jg.priceHistory = [{ bounty: jg.bounty, at: iso(Date.now() - 6 * 3600_000), reason: raise.reason }];
					jg.bounty = toBaseUnits(raise.bounty);
				}
			}
		}
		save();
	})();
	return seeded;
}

// ---- views -------------------------------------------------------------------------------------------------

/** Redacted: a descriptive line instead of the person (no name, photo, link). */
function candidateFor(c: Person, redact: boolean) {
	const card = candidateInfo(c.name);
	const role = [...g.gigs.values()].find((x) => x.candidate?.id === c.id)?.roleId;
	const seniority = (role && db.roles.get(role)?.criteria.seniority) || null;
	const summary = {
		headline: card.currentTitle
			? `${card.currentTitle}${card.currentCompany ? ` at ${card.currentCompany}` : ""}`
			: "Candidate",
		city: card.location,
		seniority,
	};
	if (!redact) return { redacted: false, summary, id: c.id, name: c.name, profileUrl: c.profileUrl, card };
	return { redacted: true, summary, id: null, name: null, profileUrl: null, card: null };
}

/** Call bookkeeping on a gig (asked from Stream B): no-shows and when it was taken. */
type CallState = { noShows: number; claimedAt: string | null };

function gigView(gig: MockGig, wallet: string | null): GigView & CallState {
	const redacted = gig.exclusive && gig.claimant !== wallet;
	const role = db.roles.get(gig.roleId);
	const split = splitBounty(gig.bounty, role?.feeBps ?? 1000, gig.holdbackBps, 0);
	const claimer = gig.claimant ? db.profiles.get(gig.claimant) : null;
	const pending = [...g.deliveries.values()].filter(
		(d) => d.gigId === gig.id && d.status === "PENDING",
	).length;
	return {
		id: gig.id,
		roleId: gig.roleId,
		roleTitle: role?.title ?? "",
		companyName: role?.companyName ?? "",
		type: gig.type,
		variant: gig.variant,
		status: gig.status,
		city: role?.criteria.location.mode === "REMOTE" ? null : (role?.criteria.location.places[0] ?? null),
		remote: role?.criteria.location.mode === "REMOTE",
		// Redacted viewers get a title and brief without the candidate's name.
		title: redacted
			? gig.variant === "language"
				? "Language check"
				: gig.type === "SCREENING_CALL"
					? "Screening call"
					: "Reference call"
			: gig.title,
		brief: redacted
			? gig.type === "SCREENING_CALL"
				? "A 30-minute call with the candidate. Go through the agent's questions and write down the answers. Paid for complete, concrete answers."
				: "Talk to someone who worked with the candidate and answer the agent's questions."
			: gig.brief,
		// Privacy: who the candidate is, and the script, only for the recruiter who took the gig.
		script: redacted ? null : gig.script,
		candidate: gig.candidate ? candidateFor(gig.candidate, redacted) : null,
		bounty: gig.bounty.toString(),
		payout: { now: split.now.toString(), later: split.later.toString() },
		maxDeliverables: gig.maxDeliverables,
		acceptedCount: gig.acceptedCount,
		pendingCount: pending,
		slotsLeft: Math.max(0, gig.maxDeliverables - gig.acceptedCount - pending),
		exclusive: gig.exclusive,
		claimant: gig.claimant
			? {
					wallet: gig.claimant,
					displayName: claimer?.displayName ?? "A recruiter",
					avatarUrl: avatarFor(claimer?.displayName ?? ""),
				}
			: null,
		claimedByMe: !!wallet && gig.claimant === wallet,
		redacted,
		taskAddress: null,
		createdAt: gig.createdAt,
		...access(gig, wallet),
		priceHistory: (gig.priceHistory ?? []).map((p) => ({ ...p, bounty: p.bounty.toString() })),
		noShows: gig.noShows ?? 0,
		claimedAt: gig.claimedAt ?? null,
	};
}

/**
 * Who may take the gig: the agent's own rules (gigRequirements / canClaimGig) applied to the recruiter's
 * accepted work in this mock plus their seeded demo history.
 */
function access(gig: MockGig, wallet: string | null) {
	const role = db.roles.get(gig.roleId);
	const variant = gig.variant === "language" ? "language" : undefined;
	const req = role
		? gigRequirements({ taskType: gig.type, variant, criteria: role.criteria })
		: { minTrust: null, bondForUnvouched: false, requiredSkills: [], preferredSkills: [], summary: "" };
	const requirements = {
		minAccepted: req.minTrust?.minAccepted ?? 0,
		minRate: req.minTrust?.minAcceptanceRate ?? 0,
		windowDays: req.minTrust?.windowDays ?? 90,
		skills: req.requiredSkills,
		summary: req.summary,
	};
	if (!wallet || db.profiles.get(wallet)?.kind !== "scout") return { requirements, eligibility: null };
	const sourcer = gig.candidate ? g.deliveries.get(gig.candidate.id)?.scout : undefined;
	return {
		requirements,
		eligibility: canClaimGig(req, recruiterProfile(wallet), { taskType: gig.type, sourcerWallet: sourcer }),
	};
}

/** Seeded demo history: Ola is an experienced, vouched screener; Lucía is new. */
const HISTORY: Record<string, { skills: string[]; accepted: number; decided: number; screenings: number }> = {
	[PERSONAS.scout.mockAddress]: {
		skills: ["tech-screener", "lang:en:C2", "lang:pl:native"],
		accepted: 14,
		decided: 16,
		screenings: 5,
	},
	[PERSONAS.scout2.mockAddress]: {
		skills: ["lang:es:native", "lang:en:C2"],
		accepted: 3,
		decided: 4,
		screenings: 0,
	},
	[ANDREEA]: {
		skills: ["tech-screener", "engineer:rust", "lang:en:native", "lang:ro:native"],
		accepted: 60,
		decided: 66,
		screenings: 20,
	},
};

type RecruiterSkill = z.infer<typeof RecruiterSkillSchema>;
type RecruiterReputation = z.infer<typeof RecruiterReputationSchema>;

/** Skills by source and the quality score per gig type (shared RecruiterSkill / RecruiterReputation). */
export function recruiterStanding(
	wallet: string,
): { skills: RecruiterSkill[]; score: RecruiterReputation } | null {
	const p = db.profiles.get(wallet);
	if (p?.kind !== "scout") return null;
	const h = HISTORY[wallet];
	const prof = recruiterProfile(wallet);
	const mine = [...g.deliveries.values()].filter((d) => d.scout === wallet && d.status !== "PENDING");
	const of = (type: GigType) => {
		const done = mine.filter((d) => d.type === type);
		const seeded =
			type === "SCREENING_CALL"
				? (h?.screenings ?? 0)
				: type === "SOURCING"
					? (h?.accepted ?? 0) - (h?.screenings ?? 0)
					: 0;
		const ok = done.filter((d) => d.status === "ACCEPTED").length + Math.max(0, seeded);
		const all =
			done.length + Math.max(0, seeded) + (type === "SOURCING" ? (h ? h.decided - h.accepted : 0) : 0);
		return wilson(ok, all);
	};
	const operator = p.operator?.name ?? null;
	const skills: RecruiterSkill[] = prof.skills.map((skill) => ({
		skill,
		source: skill === "tech-screener" && operator ? "operator" : h ? "seeded" : "self",
		verifiedBy: skill === "tech-screener" ? operator : null,
	}));
	const screenings = prof.stats.SCREENING_CALL?.accepted ?? 0;
	if (screenings)
		skills.push({ skill: "screening-calls", source: "earned", verifiedBy: null, count: screenings });
	const byType = {
		SOURCING: of("SOURCING"),
		SCREENING_CALL: of("SCREENING_CALL"),
		REFERENCE_CHECK: of("REFERENCE_CHECK"),
	};
	const all = prof.stats.ALL ?? { accepted: 0, decided: 0 };
	return { skills, score: { score: wilson(all.accepted, all.decided), byType, seededHistory: !!h } };
}

/** 0–100: the lower bound of the acceptance rate (Wilson, 90% confidence), so a short lucky streak scores low. */
function wilson(ok: number, n: number) {
	if (!n) return 0;
	const z = 1.645;
	const p = ok / n;
	const lower =
		(p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / (1 + (z * z) / n);
	return Math.round(Math.max(0, lower) * 100);
}

export function recruiterProfile(wallet: string) {
	const h = HISTORY[wallet] ?? { skills: [], accepted: 0, decided: 0, screenings: 0 };
	const mine = [...g.deliveries.values()].filter((d) => d.scout === wallet && d.status !== "PENDING");
	const ok = (type?: GigType) =>
		mine.filter((d) => d.status === "ACCEPTED" && (!type || d.type === type)).length;
	const all = (type?: GigType) => mine.filter((d) => !type || d.type === type).length;
	return {
		wallet,
		skills: h.skills,
		vouched: !!db.profiles.get(wallet)?.operator,
		stats: {
			ALL: { accepted: h.accepted + ok(), decided: h.decided + all() },
			SCREENING_CALL: {
				accepted: h.screenings + ok("SCREENING_CALL"),
				decided: h.screenings + all("SCREENING_CALL"),
			},
		},
	};
}

function deliverableView(d: MockDelivery): DeliverableView {
	const gig = g.gigs.get(d.gigId);
	return {
		id: d.id,
		gigId: d.gigId,
		gigType: d.type,
		gigTitle: gig?.title ?? "",
		roleId: d.roleId,
		roleTitle: db.roles.get(d.roleId)?.title ?? "",
		status: d.status,
		review: d.reviewedAt
			? {
					verdict: d.status === "ACCEPTED" ? "ACCEPT" : "REJECT",
					reasons: d.reasons,
					candidateReview: d.candidateReview,
					reviewedAt: d.reviewedAt,
				}
			: null,
		deliverable: d.payload,
		payout: d.split
			? {
					now: d.split.now.toString(),
					later: d.split.later.toString(),
					operatorFee: d.split.operatorFee.toString(),
					platformFee: d.split.platformFee.toString(),
					laterReleasesAt: d.laterReleasesAt,
					outcome: d.outcome,
					laterStatus: d.laterStatus,
				}
			: null,
		submittedAt: d.submittedAt,
		settlementTx: d.settlementTx,
		confirmation: d.confirmToken ? confirmationFor(d.confirmToken) : null,
		appeal: g.appeals.get(d.id) ?? null,
		followUps: d.followUps ?? [],
	};
}

function status(roleId: string) {
	if (g.paused.has(roleId)) return "Paused";
	const gigs = [...g.gigs.values()].filter((x) => x.roleId === roleId);
	const dels = [...g.deliveries.values()].filter((d) => d.roleId === roleId);
	const open = (pred: (x: MockGig) => boolean) => gigs.filter((x) => x.status === "OPEN" && pred(x)).length;
	if (dels.some((d) => d.status === "PENDING" && d.escalated)) return "Waiting for your answer";
	if (!g.started.has(roleId)) return "Getting ready";
	const screening = open((x) => x.type === "SCREENING_CALL" && x.variant !== "language");
	if (screening)
		return `Screening · ${screening} call${screening === 1 ? "" : "s"} booked · notes usually within a day`;
	if (open((x) => x.type === "REFERENCE_CHECK")) return "Checking a reference";
	if ([...g.shortlist.values()].some((s) => s.roleId === roleId)) return "Shortlist ready";
	const sourcing = gigs.find((x) => x.type === "SOURCING" && x.status === "OPEN");
	const people = new Set(dels.filter((d) => d.gigId === sourcing?.id).map((d) => d.scout)).size;
	const accepted = dels.filter((d) => d.type === "SOURCING" && d.status === "ACCEPTED").length;
	return accepted
		? `Sourcing · ${accepted} profile${accepted === 1 ? "" : "s"} accepted`
		: `Sourcing · ${Math.max(3, people)} recruiters on it`;
}

function working(roleId: string) {
	if (g.agenda.some((a) => a.roleId === roleId && a.action === "reply")) return "Thinking";
	const d = [...g.deliveries.values()].find(
		(x) => x.roleId === roleId && x.status === "PENDING" && !x.reviewedAt && !x.escalated && !x.confirmToken,
	);
	if (!d) return null;
	if (d.payload.type === "SOURCING") return `Reviewing ${d.payload.name}'s profile`;
	const who = g.gigs.get(d.gigId)?.candidate?.name;
	return d.type === "SCREENING_CALL"
		? `Checking the screening notes for ${who}`
		: `Checking the reference for ${who}`;
}

const HOUR = 3_600_000;
const REASON_TEXT: Record<string, string> = {
	NOT_MATCHING: "Not a match for the role",
	NOT_INTERESTED: "Not interested",
	ALREADY_IN_PIPELINE: "Already in our pipeline",
	OTHER: "Other",
};
const KIND_WORD = (gig: MockGig) =>
	gig.variant === "language"
		? "language check"
		: gig.type === "REFERENCE_CHECK"
			? "reference check"
			: "screening call";

/**
 * Everything the cockpit needs at a glance: what the agent is doing now, who it is waiting for (with deadlines),
 * the pipeline counts, the budget, when it next looks again, and what needs the company. (Asked from Stream B as
 * roles.status.)
 */
function roleStatus(roleId: string): RoleStatusView {
	const role = db.roles.get(roleId);
	const gigs = [...g.gigs.values()].filter((x) => x.roleId === roleId);
	const dels = [...g.deliveries.values()].filter((d) => d.roleId === roleId);
	const entries = g.entries.get(roleId) ?? [];
	const plan = role ? planOf(role) : { gigs: [], reserve: 0n };
	const target = (kind: string) => plan.gigs.find((p) => p.kind === kind)?.count ?? 0;
	const kindOfGig = (gig?: MockGig) => (!gig ? "" : gig.variant === "language" ? "LANGUAGE_CHECK" : gig.type);
	const accepted = (kind: string) =>
		dels.filter((d) => kindOfGig(g.gigs.get(d.gigId)) === kind && d.status === "ACCEPTED").length;
	const nameOf = (d: MockDelivery) => (d.payload.type === "SOURCING" ? d.payload.name : "");

	type W = RoleStatusView["waitingOn"][number];
	const waitingOn: W[] = [];
	// Demo time: "usual" durations are minutes, so slow states show up during a demo.
	const MIN = 60_000;
	const wait = (
		who: W["who"],
		what: string,
		since: string,
		extra: {
			deadline?: string | null;
			gigId?: string | null;
			deliverableId?: string | null;
			usualMs?: number;
			actions?: W["actions"];
		} = {},
	) => {
		const expectedBy = extra.usualMs ? iso(Date.parse(since) + extra.usualMs) : null;
		waitingOn.push({
			who,
			what,
			since,
			deadline: extra.deadline ?? null,
			gigId: extra.gigId ?? null,
			deliverableId: extra.deliverableId ?? null,
			expectedBy,
			slow: expectedBy ? Date.parse(expectedBy) < Date.now() : false,
			actions: extra.actions ?? [],
		});
	};
	const raise = (x: MockGig, unit = ""): NonNullable<W["actions"]>[number] => ({
		id: "raise_price",
		label: `Raise to ${formatMoney(x.bounty + 5_000_000n)}${unit}`,
		gigId: x.id,
		bounty: (x.bounty + 5_000_000n).toString(),
	});
	for (const d of dels) {
		if (d.status !== "PENDING") continue;
		if (d.escalated)
			wait(
				"company",
				`You to decide on ${nameOf(d)}'s profile (${d.candidateReview?.score ?? "?"})`,
				d.submittedAt,
				{
					gigId: d.gigId,
					deliverableId: d.id,
					actions: [
						{ id: "decide", label: `Yes, take ${first(nameOf(d))}`, deliverableId: d.id },
						{ id: "decide", label: "No, pass", deliverableId: d.id },
					],
				},
			);
		else if (d.awaitingReviewer)
			wait("company", `You to review ${whatOf(d)} from ${displayName(d.scout)}`, d.submittedAt, {
				gigId: d.gigId,
				deliverableId: d.id,
			});
		else if (d.confirmToken && confirmationOf(d.confirmToken)?.status === "PENDING")
			wait("candidate", `${first(nameOf(d))} to confirm interest`, d.submittedAt, {
				deadline: d.confirmExpiresAt ? iso(d.confirmExpiresAt) : null,
				gigId: d.gigId,
				deliverableId: d.id,
				usualMs: 2 * MIN,
				actions: [{ id: "resend_confirmation", label: "Resend link", deliverableId: d.id }],
			});
	}
	for (const s of g.shortlist.values()) {
		if (s.roleId !== roleId) continue;
		const src = g.deliveries.get(s.sourceDeliveryId);
		const who = src ? nameOf(src) : "the finalist";
		if (s.decision === "NONE")
			wait("company", `You to decide on ${who} for an interview`, iso(), {
				deliverableId: s.candidateId,
				actions: [
					{ id: "invite", label: "Invite to interview", deliverableId: s.candidateId },
					{ id: "pass", label: "Pass", deliverableId: s.candidateId },
				],
			});
		if (s.decision === "INVITED")
			wait("company", `You to confirm ${first(who)} came to the interview`, s.decidedAt ?? iso(), {
				deliverableId: s.candidateId,
				actions: [{ id: "attended", label: `Yes, ${first(who)} came`, deliverableId: s.candidateId }],
			});
	}
	for (const x of gigs) {
		if (!x.exclusive || x.status !== "OPEN" || dels.some((d) => d.gigId === x.id && d.status !== "REJECTED"))
			continue;
		const who = first(x.candidate?.name ?? "the candidate");
		if (x.claimant)
			wait(
				"recruiter",
				`${displayName(x.claimant)} to run the ${KIND_WORD(x)} with ${who}`,
				x.claimedAt ?? x.createdAt,
				{
					deadline: iso(Date.parse(x.claimedAt ?? x.createdAt) + 24 * HOUR),
					gigId: x.id,
				},
			);
		else
			wait("recruiter", `A recruiter to take the ${KIND_WORD(x)} for ${who}`, x.createdAt, {
				gigId: x.id,
				usualMs: 3 * MIN,
				actions: [raise(x)],
			});
	}
	const sourcing = gigs.find((x) => x.type === "SOURCING" && x.status === "OPEN");
	if (sourcing) {
		const strict = role?.criteria.mustHave.at(-1);
		wait(
			"recruiter",
			`Recruiters to find more people · ${sourcing.maxDeliverables - sourcing.acceptedCount} slots open`,
			sourcing.createdAt,
			{
				gigId: sourcing.id,
				usualMs: 5 * MIN,
				actions: [
					raise(sourcing, " per profile"),
					...(strict
						? [
								{
									id: "loosen_requirement" as const,
									label: `Make "${strict.label}" a nice-to-have`,
									criterionId: strict.id,
								},
							]
						: []),
				],
			},
		);
	}

	const due = [
		...g.agenda.filter((a) => a.roleId === roleId).map((a) => a.at),
		...dels
			.filter(
				(d) =>
					d.status === "PENDING" && !d.reviewedAt && !d.escalated && !d.confirmToken && !d.awaitingReviewer,
			)
			.map((d) => d.reviewAt),
	].filter((t) => t > Date.now());
	const committed = gigs
		.filter((x) => x.status === "OPEN")
		.reduce((s, x) => s + x.bounty * BigInt(Math.max(0, x.maxDeliverables - x.acceptedCount)), 0n);
	const balance = role?.balance ?? 0n;
	const held = role?.heldBack ?? 0n;
	const available = balance - held - committed;
	const busy = !!working(roleId);
	return {
		roleId,
		now: {
			text: working(roleId) ?? status(roleId),
			since: entries.at(-1)?.createdAt ?? iso(),
			startedAt: entries.at(-1)?.createdAt ?? iso(),
			busy,
			detail: busy ? working(roleId) : null,
		},
		waitingOn,
		pipeline: {
			sourcingAccepted: accepted("SOURCING"),
			sourcingSlots: target("SOURCING"),
			confirmed: dels.filter((d) => d.confirmToken && confirmationOf(d.confirmToken)?.status === "YES")
				.length,
			screeningDone: accepted("SCREENING_CALL"),
			screeningSlots: target("SCREENING_CALL"),
			languageDone: accepted("LANGUAGE_CHECK"),
			referenceDone: accepted("REFERENCE_CHECK"),
			shortlisted: [...g.shortlist.values()].filter((s) => s.roleId === roleId).length,
		},
		budget: {
			deposited: (role?.deposited ?? 0n).toString(),
			paid: (role?.paid ?? 0n).toString(),
			heldBack: held.toString(),
			committed: committed.toString(),
			available: (available > 0n ? available : 0n).toString(),
		},
		nextCheckAt: due.length ? iso(Math.min(...due)) : null,
	};
}

function activityItem(e: Entry): AgentActivity {
	return {
		id: e.id,
		roleId: e.roleId,
		kind: e.kind,
		message: e.message,
		detail: e.detail ?? undefined,
		gigId: e.gigId,
		deliverableId: e.deliverableId,
		signature: e.signature,
		explorerUrl: e.signature ? explorerTxUrl(e.signature) : null,
		solscanUrl: e.signature ? explorerTxUrl(e.signature) : null,
		createdAt: e.createdAt,
	};
}

// ---- procedures (mock tRPC) --------------------------------------------------------------------------------

export class MockError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly details: Record<string, unknown> = {},
	) {
		super(message);
	}
}

type Ctx = { wallet: string | null; input: Record<string, unknown> };
const need = (ctx: Ctx) => {
	if (!ctx.wallet) throw new MockError(401, "UNAUTHORIZED", "Log in first");
	return ctx.wallet;
};
const gigOf = (id: unknown) => {
	const gig = g.gigs.get(String(id));
	if (!gig) throw new MockError(404, "NOT_FOUND", "Gig not found");
	return gig;
};

async function dupOf(roleId: string, profileUrl: string) {
	const hash = await candidateHash(db.roles.get(roleId)?.salt ?? "", profileUrl);
	return { hash, first: [...g.deliveries.values()].find((d) => d.roleId === roleId && d.hash === hash) };
}

export const gigProcedures: Record<string, (ctx: Ctx) => Promise<unknown> | unknown> = {
	"gigs.list": ({ wallet, input }) =>
		[...g.gigs.values()]
			.filter((x) => (input?.includeClosed ? true : x.status === "OPEN"))
			.filter((x) => !input?.roleId || x.roleId === input.roleId)
			.filter((x) => !x.exclusive || !x.claimant || x.claimant === wallet)
			.filter((x) => db.roles.get(x.roleId)?.status === "OPEN")
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.map((x) => gigView(x, wallet)),
	"gigs.byId": ({ wallet, input }) => gigView(gigOf(input.id), wallet),
	"gigs.mine": (ctx) => {
		const wallet = need(ctx);
		return {
			gigs: [...g.gigs.values()].filter((x) => x.claimant === wallet).map((x) => gigView(x, wallet)),
			deliverables: [...g.deliveries.values()]
				.filter((d) => d.scout === wallet)
				.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
				.map(deliverableView),
		};
	},
	"gigs.claim": (ctx) => {
		const wallet = need(ctx);
		const gig = gigOf(ctx.input.id);
		if (!gig.exclusive) throw new MockError(409, "NOT_EXCLUSIVE", "Anyone can deliver to this gig.");
		if (gig.claimant && gig.claimant !== wallet)
			throw new MockError(409, "ALREADY_CLAIMED", "Someone else took this gig.");
		const ok = access(gig, wallet).eligibility;
		if (ok && !ok.allowed) throw new MockError(403, "REQUIREMENTS_NOT_MET", ok.reason);
		return {
			unsignedTx: registerTx(`Claim ${gig.title}`, () => {
				gig.claimant = wallet;
				gig.claimedAt = iso();
				g.agenda = g.agenda.filter((a) => a.ref !== gig.id);
				log(
					gig.roleId,
					"GIG_CLAIMED",
					`${displayName(wallet)} took the ${gig.type === "SCREENING_CALL" ? "screening call" : "reference check"} for ${gig.candidate?.name}`,
					{ gigId: gig.id },
				);
				save();
			}),
		};
	},
	"submissions.checkDuplicate": async ({ input }) => {
		const { first } = await dupOf(String(input.roleId), String(input.profileUrl));
		return first ? { duplicate: true, firstSubmittedAt: first.submittedAt } : { duplicate: false };
	},
	"gigs.deliver": async (ctx) => {
		const wallet = need(ctx);
		const gig = gigOf(ctx.input.gigId);
		const payload = ctx.input.deliverable as Deliverable;
		if (gig.status !== "OPEN") throw new MockError(409, "GIG_CLOSED", "This gig is closed.");
		if (gig.exclusive && gig.claimant !== wallet)
			throw new MockError(409, "NOT_CLAIMED", "Take this gig first.");
		let hash: string | null = null;
		if (payload.type === "SOURCING") {
			const dup = await dupOf(gig.roleId, payload.profileUrl);
			if (dup.first)
				throw new MockError(409, "DUPLICATE_CANDIDATE", "Another recruiter already submitted this person.", {
					firstSubmittedAt: dup.first.submittedAt,
				});
			hash = dup.hash;
		}
		const deliverableId = newId("dlv");
		return {
			deliverableId,
			unsignedTx: registerTx(`Deliver to ${gig.title}`, () => {
				// Not recorded: self-reported, so the agent first asks the candidate whether the call happened.
				const selfReported = payload.type === "SCREENING_CALL" && !hasRecording(gig.id);
				const d = addDelivery(
					gig,
					wallet,
					selfReported
						? { ...payload, evidence: "self-reported" }
						: payload.type === "SCREENING_CALL"
							? { ...payload, evidence: "recording" }
							: payload,
					hash,
					deliverableId,
				);
				if (selfReported) {
					d.reviewAt = Date.now() + 15 * SECOND;
					log(
						gig.roleId,
						"NOTE",
						`No recording, so I asked ${first(gig.candidate?.name ?? "the candidate")} to confirm the call happened`,
						{
							gigId: gig.id,
							deliverableId: d.id,
						},
					);
				}
				// A real recruiter brought this person: drop the simulated fallback for them.
				if (payload.type === "SOURCING")
					g.agenda = g.agenda.filter(
						(a) =>
							!(
								a.action === "sim-source" &&
								normalizeProfileUrl(SIM_CANDIDATES[a.ref ?? ""]?.profileUrl ?? "") ===
									normalizeProfileUrl(payload.profileUrl)
							),
					);
				save();
			}),
		};
	},
	"roles.activity": ({ input }): RoleActivityView => {
		const roleId = String(input.roleId ?? input.id);
		return {
			status: status(roleId),
			items: (g.entries.get(roleId) ?? []).map(activityItem),
			working: working(roleId) ?? undefined,
		};
	},
	/** Hanna instructs her agent. The reply arrives a moment later as an agent message. */
	"roles.message": (ctx) => {
		need(ctx);
		const roleId = String(ctx.input.roleId);
		const text = String(ctx.input.text ?? "").trim();
		if (!db.roles.get(roleId)) throw new MockError(404, "NOT_FOUND", "Role not found");
		if (!text) throw new MockError(400, "BAD_REQUEST", "Write a message first.");
		log(roleId, "COMPANY_MESSAGE", text);
		g.agenda.push({ at: Date.now() + 1800, roleId, action: "reply", ref: text });
		save();
		return { messageId: (g.entries.get(roleId) ?? []).at(-1)?.id ?? newId("msg") };
	},
	"roles.shortlist": ({ input }): ShortlistItemView[] =>
		[...g.shortlist.values()]
			.filter((s) => s.roleId === String(input.roleId ?? input.id))
			.map((s) => {
				const src = g.deliveries.get(s.sourceDeliveryId);
				const p = src?.payload.type === "SOURCING" ? src.payload : null;
				return {
					candidateId: s.candidateId,
					name: p?.name ?? "",
					profileUrl: p?.profileUrl ?? "",
					card: candidateInfo(p?.name ?? ""),
					score: src?.candidateReview?.score ?? null,
					agentNote: s.agentNote,
					screening: s.screening,
					reference: s.reference,
					decision: s.decision,
					decidedAt: s.decidedAt,
				};
			})
			.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)),
	"roles.reviewer": ({ input }) => reviewerOf(String(input.roleId)),
	"roles.status": ({ input }) => roleStatus(String(input.roleId)),
	/** The company answers the agent's question about a borderline profile. */
	/** The company decides on a delivery: answers the agent's question, or reviews by hand (same procedure as live). */
	"submissions.decide": (ctx) => {
		const d = g.deliveries.get(String(ctx.input.id));
		if (!d) throw new MockError(404, "NOT_FOUND", "Not found");
		const accept = ctx.input.decision === "accept";
		if (d.escalated) {
			gigProcedures["roles.answer"]({ ...ctx, input: { deliverableId: d.id, take: accept } });
			return { unsignedTx: null };
		}
		const reasonText = REASON_TEXT[String(ctx.input.reasonCode ?? "NOT_MATCHING")] ?? "Not a match";
		return gigProcedures["deliverables.decide"]({
			...ctx,
			input: { id: d.id, decision: accept ? "accept" : "reject", reasonText },
		});
	},
	"roles.answer": (ctx) => {
		need(ctx);
		const d = g.deliveries.get(String(ctx.input.deliverableId));
		if (!d || !d.escalated || d.payload.type !== "SOURCING")
			throw new MockError(409, "NOT_ASKED", "Already answered.");
		const name = d.payload.name;
		d.escalated = false;
		if (ctx.input.take) {
			preAccept(d);
			log(
				d.roleId,
				"AGENT_MESSAGE",
				`OK. I'll pay for ${first(name)} once they confirm they're open to a call.`,
			);
		} else {
			reject(d, "The company decided not to take this profile");
			log(d.roleId, "DELIVERY_REJECTED", `Passed on ${name}'s profile`, {
				gigId: d.gigId,
				deliverableId: d.id,
				detail: "You said no.",
			});
			log(d.roleId, "AGENT_MESSAGE", `OK, I passed on ${first(name)}. Nothing was paid.`);
		}
		save();
		return { ok: true };
	},
	"roles.setReviewer": (ctx) => {
		need(ctx);
		const roleId = String(ctx.input.roleId);
		const mode = ctx.input.mode as Reviewer["mode"];
		const agentPubkey = mode === "custom" ? String(ctx.input.agentPubkey ?? "") : null;
		if (mode === "custom" && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(agentPubkey ?? ""))
			throw new MockError(400, "VALIDATION", "That doesn't look like a public key.");
		return {
			unsignedTx: registerTx("Change who checks the work", () => {
				g.reviewers.set(roleId, { mode, agentPubkey });
				log(
					roleId,
					"NOTE",
					mode === "scout"
						? "The Scout agent checks the work again"
						: mode === "self"
							? "You check the work yourself from now on"
							: `Your own agent (${agentPubkey?.slice(0, 4)}…) checks the work from now on`,
				);
				save();
			}),
		};
	},
	/** For a company that reviews by hand: deliverables waiting for it, and recruiters' open appeals. */
	"roles.reviewQueue": ({ input }) => {
		const roleId = String(input.roleId);
		const row = (d: MockDelivery, awaiting: "decision" | "appeal") => ({
			...deliverableView(d),
			recruiter: { wallet: d.scout, displayName: displayName(d.scout) },
			awaiting,
			reviewDeadline: iso(Date.parse(d.submittedAt) + 48 * 3_600_000),
		});
		const mine = [...g.deliveries.values()].filter((d) => d.roleId === roleId);
		return [
			...mine.filter((d) => d.status === "PENDING" && d.awaitingReviewer).map((d) => row(d, "decision")),
			...mine
				.filter((d) => d.status === "REJECTED" && g.appeals.get(d.id)?.status === "OPEN")
				.map((d) => row(d, "appeal")),
		];
	},
	"deliverables.queue": (ctx) => gigProcedures["roles.reviewQueue"](ctx),
	"deliverables.decide": (ctx) => {
		need(ctx);
		const d = g.deliveries.get(String(ctx.input.id));
		if (!d) throw new MockError(404, "NOT_FOUND", "Not found");
		const accept = ctx.input.decision === "accept";
		if (d.escalated) {
			gigProcedures["roles.answer"]({ ...ctx, input: { deliverableId: d.id, take: accept } });
			return { unsignedTx: null };
		}
		const reason = String(ctx.input.reasonText ?? "").trim();
		if (!reason) throw new MockError(400, "REASON_REQUIRED", "Say why, so the recruiter can learn from it.");
		return {
			unsignedTx: registerTx(accept ? "Accept work" : "Reject work", () => {
				if (accept) acceptByReviewer(d);
				else {
					d.awaitingReviewer = false;
					reject(d, reason);
					log(d.roleId, "DELIVERY_REJECTED", `You rejected ${whatOf(d)}`, {
						gigId: d.gigId,
						deliverableId: d.id,
						detail: reason,
					});
				}
				save();
			}),
		};
	},
	/** A recruiter asks the company to look again at a rejection (once). */
	"submissions.appeal": (ctx) => {
		const wallet = need(ctx);
		const d = g.deliveries.get(String(ctx.input.id));
		if (!d || d.scout !== wallet) throw new MockError(404, "NOT_FOUND", "Not found");
		if (d.status !== "REJECTED")
			throw new MockError(409, "NOT_REJECTED", "Only rejected work can be appealed.");
		if (g.appeals.has(d.id))
			throw new MockError(409, "ALREADY_APPEALED", "You already asked about this one.");
		const reason = String(ctx.input.reason ?? "").trim();
		if (reason.length < 10)
			throw new MockError(400, "VALIDATION", "Say a bit more, so the company can judge.");
		g.appeals.set(d.id, {
			status: "OPEN",
			reason,
			createdAt: iso(),
			decidedAt: null,
			note: null,
			paid: null,
			signature: null,
		});
		log(d.roleId, "ESCALATED", `${displayName(d.scout)} asks you to look again at ${whatOf(d)}`, {
			gigId: d.gigId,
			deliverableId: d.id,
			detail: reason,
		});
		save();
		return { ok: true };
	},
	/** The candidate didn't join: the first time the agent reschedules (24 h more), the second time it closes the gig. */
	"gigs.noShow": (ctx) => {
		const wallet = need(ctx);
		const gig = gigOf(ctx.input.gigId);
		if (gig.claimant !== wallet)
			throw new MockError(403, "NOT_CLAIMANT", "Only the recruiter who took the gig.");
		gig.noShows = (gig.noShows ?? 0) + 1;
		const who = first(gig.candidate?.name ?? "The candidate");
		if (gig.noShows === 1) {
			gig.claimedAt = iso();
			log(gig.roleId, "NOTE", `${who} didn't join the call. Rescheduling once`, { gigId: gig.id });
		} else {
			gig.status = "CLOSED";
			log(gig.roleId, "DELIVERY_REJECTED", `${who} missed the call twice. I stopped the screening`, {
				gigId: gig.id,
				detail: `${displayName(wallet)} is not penalised for it.`,
			});
		}
		save();
		return {
			noShows: gig.noShows,
			status: gig.status,
			deadline: iso(Date.parse(gig.claimedAt ?? gig.createdAt) + 24 * HOUR),
		};
	},
	/** A recruiter (or the company) suspects the candidate isn't real. The agent stops and looks into it. */
	"gigs.report": (ctx) => {
		const wallet = need(ctx);
		const gig = gigOf(ctx.input.gigId);
		const who = gig.candidate?.name ?? "this candidate";
		log(gig.roleId, "ESCALATED", `${displayName(wallet)} reported ${who} as possibly fake`, {
			gigId: gig.id,
			detail: String(ctx.input.reason ?? ""),
		});
		gig.status = "CLOSED";
		save();
		return { ok: true };
	},
	"roles.reportCandidate": (ctx) => {
		need(ctx);
		const entry = g.shortlist.get(String(ctx.input.candidateId));
		if (!entry) throw new MockError(404, "NOT_FOUND", "Not found");
		const src = g.deliveries.get(entry.sourceDeliveryId);
		const name = src?.payload.type === "SOURCING" ? src.payload.name : "the candidate";
		entry.decision = "PASSED";
		entry.decidedAt = iso();
		log(
			entry.roleId,
			"ESCALATED",
			`You reported ${name} as a problem. The recruiters' held parts go back to your budget`,
			{
				detail: String(ctx.input.reason ?? ""),
			},
		);
		for (const d of g.deliveries.values()) {
			const gig = g.gigs.get(d.gigId);
			if (
				(d.id === entry.sourceDeliveryId || gig?.candidate?.id === entry.candidateId) &&
				d.laterStatus === "HELD"
			) {
				const role = db.roles.get(d.roleId);
				if (role) role.heldBack -= d.split?.later ?? 0n;
				d.laterStatus = "REFUNDED";
			}
		}
		save();
		return { ok: true, unsignedTx: null };
	},
	/** The company raises an open gig's price (the agent narrates it). */
	"roles.raiseGigPrice": (ctx) => {
		need(ctx);
		const gig = gigOf(ctx.input.gigId);
		const next = BigInt(String(ctx.input.bounty));
		if (next <= gig.bounty) throw new MockError(400, "VALIDATION", "The new price must be higher.");
		gig.priceHistory = [
			...(gig.priceHistory ?? []),
			{ bounty: gig.bounty, at: iso(), reason: "Raised by the company" },
		];
		gig.bounty = next;
		log(
			gig.roleId,
			"AGENT_MESSAGE",
			`Done. It now pays ${formatMoney(next)}, so more recruiters will pick it up.`,
		);
		save();
		return { gigId: gig.id, signature: fakeSignature() };
	},
	/** The candidate gets the confirmation link again (through the recruiter who knows them). */
	"candidate.resendConfirmation": (ctx) => {
		need(ctx);
		const d = g.deliveries.get(String(ctx.input.deliverableId));
		if (!d?.confirmToken) throw new MockError(404, "NOT_FOUND", "Nothing to resend.");
		d.confirmExpiresAt = Date.now() + CONFIRM_WINDOW_MS;
		const name = d.payload.type === "SOURCING" ? first(d.payload.name) : "the candidate";
		log(
			d.roleId,
			"AGENT_MESSAGE",
			`I asked ${displayName(d.scout)} to send ${name} the link again and gave ${name} more time.`,
		);
		save();
		return { url: null, expiresAt: iso(d.confirmExpiresAt) };
	},
	"roles.loosenRequirement": (ctx) => {
		need(ctx);
		const role = db.roles.get(String(ctx.input.roleId));
		const c = role?.criteria.mustHave.find((x) => x.id === ctx.input.criterionId);
		if (!role || !c) throw new MockError(404, "NOT_FOUND", "Requirement not found");
		role.criteria = {
			...role.criteria,
			mustHave: role.criteria.mustHave.filter((x) => x.id !== c.id),
			niceToHave: [...role.criteria.niceToHave, c],
		};
		log(role.id, "CRITERIA_UPDATED", `"${c.label}" is now a nice-to-have`);
		log(role.id, "AGENT_MESSAGE", "Done. I'll score new profiles with that.");
		save();
		return { ok: true, rescoring: 0 };
	},
	"roles.ackEscalation": (ctx) => {
		need(ctx);
		return { ok: true };
	},
	"roles.dismissReport": (ctx) => {
		need(ctx);
		return { ok: true };
	},
	"gigs.answerFollowUp": (ctx) => {
		const wallet = need(ctx);
		const d = g.deliveries.get(String(ctx.input.id));
		const f = d?.followUps?.[Number(ctx.input.index)];
		if (!d || d.scout !== wallet || !f) throw new MockError(404, "NOT_FOUND", "Not found");
		f.answer = String(ctx.input.answer);
		f.answeredAt = iso();
		log(d.roleId, "NOTE", `${displayName(d.scout)} answered: ${f.answer}`, {
			gigId: d.gigId,
			deliverableId: d.id,
		});
		save();
		return { ok: true };
	},
	/** "Accept and pay" pays the recruiter directly; "Keep rejected" closes the appeal. */
	"submissions.decideAppeal": (ctx) => {
		need(ctx);
		const d = g.deliveries.get(String(ctx.input.id));
		const appeal = d ? g.appeals.get(d.id) : undefined;
		if (!d || !appeal || appeal.status !== "OPEN")
			throw new MockError(409, "NO_OPEN_APPEAL", "Nothing to decide.");
		const note = ctx.input.note ? String(ctx.input.note) : null;
		const close = (status: AppealView["status"], paid: bigint | null, signature: string | null) => {
			Object.assign(appeal, { status, decidedAt: iso(), note, paid: paid?.toString() ?? null, signature });
			log(
				d.roleId,
				"DECISION",
				status === "OVERTURNED"
					? `You paid ${displayName(d.scout)} after a second look`
					: `You kept the rejection of ${whatOf(d)}`,
				{
					gigId: d.gigId,
					deliverableId: d.id,
					detail: note ?? undefined,
					signature,
				},
			);
			save();
		};
		if (ctx.input.decision === "uphold") {
			close("UPHELD", null, null);
			return { unsignedTx: null };
		}
		return {
			unsignedTx: registerTx(`Pay ${displayName(d.scout)}`, (sig) => {
				const gig = g.gigs.get(d.gigId);
				const role = db.roles.get(d.roleId);
				const scout = db.profiles.get(d.scout);
				const amount = gig
					? splitBounty(gig.bounty, role?.feeBps ?? 1000, 0, scout?.operator?.feeBps ?? 0).now
					: 0n;
				if (role) {
					role.balance -= gig?.bounty ?? 0n;
					role.paid += gig?.bounty ?? 0n;
				}
				if (scout) {
					scout.balance += amount;
					scout.earned += amount;
				}
				close("OVERTURNED", amount, sig);
			}),
		};
	},
	"roles.decide": (ctx) => {
		need(ctx);
		const entry = g.shortlist.get(String(ctx.input.candidateId));
		if (!entry) throw new MockError(404, "NOT_FOUND", "Candidate not found");
		const src = g.deliveries.get(entry.sourceDeliveryId);
		const name = src?.payload.type === "SOURCING" ? src.payload.name : "the candidate";
		if (ctx.input.decision === "pass") {
			entry.decision = "PASSED";
			entry.decidedAt = iso();
			log(entry.roleId, "DECISION", `You passed on ${name}`);
			save();
			return { unsignedTx: null };
		}
		// Showing up is a separate, later fact: only then does the held part go to the recruiters.
		if (ctx.input.decision === "attended") {
			if (entry.decision !== "INVITED") throw new MockError(409, "NOT_INVITED", "Invite them first.");
			return {
				unsignedTx: registerTx(`${name} came to the interview`, () => {
					entry.decision = "ATTENDED";
					entry.decidedAt = iso();
					for (const d of g.deliveries.values()) {
						const gig = g.gigs.get(d.gigId);
						if (d.id === entry.sourceDeliveryId || gig?.candidate?.id === entry.candidateId)
							releaseHeld(d, true);
					}
					log(entry.roleId, "DECISION", `${name} came to the interview`, {
						detail: "The held part of the screening payment went to the recruiter.",
					});
					save();
				}),
			};
		}
		// Inviting is recorded, nothing is paid yet.
		entry.decision = "INVITED";
		entry.decidedAt = iso();
		log(entry.roleId, "DECISION", `You invited ${name} to interview`, {
			detail: "When they come, tell me here and the recruiters get the rest of their payment.",
		});
		save();
		return { unsignedTx: null };
	},
};

// ---- candidates (company view) -------------------------------------------------------------------------

const companyNotes = new Map<string, string>();
const removed = new Set<string>();

function candidateStage(d: MockDelivery): CandidateStage {
	const entry = g.shortlist.get(d.id);
	if (d.status === "REJECTED" || entry?.decision === "PASSED") return "PASSED";
	if (entry) return "SHORTLISTED";
	const calls = [...g.deliveries.values()].filter(
		(x) => g.gigs.get(x.gigId)?.candidate?.id === d.id && x.status === "ACCEPTED",
	);
	const done = (pred: (gig: MockGig) => boolean) =>
		calls.some((x) => {
			const gig = g.gigs.get(x.gigId);
			return gig && pred(gig);
		});
	if (done((x) => x.type === "REFERENCE_CHECK")) return "REFERENCE";
	if (done((x) => x.variant === "language")) return "LANGUAGE";
	if (done((x) => x.type === "SCREENING_CALL")) return "SCREENED";
	if (d.status === "ACCEPTED") return "CONFIRMED";
	return "PROFILE";
}

function candidateRow(d: MockDelivery): RoleCandidate | null {
	if (d.payload.type !== "SOURCING") return null;
	const card = candidateInfo(d.payload.name);
	return {
		id: d.id,
		name: d.payload.name,
		avatarUrl: card.avatarUrl,
		title: [card.currentTitle, card.currentCompany].filter(Boolean).join(" at ") || null,
		location: card.location,
		profileUrl: d.payload.profileUrl,
		score: d.candidateReview?.score ?? null,
		stage: candidateStage(d),
		sourcedBy: { wallet: d.scout, displayName: displayName(d.scout) },
		updatedAt: d.reviewedAt ?? d.submittedAt,
	};
}

function candidateDetail(d: MockDelivery): CandidateDetail | null {
	const row = candidateRow(d);
	const role = db.roles.get(d.roleId);
	if (!row || d.payload.type !== "SOURCING") return null;
	const criteria = role
		? [...role.criteria.mustHave, ...role.criteria.niceToHave, ...role.criteria.dealBreakers]
		: [];
	const calls = [...g.deliveries.values()]
		.filter((x) => g.gigs.get(x.gigId)?.candidate?.id === d.id)
		.map((x): CandidateCall | null => {
			const gig = g.gigs.get(x.gigId);
			const p = x.payload;
			if (!gig || p.type === "SOURCING") return null;
			const script = gig.script ?? [];
			const evidence =
				p.type === "SCREENING_CALL"
					? (p.evidence ?? (hasRecording(gig.id) ? "recording" : "self-reported"))
					: null;
			return {
				kind:
					p.type === "REFERENCE_CHECK" ? "REFERENCE" : gig.variant === "language" ? "LANGUAGE" : "SCREENING",
				deliverableId: x.id,
				recruiter: displayName(x.scout),
				status: x.status,
				score:
					x.status === "ACCEPTED"
						? Math.min(98, 70 + p.answers.filter((a) => a.answer.length > 60).length * 5)
						: null,
				summary:
					p.answers
						.slice(0, 2)
						.map((a) => a.answer)
						.join(" ") || null,
				recommendation: p.recommendation,
				evidence,
				callConfirmed: evidence === "self-reported" ? (x.status === "PENDING" ? "PENDING" : "YES") : null,
				level: p.type === "SCREENING_CALL" ? (p.assessedLevel ?? null) : null,
				referee: p.type === "REFERENCE_CHECK" ? `${p.refereeName} · ${p.refereeRelation}` : null,
				items: script.map((q) => {
					const answer = p.answers.find((a) => a.questionId === q.id)?.answer ?? "";
					return { question: q.question, answer, check: answer.trim().length >= 12 ? "ok" : "missing" };
				}),
				transcript: transcriptOf(gig.id),
				recordingUrl: null,
			};
		})
		.filter((c): c is CandidateCall => !!c);
	const paidFor = [
		d,
		...[...g.deliveries.values()].filter((x) => g.gigs.get(x.gigId)?.candidate?.id === d.id),
	];
	const payments = paidFor.flatMap((x) => {
		if (!x.split) return [];
		const what = x.payload.type === "SOURCING" ? "Found and confirmed" : whatOf(x).replace(/ for .*/, "");
		const rows = [
			{
				to: displayName(x.scout),
				what,
				amount: x.split.now.toString(),
				status: "PAID" as const,
				signature: x.settlementTx,
			},
		];
		if (x.split.later > 0n)
			rows.push({
				to: displayName(x.scout),
				what: `${what} · held part`,
				amount: x.split.later.toString(),
				status:
					x.laterStatus === "RELEASED" ? "RELEASED" : x.laterStatus === "REFUNDED" ? "REFUNDED" : "HELD",
				signature: null,
			});
		return rows;
	});
	const confirm = d.confirmToken ? confirmationFor(d.confirmToken) : null;
	return {
		...row,
		note: d.payload.notes,
		summary: d.candidateReview?.summary ?? null,
		verdicts: (d.candidateReview?.verdicts ?? []).map((v) => ({
			label: criteria.find((c) => c.id === v.criterionId)?.label ?? v.criterionId,
			verdict: v.verdict,
			reasoning: v.reasoning,
		})),
		confirmation: confirm ? { status: confirm.status, respondedAt: confirm.respondedAt } : null,
		calls,
		payments,
		companyNote: companyNotes.get(d.id) ?? null,
		decision: g.shortlist.get(d.id)?.decision ?? "NONE",
	};
}

const candidateProcedures: Record<string, (ctx: Ctx) => unknown> = {
	"candidates.list": ({ input }) =>
		[...g.deliveries.values()]
			.filter((d) => d.roleId === String(input.roleId) && d.type === "SOURCING" && !removed.has(d.id))
			.map(candidateRow)
			.filter((r): r is RoleCandidate => !!r)
			.sort((a, b) => (b.score ?? -1) - (a.score ?? -1)),
	"candidates.byId": ({ input }) => {
		const d = g.deliveries.get(String(input.candidateId));
		const detail = d && candidateDetail(d);
		if (!detail) throw new MockError(404, "NOT_FOUND", "Candidate not found");
		return detail;
	},
	"candidates.note": (ctx) => {
		need(ctx);
		companyNotes.set(String(ctx.input.candidateId), String(ctx.input.note ?? ""));
		return { ok: true };
	},
	/** The company overrides the agent: take or pass on a profile, put someone on the shortlist, or remove them. */
	"candidates.update": (ctx) => {
		need(ctx);
		const d = g.deliveries.get(String(ctx.input.candidateId));
		if (!d || d.payload.type !== "SOURCING") throw new MockError(404, "NOT_FOUND", "Candidate not found");
		const name = d.payload.name;
		const reason = String(ctx.input.reason ?? "").trim();
		switch (ctx.input.action) {
			case "accept":
				if (d.status === "ACCEPTED") break;
				d.escalated = false;
				if (d.status === "REJECTED") {
					d.status = "PENDING";
					d.reasons = [];
					d.reviewedAt = null;
				}
				d.candidateReview ??= reviewFor(db.roles.get(d.roleId)?.criteria as Criteria, {
					name,
					profileUrl: d.payload.profileUrl,
					notes: d.payload.notes,
				});
				preAccept(d);
				log(d.roleId, "DECISION", `You took ${name} over the agent's call`, {
					deliverableId: d.id,
					detail: reason || undefined,
				});
				break;
			case "pass": {
				const entry = g.shortlist.get(d.id);
				if (entry) {
					entry.decision = "PASSED";
					entry.decidedAt = iso();
				} else if (d.status === "PENDING") reject(d, reason || "The company passed");
				log(d.roleId, "DECISION", `You passed on ${name}`, {
					deliverableId: d.id,
					detail: reason || undefined,
				});
				break;
			}
			case "shortlist":
				if (!g.shortlist.has(d.id))
					g.shortlist.set(d.id, {
						candidateId: d.id,
						roleId: d.roleId,
						sourceDeliveryId: d.id,
						agentNote: d.candidateReview?.summary ?? "",
						screening: null,
						reference: null,
						decision: "NONE",
						decidedAt: null,
					});
				log(d.roleId, "SHORTLISTED", `You added ${name} to the shortlist`, { deliverableId: d.id });
				break;
			case "remove":
				removed.add(d.id);
				log(d.roleId, "NOTE", `You removed ${name} from this role`, {
					deliverableId: d.id,
					detail: reason || undefined,
				});
				break;
		}
		save();
		return { ok: true };
	},
};

/** Notetaker procedures share the gig store: the script comes from the gig the recruiter took. */
Object.assign(
	gigProcedures,
	recallProcedures((gigId) => g.gigs.get(gigId)?.script ?? null),
	confirmProcedures,
	candidateProcedures,
);

let clock: ReturnType<typeof setInterval> | null = null;
/** Keep the agent moving while mock data is in use. */
export function startMockAgentClock() {
	if (clock) return;
	clock = setInterval(() => void tick(), 1000);
}
