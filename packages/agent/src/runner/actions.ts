/**
 * Deterministic role actions. The AI agent's tools are thin wrappers around these, and
 * `advanceRole` chains them without a model, so money and policy never depend on the LLM:
 * prices come from priceForRole (the plan's quote), budget checks from the snapshot, accept/reject from agentDecision.
 */
import { type Criteria, type Criterion, fromBaseUnits, USDC_UNIT } from "@scout/shared";
import { normalizeCriteria } from "../criteria.ts";
import { reviewCall } from "../gigs/call-review.ts";
import { languageScript, requiredLanguage } from "../gigs/language.ts";
import { priceForRole, repriceRule } from "../gigs/market.ts";
import { planGigs } from "../gigs/plan.ts";
import { agentDecision, POLICY, pickForScreening } from "../gigs/policy.ts";
import { type PipelineState, type ReplanStepName, replanStep } from "../gigs/replan.ts";
import { referenceScript, screeningScript } from "../gigs/scripts.ts";
import { overallScore, shortlist } from "../gigs/shortlist.ts";
import type { GigType } from "../gigs/types.ts";
import { demoFast } from "../llm/index.ts";
import { defaultReviewEngine, reviewSubmissionDetailed } from "../review.ts";
import type {
	CandidateView,
	Deliverable,
	GigView,
	PortTaskType,
	RoleAgentPorts,
	RoleSnapshot,
	StoredReview,
} from "./ports.ts";

export type ActionResult = { ok: true; message: string; data?: unknown } | { ok: false; error: string };

const usd = (base: bigint) => `$${fromBaseUnits(base)}`;
/** Every bounty the agent posts: the same quote the plan uses (floor × tier × premium × market). */
const price = (type: GigType, criteria: Criteria, variant?: "language") =>
	BigInt(priceForRole(criteria, type, variant).usd) * BigInt(USDC_UNIT);
const fail = (error: string): ActionResult => ({ ok: false, error });
const open = (g: GigView) => g.status !== "CLOSED";
const MATCH_WORDS = { ADVANCE: "strong match", MAYBE: "possible match", PASS: "not a match" } as const;
const VERDICT_WORDS = { ACCEPT: "usable notes", REJECT: "sent back", ESCALATE: "needs your look" } as const;
const CALL_WORDS = {
	screening: "Screening notes",
	reference: "Reference notes",
	language: "Language check",
} as const;

/**
 * The ONE fit score the company sees for a candidate (0-100): the sourcing match, blended with the
 * screening, reference and language results as they come in. Call scores (quality of the
 * recruiter's notes) are a different number and never shown as the candidate's fit.
 */
export function candidateFit(c: CandidateView): number | null {
	if (!c.sourcing) return null;
	return overallScore({
		id: c.id,
		name: c.name,
		sourcing: c.sourcing,
		...(c.screening ? { screening: c.screening } : {}),
		...(c.reference ? { reference: c.reference } : {}),
		...(c.language ? { language: c.language } : {}),
	});
}

/** Gig types in the company's words (never the enum) for every logged message. */
export const GIG_WORDS: Record<GigType, string> = {
	SOURCING: "sourcing",
	SCREENING_CALL: "screening calls",
	REFERENCE_CHECK: "reference checks",
};
const foldName = (s: string) =>
	s
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/ł/g, "l")
		.toLowerCase()
		.trim();
const isLanguageGig = (g: GigView) => g.taskType === "SCREENING_CALL" && g.variant === "language";
type Sourced = CandidateView & { sourcing: NonNullable<CandidateView["sourcing"]> };
const hasSourcing = (c: CandidateView): c is Sourced => Boolean(c.sourcing);
const pausedType = (role: RoleSnapshot, type: GigType) =>
	role.pausedTaskTypes?.includes(type) ? fail(`The company paused the ${GIG_WORDS[type]}.`) : null;

/** Compact, JSON-safe view of the role for the model (no bigints). */
export function describeRole(role: RoleSnapshot) {
	return {
		title: role.title,
		paused: role.paused,
		pausedGigTypes: role.pausedTaskTypes ?? [],
		budget: {
			deposited: usd(role.budget.deposited),
			paid: usd(role.budget.paid),
			available: usd(role.budget.available),
		},
		criteria: {
			mustHave: role.criteria.mustHave.map((c) => `${c.id}: ${c.label} (w${c.weight})`),
			niceToHave: role.criteria.niceToHave.map((c) => `${c.id}: ${c.label} (w${c.weight})`),
			dealBreakers: role.criteria.dealBreakers.map((c) => `${c.id}: ${c.label}`),
		},
		gigs: role.gigs.map((g) => ({
			gigId: g.gigId,
			type: g.taskType,
			title: g.title,
			bounty: usd(g.bounty),
			slots: `${g.acceptedCount}/${g.maxDeliverables} accepted, ${g.pendingCount} pending`,
			status: g.status,
			candidateId: g.candidateId,
		})),
		candidates: role.candidates.map((c) => ({
			id: c.id,
			name: c.name,
			stage: c.stage,
			fit: candidateFit(c),
			screening: c.screening ? `${c.screening.verdict} (fit ${c.screening.candidateFit})` : undefined,
			reference: c.reference ? `${c.reference.verdict} (fit ${c.reference.candidateFit})` : undefined,
			language: c.language?.language
				? `${c.language.language.cefrLevel} (${c.language.language.meetsLevel ? "meets" : "below"} ${c.language.language.required})`
				: undefined,
		})),
	};
}

/** Posts the "now" gigs from planGigs when the role has none yet. */
export async function postInitialGigs(ports: RoleAgentPorts): Promise<ActionResult> {
	const role = await ports.getRole();
	if (role.paused) return fail("The company paused the agent.");
	if (role.gigs.length) return fail("Gigs are already posted.");
	if (role.budget.available <= 0n)
		return fail("The role has no budget yet; nothing is posted until it's funded.");
	const plan = await planGigs({ criteria: role.criteria, title: role.title, budget: role.budget.available });
	await ports.log({
		kind: "plan",
		message: plan.rationale,
		data: { committed: usd(plan.committed), reserve: usd(plan.reserve) },
	});
	const posted: string[] = [];
	const now = plan.gigs.filter((g) => g.when === "now");
	if (!now.length) return fail("The budget is too small for a first sourcing gig.");
	for (const gig of now) {
		const { gigId } = await ports.postGig(gig);
		posted.push(gigId);
		await ports.log({
			kind: "gig_posted",
			message: `Posted: ${gig.title} · ${usd(gig.bounty)} each`,
			data: { gigId, taskType: gig.taskType },
		});
	}
	return {
		ok: true,
		message: `Posted ${posted.length} gig(s). Planned later: ${plan.gigs.filter((g) => g.when !== "now").length} call gig(s).`,
		data: { rationale: plan.rationale, gigIds: posted },
	};
}

/** Reviews one pending deliverable and stores the review plus the policy decision. */
export async function reviewDeliverable(ports: RoleAgentPorts, deliverableId: string): Promise<ActionResult> {
	const [role, deliverable] = await Promise.all([ports.getRole(), ports.getDeliverable(deliverableId)]);
	if (!deliverable) return fail(`No deliverable ${deliverableId}.`);
	const previous = await ports.getReview(deliverableId);
	const updatedSince =
		previous?.reviewedAt && deliverable.updatedAt && deliverable.updatedAt > previous.reviewedAt;
	const cached = updatedSince ? null : previous;
	if (cached) {
		return {
			ok: true,
			message: cached.escalatedAt
				? "Already reviewed and waiting for the company's decision."
				: "Already reviewed.",
			data: { policy: cached.decision, waitingForCompany: Boolean(cached.escalatedAt) },
		};
	}
	let stored: StoredReview;
	let summary: string;
	if (deliverable.kind === "sourcing") {
		const details = await reviewSubmissionDetailed(role.criteria, deliverable.candidate);
		const { review, flags } = details;
		// Keyword heuristics are only a stand-in: when a model or Jev is configured but failed, a person decides.
		const degraded = details.engine === "offline" && defaultReviewEngine() !== "offline";
		stored = {
			deliverableId,
			kind: "sourcing",
			sourcing: review,
			decision: agentDecision({
				kind: "sourcing",
				review,
				flags,
				followUps: previous?.followUps ?? 0,
				criteria: role.criteria,
				notes: deliverable.candidate.notes,
				degraded,
			}),
			followUps: previous?.followUps ?? 0,
		};
		summary = `${deliverable.candidate.name}: ${MATCH_WORDS[review.recommendation]} (${review.score}/100). ${review.summary}`;
	} else {
		const call = await reviewCall({
			script: deliverable.script,
			answers: deliverable.answers,
			recommendation: deliverable.recommendation,
			transcript: deliverable.transcript,
			assessedLevel: deliverable.assessedLevel,
			recording: deliverable.recording,
		});
		stored = {
			deliverableId,
			kind: deliverable.kind,
			call,
			decision: agentDecision({ kind: deliverable.kind, review: call }),
		};
		summary = `${CALL_WORDS[deliverable.kind]} for ${deliverable.script.candidate.name}: ${VERDICT_WORDS[call.verdict]}. ${call.reasons.join(" ")}`;
	}
	stored = { ...stored, reviewedAt: new Date().toISOString() };
	await ports.saveReview(stored);
	await ports.log({ kind: "review", message: summary, data: { deliverableId, decision: stored.decision } });
	return { ok: true, message: summary, data: { policy: stored.decision } };
}

/** Executes the stored policy decision. The model may not override it; disagreements go to the company. */
export async function decide(
	ports: RoleAgentPorts,
	deliverableId: string,
	action: "accept" | "reject" | "escalate" | "follow_up",
	note?: string,
): Promise<ActionResult> {
	const review = await ports.getReview(deliverableId);
	if (!review) return fail("Review the deliverable first.");
	const policy = review.decision;
	if (action === "follow_up") {
		if (policy.action !== "follow_up") return fail(`Policy says "${policy.action}", not a follow-up.`);
		if (review.followUpAskedAt) return fail("Already waiting for the recruiter's answer.");
		const question = policy.question ?? "Can you add one concrete fact about the must-haves?";
		if (!ports.askRecruiter) {
			// No way to reach the recruiter: fall back to the company's daily digest.
			await ports.escalate({ deliverableId, question: `${policy.reason} ${question}`, delivery: "digest" });
			await ports.saveReview({ ...review, escalatedAt: new Date().toISOString() });
			await ports.log({
				kind: "escalated",
				message: `Added to today's digest: ${policy.reason}`,
				data: { deliverableId },
			});
			return { ok: true, message: "Added to the company's daily digest." };
		}
		await ports.askRecruiter(deliverableId, question);
		await ports.saveReview({
			...review,
			followUps: (review.followUps ?? 0) + 1,
			followUpAskedAt: new Date().toISOString(),
		});
		await ports.log({ kind: "note", message: `Asked the recruiter: ${question}`, data: { deliverableId } });
		return { ok: true, message: "Asked the recruiter one follow-up question." };
	}
	if (action !== "escalate" && action !== policy.action) {
		return fail(
			`Policy says "${policy.action}" (${policy.reason}). Escalate to the company if you disagree.`,
		);
	}
	const reason = note?.trim() || policy.reason;
	if (action === "accept") {
		const { signature } = await ports.acceptDeliverable(deliverableId, reason);
		// The backend returns signature "" when it only pre-accepts (sourcing: nothing paid until the
		// candidate confirms interest through their confirmation link).
		const how =
			review.kind === "sourcing" || signature === ""
				? "Pre-accepted (the recruiter is paid when the candidate confirms interest)"
				: policy.payout === "holdback"
					? "Accepted (paid with a holdback until the candidate confirms the call)"
					: "Accepted and paid";
		await ports.log({
			kind: "accepted",
			message: `${how}: ${reason}`,
			data: { deliverableId, signature, payout: policy.payout, decision: { action: "accept", reason } },
		});
		return { ok: true, message: `${how}.`, data: { signature } };
	}
	if (action === "reject") {
		const { signature } = await ports.rejectDeliverable(deliverableId, reason);
		await ports.log({
			kind: "rejected",
			message: `Sent back: ${reason}`,
			data: { deliverableId, signature, decision: { action: "reject", reason } },
		});
		return { ok: true, message: "Rejected with the reason shown to the recruiter.", data: { signature } };
	}
	if (review.escalatedAt) return fail("Already escalated; waiting for the company's decision.");
	const delivery = policy.action === "escalate" ? (policy.delivery ?? "now") : "now";
	await ports.escalate({ deliverableId, question: reason, delivery });
	await ports.saveReview({ ...review, escalatedAt: new Date().toISOString() });
	await ports.log({
		kind: "escalated",
		message: delivery === "digest" ? `Added to today's digest: ${reason}` : `Asked the company: ${reason}`,
		data: { deliverableId, delivery, decision: { action: "escalate", reason } },
	});
	return {
		ok: true,
		message: delivery === "digest" ? "Added to the company's daily digest." : "Escalated to the company.",
	};
}

/** Open gigs of a type; language-check variants don't count as screening calls. */
function activeGigsFor(role: RoleSnapshot, type: GigType) {
	return role.gigs.filter((g) => g.taskType === type && !isLanguageGig(g) && open(g));
}

/** Posts a SCREENING_CALL gig with a script for one candidate. Price and budget are checked here. */
export async function bookScreening(ports: RoleAgentPorts, candidateId: string): Promise<ActionResult> {
	const role = await ports.getRole();
	if (role.paused) return fail("The company paused the agent.");
	const blocked = pausedType(role, "SCREENING_CALL");
	if (blocked) return blocked;
	const candidate = role.candidates.find((c) => c.id === candidateId);
	if (!candidate?.sourcing) return fail(`No accepted candidate ${candidateId}.`);
	if (candidate.stage !== "sourced")
		return fail(`${candidate.name} is already at stage "${candidate.stage}".`);
	const booked = activeGigsFor(role, "SCREENING_CALL").filter((g) => g.acceptedCount === 0).length;
	if (booked >= POLICY.maxConcurrentScreenings) return fail(`Already ${booked} screenings in progress.`);
	const eligible = pickForScreening(
		role.candidates
			.filter(hasSourcing)
			.filter((c) => c.stage === "sourced")
			.map((c) => ({ id: c.id, review: c.sourcing })),
		booked,
	);
	if (!eligible.some((c) => c.id === candidateId)) {
		return fail(
			`${candidate.name} (${candidate.sourcing.score}) isn't eligible for screening under the policy.`,
		);
	}
	const bounty = price("SCREENING_CALL", role.criteria);
	if (role.budget.available < bounty)
		return fail(`Not enough budget: ${usd(role.budget.available)} left, a screening costs ${usd(bounty)}.`);
	const script = await screeningScript({
		criteria: role.criteria,
		candidate: { ...candidate, review: candidate.sourcing },
	});
	const { gigId } = await ports.postGig({
		taskType: "SCREENING_CALL",
		title: `30-min screening call with ${candidate.name}`,
		brief: `Call ${candidate.name} and work through the ${script.questions.length} script questions. Write a concrete answer to each and your recommendation. Paid for the quality of the answers, not the minutes.`,
		bounty,
		maxDeliverables: 1,
		exclusive: true,
		when: "now",
		candidateId,
		script,
	});
	await ports.log({
		kind: "booked",
		message: `Booked a screening call for ${candidate.name} · ${usd(bounty)}`,
		data: { gigId, candidateId },
	});
	return { ok: true, message: `Screening gig posted for ${candidate.name}.`, data: { gigId } };
}

/**
 * Posts a language check (SCREENING_CALL, variant "language", $15) when the criteria name a language to check. Booked for the
 * finalist together with the reference check; refused when the backend can't store the type yet.
 */
export async function bookLanguageCheck(ports: RoleAgentPorts, candidateId: string): Promise<ActionResult> {
	const role = await ports.getRole();
	const lang = requiredLanguage(role.criteria);
	if (!lang) return fail("The role doesn't require a language besides English.");
	const blocked = pausedType(role, "SCREENING_CALL");
	if (blocked) return blocked;
	const candidate = role.candidates.find((c) => c.id === candidateId);
	if (!candidate) return fail(`No candidate ${candidateId}.`);
	if (
		candidate.language ||
		role.gigs.some((g) => isLanguageGig(g) && g.candidateId === candidateId && open(g))
	)
		return fail(`A language check for ${candidate.name} already exists.`);
	const bounty = price("SCREENING_CALL", role.criteria, "language");
	if (role.budget.available < bounty) return fail(`Not enough budget for a language check (${usd(bounty)}).`);
	const script = languageScript({
		language: lang.name,
		level: lang.level,
		criteria: role.criteria,
		candidate,
	});
	const { gigId } = await ports.postGig({
		taskType: "SCREENING_CALL",
		variant: "language",
		title: `${lang.name} language check (${lang.level}) with ${candidate.name}`,
		brief: `A 15-minute call in ${lang.name} with ${candidate.name}, following 5 prompts. Deliver what they said to each, your CEFR estimate (the role needs ${lang.level}) and, if you can, the transcript.`,
		bounty,
		maxDeliverables: 1,
		exclusive: true,
		when: "now",
		candidateId,
		script,
	});
	await ports.log({
		kind: "booked",
		message: `Booked ${/^[aeiou]/i.test(lang.name) ? "an" : "a"} ${lang.name} language check for ${candidate.name} · ${usd(bounty)}`,
		data: { gigId, candidateId },
	});
	return { ok: true, message: `${lang.name} language check posted.`, data: { gigId } };
}

/** Whether a candidate is cleared on language: no requirement, not supported, or passed. */
function languageCleared(role: RoleSnapshot, c: CandidateView): boolean | "pending" {
	if (!requiredLanguage(role.criteria)) return true;
	if (c.language) return c.language.language?.meetsLevel ?? c.language.verdict === "ACCEPT";
	const booked = role.gigs.some((g) => isLanguageGig(g) && g.candidateId === c.id && open(g));
	return booked ? "pending" : true;
}

/** Posts a REFERENCE_CHECK gig for a candidate whose screening was accepted. */
export async function bookReference(ports: RoleAgentPorts, candidateId: string): Promise<ActionResult> {
	const role = await ports.getRole();
	if (role.paused) return fail("The company paused the agent.");
	const blocked = pausedType(role, "REFERENCE_CHECK");
	if (blocked) return blocked;
	const candidate = role.candidates.find((c) => c.id === candidateId);
	if (!candidate) return fail(`No candidate ${candidateId}.`);
	if (candidate.screening?.verdict !== "ACCEPT")
		return fail(`${candidate.name} has no accepted screening yet.`);
	if (languageCleared(role, candidate) === false)
		return fail(`${candidate.name} is below the required language level.`);
	if (
		candidate.reference ||
		role.gigs.some((g) => g.taskType === "REFERENCE_CHECK" && g.candidateId === candidateId && open(g))
	)
		return fail(`A reference check for ${candidate.name} already exists.`);
	const bounty = price("REFERENCE_CHECK", role.criteria);
	if (role.budget.available < bounty)
		return fail(
			`Not enough budget: ${usd(role.budget.available)} left, a reference check costs ${usd(bounty)}.`,
		);
	const script = await referenceScript({ criteria: role.criteria, candidate });
	const { gigId } = await ports.postGig({
		taskType: "REFERENCE_CHECK",
		title: `Reference check for ${candidate.name}`,
		brief: `Call one of ${candidate.name}'s references and work through the 5 questions. Write specific answers, including how the reference knows them.`,
		bounty,
		maxDeliverables: 1,
		exclusive: true,
		when: "now",
		candidateId,
		script,
	});
	await ports.log({
		kind: "booked",
		message: `Booked a reference check for ${candidate.name} · ${usd(bounty)}`,
		data: { gigId, candidateId },
	});
	return { ok: true, message: `Reference gig posted for ${candidate.name}.`, data: { gigId } };
}

export async function buildShortlist(ports: RoleAgentPorts): Promise<ActionResult> {
	const role = await ports.getRole();
	const candidates = role.candidates.filter(hasSourcing).filter((c) => c.stage !== "rejected");
	if (!candidates.some((c) => c.screening?.verdict === "ACCEPT"))
		return fail("Nobody has passed a screening call yet.");
	const entries = await shortlist({
		role: { title: role.title, criteria: role.criteria },
		candidates: candidates.map((c) => ({
			id: c.id,
			name: c.name,
			sourcing: c.sourcing,
			...(c.screening ? { screening: c.screening } : {}),
			...(c.reference ? { reference: c.reference } : {}),
			...(c.language ? { language: c.language } : {}),
		})),
	});
	await ports.saveShortlist(entries);
	await ports.log({
		kind: "shortlist",
		message: `Shortlist ready: ${entries.map((e) => e.name).join(", ")}`,
		data: { ids: entries.map((e) => e.id) },
	});
	return {
		ok: true,
		message: "Shortlist sent to the company.",
		data: entries.map(({ id, name, rank, overall, stage }) => ({ id, name, rank, overall, stage })),
	};
}

// ---- Company instructions ----------------------------------------------------

export interface CriteriaChange {
	add?: { kind: "mustHave" | "niceToHave" | "dealBreaker"; label: string; weight: number }[];
	remove?: string[];
	reweight?: { id: string; weight: number }[];
	note: string;
}

export async function adjustCriteria(ports: RoleAgentPorts, change: CriteriaChange): Promise<ActionResult> {
	const role = await ports.getRole();
	const removed = new Set(change.remove ?? []);
	const weights = new Map((change.reweight ?? []).map((r) => [r.id, r.weight]));
	const keep = (list: Criterion[]) =>
		list.filter((c) => !removed.has(c.id)).map((c) => ({ ...c, weight: weights.get(c.id) ?? c.weight }));
	const additions = (kind: NonNullable<CriteriaChange["add"]>[number]["kind"]) =>
		(change.add ?? [])
			.filter((a) => a.kind === kind)
			.map((a) => ({ id: "", label: a.label, weight: a.weight }));
	const next = normalizeCriteria({
		...role.criteria,
		mustHave: [...keep(role.criteria.mustHave), ...additions("mustHave")],
		niceToHave: [...keep(role.criteria.niceToHave), ...additions("niceToHave")],
		dealBreakers: [...keep(role.criteria.dealBreakers), ...additions("dealBreaker")],
	});
	if (!next.mustHave.length) return fail("A role needs at least one must-have.");
	await ports.updateCriteria(next, change.note);
	await ports.log({
		kind: "criteria_changed",
		message: change.note,
		data: { mustHave: next.mustHave.map((c) => c.label) },
	});
	return { ok: true, message: "Criteria updated; new sourcing reviews use them.", data: next };
}

export async function setGigsPaused(
	ports: RoleAgentPorts,
	input: { taskTypes?: PortTaskType[]; gigIds?: string[] },
	paused: boolean,
): Promise<ActionResult> {
	const role = await ports.getRole();
	const ids = role.gigs
		.filter((g) => g.status === (paused ? "OPEN" : "PAUSED"))
		.filter((g) => (input.gigIds?.length ? input.gigIds.includes(g.gigId) : true))
		.filter((g) => (input.taskTypes?.length ? input.taskTypes.includes(g.taskType) : true))
		.map((g) => g.gigId);
	// Pausing a type also stops the agent from posting new gigs of it (e.g. "pause screening").
	const types = input.gigIds?.length || !ports.setTaskTypePaused ? [] : (input.taskTypes ?? []);
	if (!ids.length && !types.length) return fail(`No ${paused ? "open" : "paused"} gigs match.`);
	if (ids.length) await ports.setGigStatus(ids, paused ? "PAUSED" : "OPEN");
	if (types.length) await ports.setTaskTypePaused?.(types, paused);
	const titles = role.gigs.filter((g) => ids.includes(g.gigId)).map((g) => g.title);
	const what = types.length
		? `the ${types.map((t) => GIG_WORDS[t]).join(" and ")}`
		: titles.length === 1
			? `“${titles[0]}”`
			: `${titles.length} gigs`;
	await ports.log({
		kind: paused ? "gigs_paused" : "gigs_resumed",
		message: `${paused ? "Paused" : "Resumed"} ${what}.`,
		data: { gigIds: ids, taskTypes: types },
	});
	return { ok: true, message: `${paused ? "Paused" : "Resumed"} ${what}.` };
}

/** Extra SOURCING capacity (calls are booked per candidate). Count is capped by the budget. */
export async function postExtraSourcing(
	ports: RoleAgentPorts,
	input: { count: number; focus?: string },
): Promise<ActionResult> {
	const role = await ports.getRole();
	if (role.paused) return fail("The company paused the agent.");
	const blocked = pausedType(role, "SOURCING");
	if (blocked) return blocked;
	const bounty = price("SOURCING", role.criteria);
	const affordable = Number(role.budget.available / bounty);
	const count = Math.min(input.count, affordable, 30);
	if (count < 1)
		return fail(`Not enough budget: ${usd(role.budget.available)} left, a profile costs ${usd(bounty)}.`);
	const focus = input.focus?.trim();
	const { gigId } = await ports.postGig({
		taskType: "SOURCING",
		title: `Find up to ${count} more ${role.title} candidates${focus ? ` (${focus})` : ""}`,
		brief: `Find more ${role.title} candidates${focus ? ` with ${focus}` : ""}, open to a conversation. Must have: ${role.criteria.mustHave
			.slice(0, 3)
			.map((c) => c.label.toLowerCase())
			.join(
				"; ",
			)}. Deliver a profile link and a 2-line note; paid ${usd(bounty)} per profile the agent accepts.`,
		bounty,
		maxDeliverables: count,
		exclusive: false,
		when: "now",
	});
	await ports.log({
		kind: "gig_posted",
		message: `Posted: find ${count} more candidates${focus ? ` (${focus})` : ""} · ${usd(bounty)} each`,
		data: { gigId },
	});
	return {
		ok: true,
		message: `Posted a sourcing gig for ${count} profiles at ${usd(bounty)}${count < input.count ? ` (budget allows ${count})` : ""}.`,
		data: { gigId },
	};
}

export async function explainDecision(
	ports: RoleAgentPorts,
	input: { candidateName?: string; deliverableId?: string },
): Promise<ActionResult> {
	let records = await ports.getDecisionLog({ ...input, limit: 10 });
	let deliverableId = input.deliverableId;
	if (!records.length && input.candidateName) {
		// "Piotr" → "Piotr Lewandowski": resolve a partial name against candidates and deliveries.
		const needle = foldName(input.candidateName);
		const role = await ports.getRole();
		const pending = await ports.listPendingDeliverables();
		const names = [
			...role.candidates.map((c) => c.name),
			...pending.map((d) => (d.kind === "sourcing" ? d.candidate.name : d.script.candidate.name)),
		];
		const full = names.find((n) => foldName(n).includes(needle) || needle.includes(foldName(n)));
		if (full && full !== input.candidateName)
			records = await ports.getDecisionLog({ candidateName: full, limit: 10 });
		if (!records.length) {
			const parts = needle.split(/\s+/).filter((p) => p.length > 2);
			for (const p of parts) {
				records = await ports.getDecisionLog({ candidateName: p, limit: 10 });
				if (records.length) break;
			}
		}
	}
	deliverableId ??= records.find((r) => r.deliverableId)?.deliverableId;
	const review = deliverableId ? await ports.getReview(deliverableId) : null;
	if (!records.length && !review) return fail("No decisions found for that candidate or deliverable.");
	return {
		ok: true,
		message: "Decision history.",
		data: {
			records,
			review: review && {
				policy: review.decision,
				sourcing: review.sourcing && {
					score: review.sourcing.score,
					recommendation: review.sourcing.recommendation,
					verdicts: review.sourcing.verdicts.filter((v) => v.verdict !== "MET"),
				},
				call: review.call && {
					verdict: review.call.verdict,
					score: review.call.score,
					reasons: review.call.reasons,
				},
			},
		},
	};
}

// ---- Deterministic step (no model) -------------------------------------------

/**
 * One pass of the agent's job without an LLM: post initial gigs, review and decide every pending
 * deliverable, book screenings and reference checks, and build the shortlist when there's a
 * referenced finalist. Used offline, as a fallback, and by the "run agent step" debug action.
 */
export async function advanceRole(ports: RoleAgentPorts): Promise<string[]> {
	const done: string[] = [];
	const note = (...rs: ActionResult[]) => {
		for (const r of rs) done.push(r.ok ? r.message : `skipped: ${r.error}`);
	};
	let role = await ports.getRole();
	if (role.paused) return ["The company paused the agent."];
	if (!role.gigs.length) note(await postInitialGigs(ports));

	// Reviews run in parallel (Jev ~1 s each); decisions are applied one by one.
	const pending = await ports.listPendingDeliverables();
	const needsReview = async (d: (typeof pending)[number]) => {
		const r = await ports.getReview(d.id);
		return !r || Boolean(r.reviewedAt && d.updatedAt && d.updatedAt > r.reviewedAt);
	};
	const fresh = await Promise.all(
		pending.map(async (d) => ((await needsReview(d)) ? reviewDeliverable(ports, d.id) : null)),
	);
	for (const r of fresh) if (r) note(r);
	for (const d of pending) {
		const review = await ports.getReview(d.id);
		if (!review || review.escalatedAt || review.followUpAskedAt) continue; // waiting on a person
		note(await decide(ports, d.id, review.decision.action));
	}

	role = await ports.getRole();
	const booked = activeGigsFor(role, "SCREENING_CALL").filter((g) => g.acceptedCount === 0).length;
	const sourced = role.candidates.filter(
		(c): c is CandidateView & { sourcing: NonNullable<CandidateView["sourcing"]> } =>
			Boolean(c.stage === "sourced" && c.sourcing),
	);
	for (const pick of pickForScreening(
		sourced.map((c) => ({ id: c.id, review: c.sourcing })),
		booked,
	)) {
		note(await bookScreening(ports, pick.id));
	}

	role = await ports.getRole();
	const hasReference =
		role.candidates.some((c) => c.reference) || role.gigs.some((g) => g.taskType === "REFERENCE_CHECK");
	const finalist = role.candidates
		.filter((c) => c.screening?.verdict === "ACCEPT" && languageCleared(role, c) !== false)
		.sort((a, b) => (b.screening?.candidateFit ?? 0) - (a.screening?.candidateFit ?? 0))[0];
	if (finalist && !hasReference) {
		const language = await bookLanguageCheck(ports, finalist.id);
		if (language.ok || !/doesn't require|already exists/.test(language.error)) note(language);
		note(await bookReference(ports, finalist.id));
	}

	note(...(await repriceOpenGigs(ports)));
	note(...(await replanIfDry(ports)));

	role = await ports.getRole();
	const callsPending = role.gigs.some((g) => g.taskType !== "SOURCING" && open(g) && g.acceptedCount === 0);
	if (role.candidates.some((c) => c.reference?.verdict === "ACCEPT") && !callsPending)
		note(await buildShortlist(ports));
	return done;
}

// ---- Repricing and replanning ----------------------------------------------------

const hoursSince = (iso?: string, now = Date.now()) =>
	iso ? Math.max(0, (now - Date.parse(iso)) / 3_600_000) : 0;
const usdOf = (base: bigint) => Number(base / BigInt(USDC_UNIT));
const DEFAULT_MAX_BOUNTY_MULTIPLIER = 2;

/** Raises open gigs that aren't moving (repriceRule). Needs ports.repriceGig and gig.postedAt. */
export async function repriceOpenGigs(ports: RoleAgentPorts, now = Date.now()): Promise<ActionResult[]> {
	// Demo runs: raises are the company's button, never automatic (thresholds are in real hours).
	if (!ports.repriceGig || demoFast()) return [];
	const role = await ports.getRole();
	if (role.paused) return [];
	const results: ActionResult[] = [];
	let available = usdOf(role.budget.available);
	for (const g of role.gigs.filter((x) => x.status === "OPEN" && x.postedAt)) {
		const floor = priceForRole(role.criteria, g.taskType, g.variant).usd;
		const maxBounty = role.maxBounty ? usdOf(role.maxBounty) : floor * DEFAULT_MAX_BOUNTY_MULTIPLIER;
		const r = repriceRule({
			gig: { ...g, bounty: usdOf(g.bounty) },
			hoursOpen: hoursSince(g.postedAt, now),
			claims: g.claims ?? 0,
			deliveries: g.deliveries ?? g.pendingCount + g.acceptedCount,
			maxBounty,
			budgetAvailable: available,
			...(g.lastRepricedAt ? { hoursSinceLastRaise: hoursSince(g.lastRepricedAt, now) } : {}),
		});
		if (r.action !== "raise") continue;
		const bounty = BigInt(r.bounty) * BigInt(USDC_UNIT);
		await ports.repriceGig(g.gigId, bounty, r.reason);
		available -= (r.bounty - usdOf(g.bounty)) * (g.maxDeliverables - g.acceptedCount);
		await ports.log({ kind: "repriced", message: r.reason, data: { gigId: g.gigId, bounty: r.bounty } });
		results.push({ ok: true, message: r.reason });
	}
	return results;
}

/** Ladder rungs already taken in this role, read back from its gigs and the decision log. */
async function ladderHistory(ports: RoleAgentPorts, role: RoleSnapshot): Promise<ReplanStepName[]> {
	const done: ReplanStepName[] = [];
	const sourcing = role.gigs.filter((g) => g.taskType === "SOURCING");
	if (sourcing.length > 1) done.push("more_sourcing");
	const floor = priceForRole(role.criteria, "SOURCING").usd;
	if (sourcing.some((g) => usdOf(g.bounty) > floor)) done.push("raise_price");
	const log = await ports.getDecisionLog({ limit: 200 });
	if (log.some((r) => r.reason.includes("nice-to-have?"))) done.push("loosen_criterion");
	if (log.some((r) => r.reason.includes("top-up buys"))) done.push("request_top_up");
	return done;
}

/** One rung of the replanning ladder when the pipeline is dry (see gigs/replan.ts). */
export async function replanIfDry(ports: RoleAgentPorts, now = Date.now()): Promise<ActionResult[]> {
	const role = await ports.getRole();
	if (role.paused) return [];
	const sourcingGigs = role.gigs.filter((g) => g.taskType === "SOURCING");
	const live = sourcingGigs.find((g) => g.status !== "CLOSED") ?? null;
	const latest = live ?? sourcingGigs.at(-1) ?? null;
	if (!latest) return [];
	const screeningBounty = priceForRole(role.criteria, "SCREENING_CALL").usd;
	const inFlight =
		role.candidates.filter(
			(c) =>
				(c.stage === "sourced" && (c.sourcing?.recommendation ?? "") === "ADVANCE") ||
				c.stage === "screening" ||
				c.stage === "screened" ||
				c.stage === "reference" ||
				c.stage === "referenced",
		).length + role.gigs.filter((g) => g.taskType !== "SOURCING" && g.status === "OPEN").length;
	const state: PipelineState = {
		criteria: role.criteria,
		budgetAvailable: usdOf(role.budget.available),
		maxBounty: role.maxBounty
			? usdOf(role.maxBounty)
			: priceForRole(role.criteria, "SOURCING").usd * DEFAULT_MAX_BOUNTY_MULTIPLIER,
		sourcing: {
			bounty: usdOf(latest.bounty),
			maxDeliverables: latest.maxDeliverables,
			acceptedCount: latest.acceptedCount,
			deliveries: latest.deliveries ?? latest.pendingCount + latest.acceptedCount,
			claims: latest.claims ?? 0,
			hoursOpen: hoursSince(latest.postedAt, now),
			exhausted: !live || live.acceptedCount >= live.maxDeliverables,
		},
		screeningBounty,
		inFlight,
		targetInFlight: Math.max(1, POLICY.maxConcurrentScreenings),
		reviews:
			(await ports.listSourcingReviews?.()) ??
			role.candidates.flatMap((c) => (c.sourcing ? [c.sourcing] : [])),
		done: await ladderHistory(ports, role),
	};
	const step = replanStep(state);
	if (step.step === "none") return [];
	await ports.log({ kind: "replan", message: step.reason, data: { step: step.step, value: step.value } });
	if (step.step === "more_sourcing") return [await postExtraSourcing(ports, { count: Number(step.value) })];
	if (step.step === "raise_price") {
		if (!ports.repriceGig || !live) return [{ ok: false, error: "Repricing isn't available." }];
		await ports.repriceGig(live.gigId, BigInt(Number(step.value)) * BigInt(USDC_UNIT), step.reason);
		return [{ ok: true, message: step.reason }];
	}
	await ports.escalate({ question: step.reason, delivery: "now" });
	return [{ ok: true, message: step.reason }];
}

// ---- Read-only lookups for company chat ---------------------------------------------------

const callView = (r: CandidateView["screening"]) =>
	r && {
		verdict: r.verdict,
		score: r.score,
		candidateFit: r.candidateFit,
		summary: r.summaryForCompany,
		reasons: r.reasons,
		...(r.language ? { language: r.language } : {}),
	};

/** A candidate's profile, every review and the decisions about them. */
export async function getCandidate(
	ports: RoleAgentPorts,
	input: { name?: string; candidateId?: string },
): Promise<ActionResult> {
	const role = await ports.getRole();
	const needle = input.name ? foldName(input.name) : "";
	const c =
		role.candidates.find((x) => x.id === input.candidateId) ??
		(needle ? role.candidates.find((x) => foldName(x.name).includes(needle)) : undefined);
	if (!c) {
		const pending = (await ports.listPendingDeliverables()).find(
			(d) => d.kind === "sourcing" && needle && foldName(d.candidate.name).includes(needle),
		);
		if (pending)
			return {
				ok: true,
				message: `${pending.kind === "sourcing" ? pending.candidate.name : ""} is still being reviewed.`,
				data: { deliverableId: pending.id, stage: "submitted" },
			};
		return fail(`No candidate matching "${input.name ?? input.candidateId}".`);
	}
	const decisions = await ports.getDecisionLog({ candidateName: c.name, limit: 20 });
	return {
		ok: true,
		message: `${c.name}: ${c.stage}.`,
		data: {
			id: c.id,
			name: c.name,
			profileUrl: c.profileUrl,
			stage: c.stage,
			fit: candidateFit(c),
			notes: c.notes,
			sourcing: c.sourcing && {
				score: c.sourcing.score,
				recommendation: c.sourcing.recommendation,
				summary: c.sourcing.summary,
				verdicts: c.sourcing.verdicts,
			},
			screening: callView(c.screening),
			reference: callView(c.reference),
			languageCheck: callView(c.language),
			decisions: decisions.map((d) => ({
				at: d.at,
				action: d.action,
				reason: d.reason,
				deliverableId: d.deliverableId,
			})),
		},
	};
}

/**
 * One delivery in full: what the recruiter submitted (call: question → answer, recommendation,
 * transcript excerpt) and the agent's review. By id, or the latest of a kind for a candidate.
 */
export async function getDeliverableDetails(
	ports: RoleAgentPorts,
	input: { deliverableId?: string; candidateName?: string; kind?: Deliverable["kind"] },
): Promise<ActionResult> {
	let id = input.deliverableId;
	if (!id) {
		if (!input.candidateName) return fail("Give a deliverable id, or a candidate name and a kind.");
		const needle = foldName(input.candidateName);
		const nameOf = (d: Deliverable) => (d.kind === "sourcing" ? d.candidate.name : d.script.candidate.name);
		const ids = [
			...(await ports.getDecisionLog({ candidateName: input.candidateName, limit: 50 })).flatMap((r) =>
				r.deliverableId ? [r.deliverableId] : [],
			),
			...(await ports.listPendingDeliverables())
				.filter((d) => foldName(nameOf(d)).includes(needle))
				.map((d) => d.id),
		];
		const found: Deliverable[] = [];
		for (const x of [...new Set(ids)]) {
			const d = await ports.getDeliverable(x);
			if (d && (!input.kind || d.kind === input.kind) && foldName(nameOf(d)).includes(needle)) found.push(d);
		}
		found.sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : 1));
		id = found.at(-1)?.id;
		if (!id)
			return fail(`No ${input.kind ?? ""} delivery found for "${input.candidateName}".`.replace("  ", " "));
	}
	const [d, review] = await Promise.all([ports.getDeliverable(id), ports.getReview(id)]);
	if (!d) return fail(`No delivery ${id}.`);
	const base = {
		deliverableId: d.id,
		kind: d.kind,
		recruiter: d.recruiter.displayName,
		submittedAt: d.submittedAt,
	};
	const decision = review && { action: review.decision.action, reason: review.decision.reason };
	if (d.kind === "sourcing") {
		return {
			ok: true,
			message: `Sourcing delivery for ${d.candidate.name}.`,
			data: {
				...base,
				candidate: d.candidate,
				decision,
				review: review?.sourcing && {
					score: review.sourcing.score,
					recommendation: review.sourcing.recommendation,
					summary: review.sourcing.summary,
				},
			},
		};
	}
	const answers = new Map(d.answers.map((a) => [a.questionId, a.answer]));
	const extracted = new Map((review?.call?.extractedAnswers ?? []).map((a) => [a.questionId, a.answer]));
	return {
		ok: true,
		message: `${d.kind} notes for ${d.script.candidate.name}.`,
		data: {
			...base,
			candidate: d.script.candidate.name,
			recommendation: d.recommendation ?? null,
			answers: d.script.questions.map((q) => ({
				question: q.question,
				answer: answers.get(q.id) || extracted.get(q.id) || "(no answer)",
			})),
			...(d.transcript ? { transcriptExcerpt: d.transcript.slice(0, 1500) } : {}),
			decision,
			review: review?.call && {
				verdict: review.call.verdict,
				score: review.call.score,
				reasons: review.call.reasons,
				summary: review.call.summaryForCompany,
			},
		},
	};
}
