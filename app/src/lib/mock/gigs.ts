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
	CallDetail,
	CandidateDetail,
	CandidateRow,
	CandidateStage,
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
import { formatMoney, slugify } from "../format";
import { planGigs, withLevel } from "../gigs/plan";
import type { RoleActivityView, ShortlistItemView } from "../gigs/schemas";
import type { GigWorkView } from "../gigs/work";
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
import { hasRecording, notetakerJoined, recallProcedures, transcriptOf } from "./recall";
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
	/** Why the claimant's gig closed early (fake report or two no-shows), shown to them. */
	closed?: { reason: "REPORTED_FAKE" | "NO_SHOW"; at: string; report: string | null };
	/** Offered when the notetaker was in the call but the candidate never joined. */
	showUpFee?: { amount: bigint; signature: string | null } | null;
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
	/** Self-reported call: the candidate's "yes, we talked" link (sent by the sourcer), reviewed only after a yes. */
	callToken?: string | null;
	/** The recruiter's own note, edited while pending (gigs.edit). */
	note?: string;
	/** gigs.withdraw: taken back before the agent decided. */
	withdrawn?: boolean;
};

type MockShortlist = {
	candidateId: string;
	roleId: string;
	sourceDeliveryId: string;
	agentNote: string;
	screening: { summary: string; recommendation: string; recruiter: string } | null;
	reference: { summary: string; recommendation: string; recruiter: string } | null;
	decision: "NONE" | "INVITED" | "ATTENDED" | "PASSED" | "NO_SHOW";
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

type Agenda = { at: number; roleId: string; action: string; ref?: string; delayed?: boolean };

/**
 * Set once anyone switches to a recruiter persona in this mock session. A company-only demo keeps the quick
 * simulated sourcing of Karolina; once a person plays the recruiter, the simulator waits so they can do it.
 */
export const RECRUITER_USED_KEY = "scout.mock-recruiter-used";
const recruiterUsed = () => {
	try {
		return localStorage.getItem(RECRUITER_USED_KEY) === "1";
	} catch {
		return false;
	}
};
const LATE_KAROLINA_MS = 10 * 60 * 1000;

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
	/** Changes the agent proposed in chat, waiting for the company's yes. */
	proposals: new Map<string, Proposal>(),
	/** Recruiters' requests to look again at a rejection, by deliverable. */
	appeals: new Map<string, AppealView>(),
};
/** A change asked for in chat: nothing happens until the company says yes in "Needs you". */
type Proposal = {
	id: string;
	roleId: string;
	text: string;
	at: string;
	add?: { skill: string; slots: number };
	remove?: { skill: string; slots: number };
};
type Reviewer = { mode: "scout" | "custom" | "self"; agentPubkey: string | null };
const reviewerOf = (roleId: string): Reviewer =>
	g.reviewers.get(roleId) ?? { mode: "scout", agentPubkey: null };

const KEY = "scout.mock-gigs.v4";
const big = (_k: string, v: unknown) => (typeof v === "bigint" ? { $big: v.toString() } : v);
const unbig = (_k: string, v: unknown) =>
	v && typeof v === "object" && "$big" in v ? BigInt((v as { $big: string }).$big) : v;

function save() {
	try {
		localStorage.setItem(
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
					proposals: [...g.proposals],
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
		const raw = localStorage.getItem(KEY);
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
		g.proposals = new Map(d.proposals ?? []);
		return true;
	} catch {
		return false;
	}
}

export function resetGigs() {
	try {
		localStorage.removeItem(KEY);
	} catch {
		// ignore
	}
}

// ---- helpers -----------------------------------------------------------------------------------------------

const SECOND = 1000;
const HOLDBACK_WINDOW_MS = 15 * 60 * SECOND;
const REVIEW_DELAY_MS = 4 * SECOND;
/** A demo recruiter's own delivery waits this long before review (backend REVIEW_GRACE_SECONDS with DEMO_FAST). */
const REVIEW_GRACE_MS = 30 * SECOND;
/** How long a candidate has to confirm (48 h in production). */
const CONFIRM_WINDOW_MS = 20 * 60 * SECOND;
const first = (name: string) => name.split(" ")[0] ?? name;
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const displayName = (wallet: string) => db.profiles.get(wallet)?.displayName ?? "A recruiter";

export function log(roleId: string, kind: Entry["kind"], message: string, extra: Partial<Entry> = {}) {
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
		`Asked recruiters for ${gig.maxDeliverables} profiles at ${formatMoney(gig.bounty)} each`,
		{
			gigId: gig.id,
		},
	);
	// The scripted Rust engineers only go to a role that looks for them; any other role waits for real recruiters.
	const text = `${role.title} ${[...role.criteria.mustHave, ...role.criteria.niceToHave].map((c) => c.label).join(" ")}`;
	if (/\b(rust|solana|anchor)\b/i.test(text)) {
		schedule(roleId, 8 * SECOND, "sim-source", "tomasz");
		schedule(roleId, 14 * SECOND, "sim-source", "piotr");
		// A recruiter in the room sources Karolina herself; the simulator only steps in if nobody does.
		schedule(roleId, recruiterUsed() ? LATE_KAROLINA_MS : 120 * SECOND, "sim-source", "karolina");
	}
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
	// Andreea's calls aren't recorded: when a demo recruiter sourced the candidate, they get the "did you talk?" link.
	const sourcer = gig.candidate ? g.deliveries.get(gig.candidate.id)?.scout : undefined;
	const selfReported = !!sourcer && sourcer !== ANDREEA;
	const d = addDelivery(gig, ANDREEA, {
		type: "SCREENING_CALL",
		recommendation: "ADVANCE",
		...(selfReported ? { evidence: "self-reported" as const } : {}),
		answers: (gig.script ?? []).map((q, i) => ({
			questionId: q.id,
			answer: SIM_SCREENING(q, i),
		})),
	});
	if (selfReported) askAboutCall(d, gig);
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
		...{ dealBreakers: role.criteria.dealBreakers.map((c) => c.label) },
		recruiterSlug: slugify(from),
		recruiterAvatarUrl: avatarFor(from),
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
				: [location.places.join(", "), location.mode === "HYBRID" ? "hybrid" : "on-site"]
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

/** Where the candidate is, and what the role pays, in the words the candidate page uses. */
function publicFacts(role: MockRole) {
	const location = role.criteria.location;
	const salary = role.criteria.salaryRange;
	return {
		roleTitle: role.title,
		companyDescriptor: role.companyName,
		summary:
			role.jobDescription
				.split("\n")
				.map((l) => l.trim())
				.find((l) => l.length > 60)
				?.split(/(?<=\.)\s/)[0] ?? "",
		location:
			location.mode === "REMOTE"
				? "Remote"
				: [location.places.join(", "), location.mode === "HYBRID" ? "hybrid" : "on-site"]
						.filter(Boolean)
						.join(", ") || null,
		salaryLabel: salary
			? `${salary.min.toLocaleString("en-US")}–${salary.max.toLocaleString("en-US")} ${salary.currency} a ${salary.period === "YEAR" ? "year" : "month"}`
			: null,
		dealBreakers: role.criteria.dealBreakers.map((c) => c.label),
	};
}

const CALL_CONFIRM_WINDOW_MS = 10 * 60 * SECOND;
/** Without an answer, the simulated candidate says yes after this long (so a company-only demo keeps moving). */
const CALL_CONFIRM_FALLBACK_MS = 90 * SECOND;

/**
 * A call that wasn't recorded: before reviewing, the agent asks the candidate whether it happened. The link goes
 * to the candidate's sourcer (who knows them), never to the recruiter who claims the call.
 */
function askAboutCall(d: MockDelivery, gig: MockGig) {
	const role = db.roles.get(gig.roleId);
	if (!role || !gig.candidate) return;
	d.callToken = createConfirmation({
		...publicFacts(role),
		recruiterSlug: slugify(displayName(d.scout)),
		recruiterAvatarUrl: avatarFor(displayName(d.scout)),
		candidateFirstName: first(gig.candidate.name),
		recruiterName: displayName(d.scout),
		expiresAt: iso(Date.now() + CALL_CONFIRM_WINDOW_MS),
		kind: "call",
		callWith: displayName(d.scout),
		callKind: gig.variant === "language" ? "language check" : "screening call",
	});
	schedule(role.id, CALL_CONFIRM_FALLBACK_MS, "sim-call-confirm", d.id);
	log(
		role.id,
		"NOTE",
		`No recording, so I asked ${first(gig.candidate.name)} to confirm the call with ${displayName(d.scout)} happened`,
		{ gigId: gig.id, deliverableId: d.id },
	);
}

/** Calls about a sourced candidate that wait for the candidate's "yes, we talked" (shown to the sourcer). */
function callChecksFor(sourced: MockDelivery): NonNullable<DeliverableView["callChecks"]> {
	return [...g.deliveries.values()]
		.filter((x) => x.callToken && g.gigs.get(x.gigId)?.candidate?.id === sourced.id)
		.map((x) => {
			const c = confirmationFor(x.callToken ?? "");
			const gig = g.gigs.get(x.gigId);
			const status = c?.status ?? "EXPIRED";
			return {
				deliverableId: x.id,
				recruiterName: displayName(x.scout),
				callKind: gig?.variant === "language" ? "language check" : "screening call",
				status,
				url: status === "PENDING" ? (c?.url ?? null) : null,
				expiresAt: c?.expiresAt ?? iso(),
			};
		});
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
/** The agent proposes; the company decides in "Needs you". */
function propose(roleId: string, what: string, change: Pick<Proposal, "add" | "remove">) {
	// Taking back something only proposed: just drop the proposal, nothing to undo.
	if (change.remove) {
		const pending = [...g.proposals.values()].find(
			(p) => p.roleId === roleId && p.add && (!change.remove?.skill || p.add.skill === change.remove.skill),
		);
		if (pending) {
			g.proposals.delete(pending.id);
			log(roleId, "AGENT_MESSAGE", `OK, I dropped that: I won't ${pending.text}.`);
			return;
		}
	}
	const p: Proposal = { id: newId("prop"), roleId, text: what, at: iso(), ...change };
	g.proposals.set(p.id, p);
	log(roleId, "AGENT_MESSAGE", `I can ${what}. Say yes in "Needs you" and I'll do it.`);
}

function applyProposal(p: Proposal) {
	const role = db.roles.get(p.roleId);
	const gig = [...g.gigs.values()].find((x) => x.roleId === p.roleId && x.type === "SOURCING");
	if (!role) return;
	if (p.add?.skill) {
		role.criteria.niceToHave.push({
			id: `extra-${p.add.skill.toLowerCase()}`,
			label: p.add.skill,
			weight: 3,
		});
		log(p.roleId, "CRITERIA_UPDATED", `Added ${p.add.skill} to the nice-to-haves`);
	}
	if (p.add?.slots && gig) {
		gig.maxDeliverables += p.add.slots;
		gig.status = "OPEN";
		log(
			p.roleId,
			"GIG_POSTED",
			`Opened ${p.add.slots} more profile slots · ${formatMoney(gig.bounty)} each`,
			{ gigId: gig.id },
		);
	}
	if (p.remove?.skill) {
		role.criteria.niceToHave = role.criteria.niceToHave.filter((c) => c.label !== p.remove?.skill);
		log(p.roleId, "CRITERIA_UPDATED", `Removed ${p.remove.skill} from the nice-to-haves`);
	}
	if (p.remove?.slots && gig) {
		const floor =
			gig.acceptedCount +
			[...g.deliveries.values()].filter((d) => d.gigId === gig.id && d.status === "PENDING").length;
		const next = Math.max(floor, gig.maxDeliverables - p.remove.slots);
		const closed = gig.maxDeliverables - next;
		gig.maxDeliverables = next;
		if (next <= gig.acceptedCount) gig.status = "CLOSED";
		log(
			p.roleId,
			"CRITERIA_UPDATED",
			`Closed ${closed} profile slots · ${formatMoney(gig.bounty * BigInt(closed))} back in your budget`,
		);
	}
}

function reply(roleId: string, text: string) {
	const role = db.roles.get(roleId);
	if (!role) return;
	const lower = text.toLowerCase();
	if (/\b(pause|stop|hold)\b/.test(lower) && !/\?\s*$/.test(text)) {
		g.paused.add(roleId);
		log(roleId, "PAUSED", "Paused new screening calls");
		log(
			roleId,
			"AGENT_MESSAGE",
			"Paused. I won't book new screening calls until you tell me to continue. Profiles in review will still be checked.",
		);
		return;
	}
	if (/\b(resume|continue|go on|start again)\b/.test(lower) && !/\?\s*$/.test(text)) {
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
	if (
		/\b(show|open|see|view)\b.*\b(notes?|profile|transcript|screening|call|reference|candidate)\b/.test(lower)
	) {
		const hit = [...g.deliveries.values()].find(
			(d) =>
				d.roleId === roleId &&
				d.payload.type === "SOURCING" &&
				lower.includes(first(d.payload.name).toLowerCase()),
		);
		log(
			roleId,
			"AGENT_MESSAGE",
			hit?.payload.type === "SOURCING"
				? `Opened ${hit.payload.name}'s page: the profile, my check, every call with its transcript, and payments.`
				: "Which candidate? Their pages are under the candidates link at the top.",
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
	const skill = text.match(/\b(golang|go|rust|python|java|kotlin|kubernetes|aws|react)\b/i)?.[1];
	const skillLabel = skill
		? /^go(lang)?$/i.test(skill)
			? "Go"
			: skill[0].toUpperCase() + skill.slice(1)
		: null;
	const gig = [...g.gigs.values()].find((x) => x.roleId === roleId && x.type === "SOURCING");
	// A question never changes anything: answer it.
	if (/\?\s*$/.test(text) || /^(why|what|how|who|when|is|are|do|does|can|could)\b/.test(lower)) {
		const extra = skillLabel && role.criteria.niceToHave.find((c) => c.label === skillLabel);
		log(
			roleId,
			"AGENT_MESSAGE",
			extra
				? `${skillLabel} is a nice-to-have because you asked for it earlier. Say "remove ${skillLabel}" if you don't want it.`
				: "Good question. I'm following the must-haves you set; ask me to change any of them and I'll propose the change first.",
		);
		return;
	}
	// Undo: remove a skill and the slots that came with it, as a proposal.
	if (/\b(remove|drop|cancel|undo|don't want|do not want|take (it|that) back)\b/.test(lower)) {
		const target =
			skillLabel ?? role.criteria.niceToHave.find((c) => c.id.startsWith("extra-"))?.label ?? null;
		const slots =
			/slot|cancel/.test(lower) && gig
				? Math.min(10, Math.max(0, gig.maxDeliverables - gig.acceptedCount))
				: 0;
		if (!target && !slots) {
			log(roleId, "AGENT_MESSAGE", "What should I remove? Name the skill or say 'the extra slots'.");
			return;
		}
		propose(
			roleId,
			[
				target && `remove ${target} from the nice-to-haves`,
				slots &&
					`close ${slots} profile slots (${formatMoney((gig?.bounty ?? 0n) * BigInt(slots))} back to your budget)`,
			]
				.filter(Boolean)
				.join(" and "),
			{ remove: { skill: target ?? "", slots } },
		);
		return;
	}
	const asked = [...g.deliveries.values()].find(
		(d) => d.roleId === roleId && d.escalated && d.status === "PENDING" && !d.confirmToken,
	);
	const short = lower.split(/\s+/).filter(Boolean).length <= 4;
	const named = asked?.payload.type === "SOURCING" && lower.includes(first(asked.payload.name).toLowerCase());
	if (
		asked &&
		asked.payload.type === "SOURCING" &&
		(short || named) &&
		/\b(yes|take|ok|go ahead|no|skip|pass)\b/.test(lower)
	) {
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
	if (skillLabel || /\bmore\b/.test(lower)) {
		if (
			skillLabel &&
			[...role.criteria.mustHave, ...role.criteria.niceToHave].some((c) => c.label === skillLabel)
		) {
			log(roleId, "AGENT_MESSAGE", `${skillLabel} is already on the list.`);
			return;
		}
		const slots = /\bmore\b/.test(lower) && gig ? 10 : 0;
		propose(
			roleId,
			[
				skillLabel && `add ${skillLabel} to the nice-to-haves`,
				slots &&
					`open ${slots} more profile slots (${formatMoney((gig?.bounty ?? 0n) * BigInt(slots))} from your budget)`,
			]
				.filter(Boolean)
				.join(" and "),
			{ add: { skill: skillLabel ?? "", slots } },
		);
		return;
	}
	log(roleId, "AGENT_MESSAGE", "Noted. I'll take that into account for the next candidates.");
}

let ticking = false;
/** Runs everything that is due: agent reviews, replies and the simulated market. */
/** When this page session first looked at a role after a long gap (in memory: every reload is a new visit). */
const visits = new Map<string, number>();
const LONG_GAP = 30 * 60_000;
function visitStart(roleId: string) {
	const known = visits.get(roleId);
	if (known !== undefined) return known;
	const last = (g.entries.get(roleId) ?? []).at(-1);
	const quietFor = last ? Date.now() - Date.parse(last.createdAt) : 0;
	const start = quietFor > LONG_GAP ? Date.now() : 0;
	visits.set(roleId, start);
	return start;
}

export async function tick() {
	if (ticking) return;
	ticking = true;
	try {
		await ensureGigs();
		const now = Date.now();
		let changed = false;
		// Self-reported calls: reviewed after the candidate's yes; a no (or no answer) rejects them.
		for (const d of g.deliveries.values()) {
			if (d.status !== "PENDING" || !d.callToken) continue;
			const answer = confirmationOf(d.callToken)?.status;
			const expired = answer === "PENDING" && Date.parse(confirmationOf(d.callToken)?.expiresAt ?? "") <= now;
			if (expired) answerConfirmation(d.callToken, "EXPIRED");
			if (answer !== "NO" && answer !== "EXPIRED" && !expired) continue;
			const who = first(g.gigs.get(d.gigId)?.candidate?.name ?? "The candidate");
			reject(
				d,
				answer === "NO" ? `${who} says the call didn't happen` : `${who} didn't confirm the call in time`,
			);
			log(d.roleId, "DELIVERY_REJECTED", `${who} didn't confirm the call with ${displayName(d.scout)}`, {
				gigId: d.gigId,
				deliverableId: d.id,
				detail: d.reasons[0],
			});
			changed = true;
		}
		const waitingForCall = (d: MockDelivery) =>
			!!d.callToken && confirmationOf(d.callToken)?.status !== "YES";
		for (const d of g.deliveries.values())
			if (
				d.status === "PENDING" &&
				!d.reviewedAt &&
				!d.confirmToken &&
				!waitingForCall(d) &&
				!d.escalated &&
				d.reviewAt <= now
			) {
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
						? confirmationOf(d.confirmToken)?.reported
							? `${first(name)} reported the message`
							: `${first(name)} isn't open to a move right now`
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
		// Someone plays a recruiter: give them time to source Karolina and to take the calls themselves, so the
		// simulated recruiter doesn't snatch the work they are about to show.
		if (recruiterUsed())
			for (const a of g.agenda)
				if (
					!a.delayed &&
					(a.action === "sim-screening" ||
						a.action === "sim-reference" ||
						(a.action === "sim-source" && a.ref === "karolina"))
				) {
					a.at = Math.max(a.at, now + LATE_KAROLINA_MS - 120 * SECOND);
					a.delayed = true;
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
				if (a.action === "sim-call-confirm" && dlv?.callToken) answerConfirmation(dlv.callToken, "YES");
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
			const SEEDED_NOTES: Record<string, string> = {
				"Marek Zieliński":
					"Field engineer at a robotics company: deployed on-prem edge hardware with Jetson GPUs and integrated cameras, sensors and robots with their software on customer sites. Customer-facing deployment role, EU citizen, happy to travel 50%. Early-stage startup experience, open to Zürich.",
				"Julia Kowalska":
					"Solutions engineer at an IoT platform: integrated cameras and sensors with software, deployed on-prem edge hardware for industrial clients, customer-facing on site, travels 50%. EU citizen, speaks German, early-stage startup experience. Ready to move this quarter.",
			};
			for (const [i, name] of ["Marek Zieliński", "Julia Kowalska"].entries()) {
				const profileUrl = `https://linkedin.com/in/${name.toLowerCase().replace(/[^a-z]+/g, "-")}-fde-demo`;
				const notes = SEEDED_NOTES[name] ?? "";
				// Julia comes from the simulated recruiter, so Ola (the demo recruiter) can take her screening call.
				const d = addDelivery(src, name === "Julia Kowalska" ? ANDREEA : PERSONAS.scout.mockAddress, {
					type: "SOURCING",
					name,
					profileUrl,
					notes,
					consent: true,
				});
				d.candidateReview = reviewFor(fde.criteria, { name, profileUrl, notes });
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
		holdbackWindowSeconds: HOLDBACK_WINDOW_MS / 1000,
		...(gig.closed && wallet && gig.claimant === wallet
			? { closedReason: gig.closed.reason, closedAt: gig.closed.at, reportReason: gig.closed.report }
			: {}),
		...(role ? { post: postOf(role) } : {}),
		...(gig.type !== "SOURCING" && !redacted ? callFactsOf(gig, wallet) : {}),
	};
}

const csv = (s: string | null | undefined) => s ?? null;
/** The job post recruiters read on every gig: criteria and summary only. */
function postOf(role: MockRole): NonNullable<GigView["post"]> {
	const c = role.criteria;
	return {
		title: role.title,
		companyDescriptor: role.companyName,
		location: c.location.places.length ? c.location.places.join(", ") : null,
		workMode: c.location.mode,
		seniority: c.seniority,
		salaryRange: c.salaryRange,
		mustHave: c.mustHave.map((x) => x.label),
		niceToHave: c.niceToHave.map((x) => x.label),
		dealBreakers: c.dealBreakers.map((x) => x.label),
		languages: c.languages,
		summary: publicFacts(role).summary,
	};
}

/** For the recruiter holding the call: what the candidate told us on their confirmation page, and the show-up fee. */
/** The referee the candidate named on their accepted screening call. */
function refereeFor(candidateId: string) {
	for (const d of g.deliveries.values()) {
		const gig = g.gigs.get(d.gigId);
		if (gig?.candidate?.id !== candidateId || d.status !== "ACCEPTED") continue;
		if (d.payload.type === "SCREENING_CALL" && d.payload.referee) return d.payload.referee;
	}
	return null;
}

function callFactsOf(gig: MockGig, wallet: string | null) {
	const source = gig.candidate ? g.deliveries.get(gig.candidate.id) : undefined;
	const told = source?.confirmToken ? confirmationOf(source.confirmToken) : null;
	return {
		candidateTimeZone: csv(told?.timeZone),
		...(gig.candidate
			? {
					candidate: {
						...candidateFor(gig.candidate, false),
						availability: csv(told?.availability),
						salaryExpectation: csv(told?.salaryExpectation),
						contact:
							told?.contactEmail || told?.contactPhone
								? { email: csv(told.contactEmail), phone: csv(told.contactPhone) }
								: null,
						referee: gig.type === "REFERENCE_CHECK" ? refereeFor(gig.candidate.id) : null,
					},
				}
			: {}),
		showUpFee:
			gig.showUpFee && wallet && gig.claimant === wallet
				? {
						amount: gig.showUpFee.amount.toString(),
						status: gig.showUpFee.signature ? ("PAID" as const) : ("OFFERED" as const),
						signature: gig.showUpFee.signature,
					}
				: null,
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
	const edited = !!selfSkills()[wallet];
	const skills: RecruiterSkill[] = prof.skills.map((skill) => ({
		skill,
		source: skill === "tech-screener" && operator ? "operator" : h && !edited ? "seeded" : "self",
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
	const acceptedOf = (type: GigType) => mine.filter((d) => d.type === type && d.status === "ACCEPTED").length;
	return {
		skills,
		score: {
			score: wilson(all.accepted, all.decided),
			byType,
			seededHistory: !!h,
			acceptedByType: {
				SOURCING: acceptedOf("SOURCING"),
				SCREENING_CALL: acceptedOf("SCREENING_CALL"),
				REFERENCE_CHECK: acceptedOf("REFERENCE_CHECK"),
			},
			seededAccepted: h?.accepted ?? 0,
		},
	};
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

/** Skills the recruiter set themselves (me.setSkills), kept with the rest of the mock. */
const SKILLS_KEY = "scout.mock-skills.v1";
function selfSkills(): Record<string, string[]> {
	try {
		return JSON.parse(localStorage.getItem(SKILLS_KEY) ?? "{}") as Record<string, string[]>;
	} catch {
		return {};
	}
}
export function setSelfSkills(wallet: string, skills: string[]) {
	const next = {
		...selfSkills(),
		[wallet]: [...new Set(skills.map((x) => x.trim().toLowerCase()).filter(Boolean))],
	};
	try {
		localStorage.setItem(SKILLS_KEY, JSON.stringify(next));
	} catch {
		// private mode: lost on reload
	}
}

/** Recent gig work for the public profile (newest first). */
export function recentWorkOf(wallet: string) {
	return [...g.deliveries.values()]
		.filter((d) => d.scout === wallet)
		.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
		.slice(0, 8)
		.map((d) => ({
			id: d.id,
			status: d.status,
			submittedAt: d.submittedAt,
			roleTitle: db.roles.get(d.roleId)?.title ?? "Role",
		}));
}

export function recruiterProfile(wallet: string) {
	const seededHistory = HISTORY[wallet] ?? { skills: [], accepted: 0, decided: 0, screenings: 0 };
	const own = selfSkills()[wallet];
	// Operator-verified skills aren't the recruiter's to remove.
	const verified = db.profiles.get(wallet)?.operator
		? seededHistory.skills.filter((x) => x === "tech-screener")
		: [];
	const h = own ? { ...seededHistory, skills: [...new Set([...verified, ...own])] } : seededHistory;
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
		// Like the backend: a pre-accepted (waiting for the candidate) or escalated deliverable already shows the review.
		review:
			d.reviewedAt || d.confirmToken || d.escalated
				? {
						verdict:
							d.status === "ACCEPTED"
								? "ACCEPT"
								: d.status === "REJECTED"
									? "REJECT"
									: d.escalated
										? "ESCALATE"
										: "ACCEPT",
						reasons: d.reasons,
						candidateReview: d.candidateReview,
						reviewedAt: d.reviewedAt ?? d.submittedAt,
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
		...(d.type === "SOURCING" ? { callChecks: callChecksFor(d) } : {}),
		gigVariant: gig?.variant ?? null,
		deposit: depositOf(d),
	};
}

/** Unvouched recruiters put down 10% per profile: held while pending, returned on accept, kept otherwise. */
function depositOf(d: MockDelivery) {
	const gig = g.gigs.get(d.gigId);
	if (!gig || d.type !== "SOURCING" || d.scout === ANDREEA || db.profiles.get(d.scout)?.operator) return null;
	return {
		amount: (gig.bounty / 10n).toString(),
		status:
			d.status === "PENDING"
				? ("HELD" as const)
				: d.status === "ACCEPTED"
					? ("RETURNED" as const)
					: ("KEPT" as const),
	};
}

/** What the role pays a recruiter whose candidate never joined (the backend's SHOW_UP_FEE). */
const SHOW_UP_FEE = 5_000_000n;

function ownUndecided(wallet: string, id: unknown) {
	const d = g.deliveries.get(String(id));
	if (!d || d.scout !== wallet) throw new MockError(404, "NOT_FOUND", "We couldn't find this work.");
	if (d.status !== "PENDING" || d.reviewedAt || d.confirmToken)
		throw new MockError(409, "ALREADY_DECIDED", "The agent already decided on this deliverable.");
	return d;
}

/** gigs.work: one deliverable of the recruiter, with everything the detail page shows. */
function workView(d: MockDelivery): GigWorkView {
	const gig = g.gigs.get(d.gigId);
	const role = db.roles.get(d.roleId);
	const p = d.payload;
	const kind =
		p.type === "SOURCING"
			? "sourcing"
			: p.type === "REFERENCE_CHECK"
				? "reference"
				: gig?.variant === "language"
					? "language"
					: "screening";
	const call: CallDetail | null =
		gig && p.type !== "SOURCING"
			? {
					deliverableId: d.id,
					gigId: gig.id,
					kind: kind === "sourcing" ? "screening" : kind,
					recruiter: { wallet: d.scout, displayName: displayName(d.scout) },
					status: d.status,
					submittedAt: d.submittedAt,
					questions: (gig.script ?? []).map((q) => {
						const answer = p.answers.find((a) => a.questionId === q.id)?.answer ?? null;
						const len = answer?.trim().length ?? 0;
						return {
							id: q.id,
							question: q.question,
							whatGoodLooksLike: q.whatGoodLooksLike,
							answer,
							check: d.reviewedAt
								? {
										missing: len === 0,
										generic: len > 0 && len < 12,
										contradiction: false,
										fit: Math.min(1, len / 120),
									}
								: null,
						};
					}),
					recommendation: p.recommendation,
					followUps: d.followUps ?? [],
					recruiterNote: d.note ?? null,
					assessedLevel: p.type === "SCREENING_CALL" ? (p.assessedLevel ?? null) : null,
					referee: p.type === "REFERENCE_CHECK" ? { name: p.refereeName, relation: p.refereeRelation } : null,
					evidence: p.type === "SCREENING_CALL" ? (p.evidence ?? null) : null,
					confirmation: d.callToken ? confirmationFor(d.callToken) : null,
					transcript: p.type === "SCREENING_CALL" && p.evidence === "recording" ? transcriptOf(gig.id) : null,
					recordingUrl: null,
					integrity: null,
					review: null,
					summary: null,
					score: null,
				}
			: null;
	const view = deliverableView(d);
	return {
		work: view,
		kind,
		companyName: role?.companyName ?? "",
		candidateName: p.type === "SOURCING" ? p.name : (gig?.candidate?.name ?? null),
		criteria: role?.criteria ?? null,
		call,
		rejectText: d.status === "REJECTED" ? (d.reasons[0] ?? null) : null,
		editable: d.status === "PENDING" && !d.reviewedAt && !d.confirmToken,
		note: p.type === "SOURCING" ? p.notes : (d.note ?? null),
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
	if (screening) return `Screening · ${screening} call${screening === 1 ? "" : "s"} booked`;
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
	// The mock clock keeps running between visits; a demo opened hours later starts its waits fresh, never "8 h".
	const visit = visitStart(roleId);
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
		if (!extra.deadline && Date.parse(since) < visit) since = iso(visit);
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
	for (const p of g.proposals.values())
		if (p.roleId === roleId)
			wait("company", `Your agent wants to ${p.text}`, p.at, {
				actions: [
					{ id: "approve_proposal", label: "Yes, do it", proposalId: p.id },
					{ id: "decline_proposal", label: "No", proposalId: p.id },
				],
			});
	for (const s of g.shortlist.values()) {
		if (s.roleId !== roleId) continue;
		const src = g.deliveries.get(s.sourceDeliveryId);
		const who = src ? nameOf(src) : "the finalist";
		if (s.decision === "NONE")
			wait("company", `You to decide on ${who} for an interview`, iso(), {
				deliverableId: s.candidateId,
				actions: [
					{ id: "invite", label: "Invite to interview", candidateId: s.candidateId },
					{ id: "pass", label: "Pass", candidateId: s.candidateId },
				],
			});
		if (s.decision === "INVITED")
			wait("company", `You to tell me whether ${first(who)} came to the interview`, s.decidedAt ?? iso(), {
				deliverableId: s.candidateId,
				actions: [
					{ id: "attended", label: `Yes, ${first(who)} came`, candidateId: s.candidateId },
					{ id: "no_show", label: `${first(who)} didn't come`, candidateId: s.candidateId },
				],
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
	const fees = dels.reduce((s, d) => s + (d.split ? d.split.platformFee + d.split.operatorFee : 0n), 0n);
	const closed = role?.status === "CLOSED";
	const asking = waitingOn.find((w) => w.who === "company");
	return {
		roleId,
		now: {
			// A decision waiting for the company always wins: never "sourcing" while Hanna is the blocker.
			text: closed
				? "Closed"
				: asking
					? `Waiting for you: ${asking.what.replace(/^You to /, "")}`
					: (working(roleId) ?? status(roleId)),
			since: entries.at(-1)?.createdAt ?? iso(),
			startedAt: entries.at(-1)?.createdAt ?? iso(),
			busy: busy && !closed,
			detail: busy && !closed ? working(roleId) : null,
		},
		waitingOn: closed ? [] : waitingOn,
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
			committed: (closed ? 0n : committed).toString(),
			available: (closed || available <= 0n ? 0n : available).toString(),
			spent: ((role?.paid ?? 0n) + held).toString(),
			fees: fees.toString(),
			refunded: role?.refunded !== undefined ? role.refunded.toString() : undefined,
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
				// Like the backend's review grace: the recruiter can still edit or withdraw for a short while.
				d.reviewAt = Date.now() + REVIEW_GRACE_MS;
				if (selfReported) askAboutCall(d, gig);
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
		if (!d?.escalated || d.payload.type !== "SOURCING")
			throw new MockError(409, "NOT_ASKED", "Already answered.");
		const name = d.payload.name;
		d.escalated = false;
		if (ctx.input.take) {
			// A button press: the "Taking …, as you asked" step says it all, no chat reply on top.
			preAccept(d);
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
		// Never decide twice: a paid or rejected deliverable stays as it is.
		if (d.status !== "PENDING" && g.appeals.get(d.id)?.status !== "OPEN")
			throw new MockError(409, "ALREADY_DECIDED", "This one is already decided.");
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
			gig.closed = { reason: "NO_SHOW", at: iso(), report: null };
			log(gig.roleId, "DELIVERY_REJECTED", `${who} missed the call twice. I stopped the screening`, {
				gigId: gig.id,
				detail: `${displayName(wallet)} is not penalised for it.`,
			});
		}
		// The notetaker was in the meeting, so the recruiter showed up: the role pays them for their time, once.
		if (!gig.showUpFee && notetakerJoined(gig.id)) {
			gig.showUpFee = { amount: SHOW_UP_FEE < gig.bounty ? SHOW_UP_FEE : gig.bounty / 4n, signature: null };
			log(
				gig.roleId,
				"NOTE",
				`Offered ${displayName(wallet)} a ${formatMoney(gig.showUpFee.amount)} show-up fee (the notetaker was in the call)`,
				{ gigId: gig.id },
			);
		}
		save();
		return {
			noShows: gig.noShows,
			status: gig.status,
			deadline: iso(Date.parse(gig.claimedAt ?? gig.createdAt) + 24 * HOUR),
			showUpFee: gig.showUpFee ? { amount: gig.showUpFee.amount.toString() } : null,
		};
	},
	/** One signature: the role pays the recruiter's show-up fee. */
	"gigs.claimShowUpFee": (ctx) => {
		const wallet = need(ctx);
		const gig = gigOf(ctx.input.gigId);
		if (gig.claimant !== wallet)
			throw new MockError(403, "NOT_CLAIMANT", "Only the recruiter who took the gig.");
		const fee = gig.showUpFee;
		if (!fee) throw new MockError(409, "NO_SHOW_UP_FEE", "There is no show-up fee for this gig.");
		if (fee.signature) throw new MockError(409, "ALREADY_PAID", "You already got this fee.");
		return {
			unsignedTx: registerTx(`Get your ${formatMoney(fee.amount)} show-up fee`, () => {
				const role = db.roles.get(gig.roleId);
				const scout = db.profiles.get(wallet);
				fee.signature = fakeSignature();
				if (role) {
					role.balance -= fee.amount;
					role.paid += fee.amount;
				}
				if (scout) {
					scout.balance += fee.amount;
					scout.earned += fee.amount;
				}
				log(
					gig.roleId,
					"DELIVERY_ACCEPTED",
					`Paid ${displayName(wallet)} a ${formatMoney(fee.amount)} show-up fee`,
					{
						gigId: gig.id,
						signature: fee.signature,
					},
				);
				save();
			}),
		};
	},
	/** The recruiter's own deliverable, in full (My work detail). */
	"gigs.work": (ctx) => {
		const wallet = need(ctx);
		const d = g.deliveries.get(String(ctx.input.deliverableId));
		if (!d || d.scout !== wallet) throw new MockError(404, "NOT_FOUND", "We couldn't find this work.");
		return workView(d);
	},
	/** Change the note while the agent hasn't decided. */
	"gigs.edit": (ctx) => {
		const wallet = need(ctx);
		const d = ownUndecided(wallet, ctx.input.deliverableId);
		const note = String(ctx.input.note ?? "").trim();
		if (!note) throw new MockError(400, "VALIDATION", "Write a note first.");
		if (d.payload.type === "SOURCING") d.payload = { ...d.payload, notes: note };
		else d.note = note;
		d.reviewAt = Date.now() + REVIEW_GRACE_MS;
		log(d.roleId, "NOTE", `${displayName(d.scout)} edited ${whatOf(d)}`, {
			gigId: d.gigId,
			deliverableId: d.id,
		});
		save();
		return { ok: true };
	},
	/** Send earnings from the recruiter's own account to another account. */
	"me.cashOut": (ctx) => {
		const wallet = need(ctx);
		const p = db.profiles.get(wallet);
		const to = String(ctx.input.to ?? "");
		const amount = BigInt(String(ctx.input.amount ?? "0"));
		if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(to))
			throw new MockError(400, "INVALID_ADDRESS", "That address doesn't look right.");
		if (to === wallet) throw new MockError(400, "SAME_ACCOUNT", "That's your own account.");
		if (!p || amount <= 0n || amount > p.balance)
			throw new MockError(400, "INSUFFICIENT_FUNDS", "Not enough balance for this amount.");
		return {
			unsignedTx: registerTx(`Send ${formatMoney(amount)}`, () => {
				p.balance -= amount;
				persist();
			}),
		};
	},
	/** Take it back before the agent decides: rejected as withdrawn, not counted against the recruiter. */
	"gigs.withdraw": (ctx) => {
		const wallet = need(ctx);
		const d = ownUndecided(wallet, ctx.input.deliverableId);
		d.withdrawn = true;
		reject(d, "Withdrawn by the recruiter.");
		d.settlementTx = fakeSignature();
		const gig = g.gigs.get(d.gigId);
		// A call gig goes back on the board for someone else.
		if (gig?.exclusive) {
			gig.claimant = null;
			gig.claimedAt = undefined;
		}
		log(d.roleId, "NOTE", `${displayName(d.scout)} withdrew ${whatOf(d)}`, {
			gigId: d.gigId,
			deliverableId: d.id,
			signature: d.settlementTx,
		});
		save();
		return { signature: d.settlementTx, bondKept: depositOf(d)?.amount ?? "0" };
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
		if (gig.claimant === wallet)
			gig.closed = { reason: "REPORTED_FAKE", at: iso(), report: String(ctx.input.reason ?? "") || null };
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
		// A fresh link with the same deadline (the old one stops working), like the backend: the deadline is tied
		// to the review window and can't move.
		const old = confirmationOf(d.confirmToken);
		if (old?.status !== "PENDING" || Date.parse(old.expiresAt) <= Date.now())
			throw new MockError(409, "LINK_EXPIRED", "This confirmation isn't pending any more.");
		const { token: _t, status: _s, respondedAt: _r, ...card } = old;
		answerConfirmation(d.confirmToken, "EXPIRED");
		d.confirmToken = createConfirmation(card);
		const name = d.payload.type === "SOURCING" ? first(d.payload.name) : "the candidate";
		log(d.roleId, "AGENT_MESSAGE", `I made a new link for ${displayName(d.scout)} to send ${name} again.`);
		save();
		return {
			url: ctx.wallet === d.scout ? (confirmationFor(d.confirmToken)?.url ?? null) : null,
			expiresAt: old.expiresAt,
		};
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
	"roles.decideProposal": (ctx) => {
		need(ctx);
		const p = g.proposals.get(String(ctx.input.proposalId));
		if (!p) throw new MockError(404, "NOT_FOUND", "Already decided.");
		g.proposals.delete(p.id);
		if (ctx.input.approve) applyProposal(p);
		const message = ctx.input.approve ? `Done: ${p.text}.` : "OK, I left everything as it was.";
		log(p.roleId, "AGENT_MESSAGE", message);
		save();
		return { ok: true, message };
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
		// Didn't come: what's held goes back to the company; nothing counts against the recruiters.
		if (ctx.input.decision === "no_show") {
			if (entry.decision !== "INVITED") throw new MockError(409, "NOT_INVITED", "Invite them first.");
			return {
				unsignedTx: registerTx(`${name} didn't come to the interview`, (signature) => {
					entry.decision = "NO_SHOW";
					entry.decidedAt = iso();
					let back = 0n;
					const role = db.roles.get(entry.roleId);
					for (const d of g.deliveries.values()) {
						const gig = g.gigs.get(d.gigId);
						if (
							(d.id === entry.sourceDeliveryId || gig?.candidate?.id === entry.candidateId) &&
							d.laterStatus === "HELD"
						) {
							back += d.split?.later ?? 0n;
							d.laterStatus = "REFUNDED";
						}
					}
					if (role) role.heldBack -= back;
					log(
						entry.roleId,
						"DECISION",
						`${name} didn't come to the interview. ${formatMoney(back)} back in your budget`,
						{
							detail: "The recruiters keep what they were already paid; nothing counts against them.",
							signature,
						},
					);
					save();
				}),
			};
		}
		if (ctx.input.decision === "attended") {
			if (entry.decision !== "INVITED") throw new MockError(409, "NOT_INVITED", "Invite them first.");
			const owed = new Map<string, { amount: bigint; deliverables: number }>();
			for (const d of g.deliveries.values()) {
				const gig = g.gigs.get(d.gigId);
				if (
					(d.id === entry.sourceDeliveryId || gig?.candidate?.id === entry.candidateId) &&
					d.laterStatus === "HELD"
				) {
					const o = owed.get(d.scout) ?? { amount: 0n, deliverables: 0 };
					owed.set(d.scout, { amount: o.amount + (d.split?.later ?? 0n), deliverables: o.deliverables + 1 });
				}
			}
			return {
				releases: [...owed].map(([wallet, o]) => ({
					recruiter: displayName(wallet),
					wallet,
					amount: o.amount.toString(),
					deliverables: o.deliverables,
				})),
				unsignedTx: registerTx(`${name} came to the interview`, () => {
					entry.decision = "ATTENDED";
					entry.decidedAt = iso();
					const by = new Map<string, bigint>();
					for (const d of g.deliveries.values()) {
						const gig = g.gigs.get(d.gigId);
						if (d.id !== entry.sourceDeliveryId && gig?.candidate?.id !== entry.candidateId) continue;
						if (d.laterStatus === "HELD") by.set(d.scout, (by.get(d.scout) ?? 0n) + (d.split?.later ?? 0n));
						releaseHeld(d, true);
					}
					const parts = [...by].map(([w, amt]) => `${first(displayName(w))} ${formatMoney(amt)}`).join(" · ");
					log(
						entry.roleId,
						"DECISION",
						`${name} came to the interview. Released ${parts || "nothing held"}`,
						{
							detail: "The parts held back until the interview went to the recruiters who did the work.",
							signature: fakeSignature(),
						},
					);
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

// ---- candidates (company view, same shapes as roles.candidates / roles.candidate) --------------------------

const companyNotes = new Map<string, { id: string; text: string; createdAt: string }[]>();
const removed = new Set<string>();
const callsAbout = (id: string) =>
	[...g.deliveries.values()].filter((x) => g.gigs.get(x.gigId)?.candidate?.id === id);
const callKind = (gig: MockGig | undefined) =>
	gig?.type === "REFERENCE_CHECK"
		? ("reference" as const)
		: gig?.variant === "language"
			? ("language" as const)
			: ("screening" as const);

function candidateStage(d: MockDelivery): CandidateStage {
	const entry = g.shortlist.get(d.id);
	if (entry?.decision === "PASSED" || entry?.decision === "NO_SHOW" || removed.has(d.id)) return "PASSED";
	if (entry?.decision === "ATTENDED") return "ATTENDED";
	if (entry?.decision === "INVITED") return "INVITED";
	if (entry) return "SHORTLISTED";
	if (d.status === "REJECTED") return "REJECTED";
	if (d.status === "PENDING") return d.confirmToken ? "CONFIRMING" : "REVIEWING";
	const open = [...g.gigs.values()].some((x) => x.candidate?.id === d.id && x.status === "OPEN");
	return open || callsAbout(d.id).length ? "IN_CALLS" : "ACCEPTED";
}

function candidateRow(d: MockDelivery): CandidateRow | null {
	if (d.payload.type !== "SOURCING") return null;
	const card = candidateInfo(d.payload.name);
	return {
		candidateId: d.id,
		name: d.payload.name,
		avatarUrl: card.avatarUrl,
		currentTitle: card.currentTitle,
		currentCompany: card.currentCompany,
		location: card.location,
		profileUrl: d.payload.profileUrl,
		score: d.candidateReview?.score ?? null,
		stage: candidateStage(d),
		sourcedBy: { wallet: d.scout, displayName: displayName(d.scout) },
		confirmed: !!d.confirmToken && confirmationOf(d.confirmToken)?.status === "YES",
		lastActivityAt: d.reviewedAt ?? d.submittedAt,
		removed: removed.has(d.id),
	};
}

function callDetail(x: MockDelivery): CallDetail | null {
	const gig = g.gigs.get(x.gigId);
	const p = x.payload;
	if (!gig || p.type === "SOURCING") return null;
	const recorded = hasRecording(gig.id);
	const evidence =
		p.type === "SCREENING_CALL"
			? (p.evidence ?? (recorded ? "recording" : "self-reported"))
			: recorded
				? "recording"
				: "self-reported";
	const lines = transcriptOf(gig.id);
	return {
		deliverableId: x.id,
		gigId: gig.id,
		kind: callKind(gig),
		recruiter: { wallet: x.scout, displayName: displayName(x.scout) },
		status: x.status,
		submittedAt: x.submittedAt,
		questions: (gig.script ?? []).map((q) => {
			const answer = p.answers.find((a) => a.questionId === q.id)?.answer ?? null;
			const len = answer?.trim().length ?? 0;
			return {
				id: q.id,
				question: q.question,
				whatGoodLooksLike: q.whatGoodLooksLike,
				answer,
				check: x.reviewedAt
					? {
							missing: len < 12,
							generic: len >= 12 && len < 40,
							contradiction: false,
							fit: Math.min(1, len / 160),
						}
					: null,
			};
		}),
		recommendation: p.recommendation,
		followUps: x.followUps ?? [],
		recruiterNote: null,
		assessedLevel: p.type === "SCREENING_CALL" ? (p.assessedLevel ?? null) : null,
		referee: p.type === "REFERENCE_CHECK" ? { name: p.refereeName, relation: p.refereeRelation } : null,
		evidence,
		confirmation: null,
		transcript: lines,
		recordingUrl: null,
		integrity: lines
			? {
					durationSeconds: (lines.at(-1)?.startSec ?? 0) + 30,
					speakers: new Set(lines.map((l) => l.speaker)).size,
					failed: [],
				}
			: null,
		review: x.reviewedAt
			? {
					verdict: x.status === "ACCEPTED" ? "ACCEPT" : "REJECT",
					reasons: x.reasons,
					candidateReview: null,
					reviewedAt: x.reviewedAt,
				}
			: null,
		summary:
			p.answers
				.slice(0, 2)
				.map((a) => a.answer)
				.join(" ") || null,
		score:
			x.status === "ACCEPTED"
				? Math.min(98, 70 + p.answers.filter((a) => a.answer.length > 60).length * 5)
				: null,
	};
}

const paymentOf = (x: MockDelivery) => {
	if (!x.split) return null;
	const gig = g.gigs.get(x.gigId);
	return {
		deliverableId: x.id,
		kind: x.payload.type === "SOURCING" ? ("sourcing" as const) : callKind(gig),
		recruiter: displayName(x.scout),
		now: x.split.now.toString(),
		later: x.split.later.toString(),
		laterStatus: x.laterStatus,
		signature: x.settlementTx,
		explorerUrl: null,
	};
};

function candidateDetail(d: MockDelivery): CandidateDetail | null {
	const row = candidateRow(d);
	if (!row || d.payload.type !== "SOURCING") return null;
	const confirm = d.confirmToken ? confirmationFor(d.confirmToken) : null;
	const answers = d.confirmToken ? confirmationOf(d.confirmToken) : null;
	return {
		...row,
		recruiterNote: d.payload.notes,
		review: d.candidateReview,
		confirmation: confirm,
		candidateAnswers:
			answers?.status === "YES"
				? {
						availability: answers.availability ?? null,
						salaryExpectation: answers.salaryExpectation ?? null,
						timeZone: null,
					}
				: null,
		followUps: d.followUps ?? [],
		calls: callsAbout(d.id)
			.map(callDetail)
			.filter((c): c is CallDetail => !!c),
		payments: [d, ...callsAbout(d.id)].map(paymentOf).filter((p): p is NonNullable<typeof p> => !!p),
		notes: companyNotes.get(d.id) ?? [],
	};
}

const candidateProcedures: Record<string, (ctx: Ctx) => unknown> = {
	"roles.candidates": ({ input }) =>
		[...g.deliveries.values()]
			.filter(
				(d) =>
					d.roleId === String(input.roleId) &&
					d.type === "SOURCING" &&
					(input.includeRemoved || !removed.has(d.id)),
			)
			.map(candidateRow)
			.filter((r): r is CandidateRow => !!r && (!input.stage || r.stage === input.stage))
			.sort((a, b) => (b.score ?? -1) - (a.score ?? -1)),
	"roles.candidate": ({ input }) => {
		const d = g.deliveries.get(String(input.candidateId));
		const detail = d && candidateDetail(d);
		if (!detail) throw new MockError(404, "NOT_FOUND", "Candidate not found");
		return detail;
	},
	"roles.payments": ({ input }) =>
		[...g.deliveries.values()]
			.filter((x) => x.roleId === String(input.roleId) && x.split)
			.map((x) => ({
				deliverableId: x.id,
				recruiter: displayName(x.scout),
				gigTitle: g.gigs.get(x.gigId)?.title ?? "",
				kind: x.payload.type === "SOURCING" ? ("sourcing" as const) : callKind(g.gigs.get(x.gigId)),
				amount: (x.split?.now ?? 0n).toString(),
				held: (x.split?.later ?? 0n).toString(),
				heldStatus: x.laterStatus,
				fees: ((x.split?.platformFee ?? 0n) + (x.split?.operatorFee ?? 0n)).toString(),
				bounty: (g.gigs.get(x.gigId)?.bounty ?? 0n).toString(),
				signature: x.settlementTx,
				explorerUrl: null,
				at: x.reviewedAt ?? x.submittedAt,
			})),
	"candidates.addNote": (ctx) => {
		need(ctx);
		const note = { id: newId("note"), text: String(ctx.input.text), createdAt: iso() };
		const id = String(ctx.input.candidateId);
		companyNotes.set(id, [...(companyNotes.get(id) ?? []), note]);
		return note;
	},
	"candidates.deleteNote": (ctx) => {
		need(ctx);
		for (const [id, list] of companyNotes)
			companyNotes.set(
				id,
				list.filter((n) => n.id !== ctx.input.noteId),
			);
		return { ok: true };
	},
	/** The company overrides the agent: take or pass on someone. */
	"candidates.update": (ctx) => {
		need(ctx);
		const d = g.deliveries.get(String(ctx.input.candidateId));
		if (d?.payload.type !== "SOURCING") throw new MockError(404, "NOT_FOUND", "Candidate not found");
		const name = d.payload.name;
		if (ctx.input.note)
			gigProcedures["candidates.addNote"]({ ...ctx, input: { candidateId: d.id, text: ctx.input.note } });
		if (ctx.input.stageOverride === "accept" && d.status !== "ACCEPTED") {
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
			log(d.roleId, "DECISION", `You took ${name} over the agent's call`, { deliverableId: d.id });
		}
		if (ctx.input.stageOverride === "pass") {
			const entry = g.shortlist.get(d.id);
			if (entry) {
				entry.decision = "PASSED";
				entry.decidedAt = iso();
			} else if (d.status === "PENDING") reject(d, "The company passed");
			log(d.roleId, "DECISION", `You passed on ${name}`, { deliverableId: d.id });
		}
		save();
		return { unsignedTx: null };
	},
	"candidates.remove": (ctx) => {
		const res = gigProcedures["candidates.update"]({
			...ctx,
			input: { candidateId: ctx.input.candidateId, stageOverride: "pass" },
		});
		removed.add(String(ctx.input.candidateId));
		return res;
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

/** A closed role: its open gigs close, the agent stops, and the thread says what came back. */
export function closeRoleWork(roleId: string, refund: bigint, signature: string) {
	for (const x of g.gigs.values()) if (x.roleId === roleId && x.status === "OPEN") x.status = "CLOSED";
	g.agenda = g.agenda.filter((a) => a.roleId !== roleId);
	log(roleId, "BUDGET", `Closed the role · ${formatMoney(refund)} back to you`, { signature });
	save();
}

/** What closing returns now, and what is still in flight. */
export function closePreviewOf(roleId: string) {
	const role = db.roles.get(roleId);
	const openGigs = [...g.gigs.values()].filter((x) => x.roleId === roleId && x.status === "OPEN").length;
	const inProgress = [...g.shortlist.values()]
		.filter((s) => s.roleId === roleId && (s.decision === "NONE" || s.decision === "INVITED"))
		.map((s) => {
			const d = g.deliveries.get(s.sourceDeliveryId);
			return {
				candidateId: s.candidateId,
				name: d?.payload.type === "SOURCING" ? d.payload.name : "A candidate",
			};
		});
	return { refund: ((role?.balance ?? 0n) - (role?.heldBack ?? 0n)).toString(), openGigs, inProgress };
}

/** A funded role: the deposit is on record in the thread (lasting proof). */
export function logDeposit(roleId: string, amount: bigint, signature: string, topUp = false) {
	log(
		roleId,
		"BUDGET",
		topUp ? `Added ${formatMoney(amount)} to the budget` : `Set aside ${formatMoney(amount)} for this role`,
		{ signature },
	);
	save();
}
