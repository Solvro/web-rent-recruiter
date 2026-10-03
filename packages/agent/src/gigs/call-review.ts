/**
 * Reviews a screening, reference or language-check deliverable: is the recruiter's work good
 * enough to pay? Jev judges each answer (addressed / specific / matches what good looks like /
 * contradicts); code turns that into a verdict. Quality, not length: filler is generic.
 *
 * Two inputs: the recruiter's notes per question, or a call transcript only (e.g. a Recall
 * recording). For transcripts Jev also picks the segment that answers each question, which is
 * returned as `extractedAnswers`. Language checks add a CEFR level estimate.
 */
import { z } from "zod";
import { askJev, type JevQuestion, jevKey, noulOf } from "../jev.ts";
import { complete, resolveProviderName } from "../llm/index.ts";
import { prompt } from "../prompts.ts";
import { SUMMARY_BUDGET_MS } from "../review.ts";
import { detectInjection, stripInjection, untrusted } from "../untrusted.ts";
import { POLICY } from "./policy.ts";
import {
	CallDeliverable,
	type CallReview,
	type CefrLevel,
	type QuestionCheck,
	type ScriptQuestion,
} from "./types.ts";

/** Thresholds (documented in README): per-answer probabilities and the verdict rules. */
export const CALL_THRESHOLDS = {
	/** P(answer responds to the question) below this → treated as missing. */
	addressed: 0.35,
	/** P(answer has candidate-specific facts) below this → generic. */
	specific: 0.4,
	/** P(answer contradicts the profile or another answer) at or above this → contradiction. */
	contradiction: 0.6,
	/** P(recommendation consistent with the answers) below this → flagged. */
	consistent: 0.4,
	acceptScore: 70,
	rejectScore: 45,
	/** Max missing answers for ACCEPT. */
	acceptMissing: 1,
	/** REJECT when fewer than this share of questions has a real answer. */
	minAnsweredShare: 0.5,
	/** Score points lost per contradiction. */
	contradictionPenalty: 15,
	/** Transcript mode: evidence segment needs at least this Choice probability to be quoted. */
	evidence: 0.4,
	/** Language checks: recruiter's level vs. transcript level this many CEFR steps apart → escalate. */
	levelDisagreement: 2,
	/** Transcript integrity: minimum call length per kind (seconds) and script coverage. */
	minCallSeconds: { screening: 15 * 60, reference: 8 * 60, language: 8 * 60 },
	minCoverage: 0.6,
	/** Score points lost per failed integrity check; 2+ failures reject. */
	integrityPenalty: 10,
} as const;

export const CEFR_LEVELS: CefrLevel[] = ["A1", "A2", "B1", "B2", "C1", "C2"];
/** Descriptors for the Jev Score question, one per level (Council of Europe global scale, spoken). */
export const CEFR_DESCRIPTORS = [
	"A1: isolated words and memorized phrases; can't sustain a conversation",
	"A2: short simple sentences on familiar topics; frequent pauses and basic errors",
	"B1: can describe experience and plans in connected but simple speech; noticeable gaps",
	"B2: discusses work topics fluently and spontaneously; occasional errors that don't block meaning",
	"C1: fluent and precise on complex professional topics; rare, self-corrected errors",
	"C2: effortless, nuanced, near-native expression",
];

export type CallDeliverableInput = z.input<typeof CallDeliverable>;
/** A review before the summary, engine and injection flags are attached. */
type Decided = Omit<CallReview, "summaryForCompany" | "engine" | "flags" | "confidence" | "noShow">;

const MIN_WORDS = 3;
const GENERIC =
	/^(yes|no|ok|okay|fine|good|great|n\/?a|none|-|\.|same|see above|as above|she is good|he is good|seems (fine|good|ok))\.?$/i;
const FILLER =
	/\b(motivated|team player|good fit|great fit|strong candidate|seems (fine|good|ok)|hard[- ]working|passionate|good communication|nice person|fast learner)\b/gi;

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);

interface Probs {
	addressed: number;
	specific: number;
	fit: number;
	contradicts: number;
}

function offlineProbs(q: ScriptQuestion, answer: string): Probs {
	const text = answer.trim();
	const w = words(text);
	if (w.length < MIN_WORDS || GENERIC.test(text))
		return { addressed: 0, specific: 0, fit: 0, contradicts: 0 };
	const filler = (text.match(FILLER) ?? []).length;
	const concrete =
		(text.match(/\d/g) ? 1 : 0) +
		(text.match(/\b[A-Z][a-zA-Z0-9]+/g)?.slice(1).length ? 1 : 0) +
		(w.length >= 12 ? 1 : 0);
	const goodTokens = new Set(
		words(q.whatGoodLooksLike.toLowerCase())
			.map((t) => t.replace(/[^a-z0-9]/g, ""))
			.filter((t) => t.length > 3),
	);
	const overlap = words(text.toLowerCase()).filter((t) => goodTokens.has(t.replace(/[^a-z0-9]/g, ""))).length;
	return {
		addressed: 0.8,
		specific: Math.max(0, Math.min(1, concrete / 3 - filler * 0.2)),
		fit: Math.min(1, 0.4 + overlap * 0.1 + concrete * 0.1),
		contradicts: 0,
	};
}

type Mode = "notes" | "transcript";

/** Transcript → at most 200 segments (Jev Choice allows 255 options), merging short lines. */
export function transcriptSegments(transcript: string, max = 200): string[] {
	let segments = transcript
		.split(/\n+/)
		.map((l) => l.trim())
		.filter(Boolean)
		.reduce<string[]>((acc, line) => {
			const last = acc.at(-1);
			if (last && last.length < 80 && line.length < 80) acc[acc.length - 1] = `${last} ${line}`;
			else acc.push(line);
			return acc;
		}, []);
	while (segments.length > max) {
		const merged: string[] = [];
		for (let i = 0; i < segments.length; i += 2) merged.push(segments.slice(i, i + 2).join(" "));
		segments = merged;
	}
	return segments.map((s) => (s.length > 1200 ? `${s.slice(0, 1197)}…` : s));
}

function jevQuestions(d: CallDeliverable, mode: Mode, segmentIds: string[]): Record<string, JevQuestion> {
	const q: Record<string, JevQuestion> = {};
	const source =
		mode === "notes" ? "the recruiter's answer to" : "the candidate's answer in the transcript to";
	for (const s of d.script.questions) {
		const subject =
			mode === "notes"
				? `the answer to ${s.id}`
				: `the candidate's answer to "${s.question}" in the transcript`;
		q[`${s.id}__addressed`] =
			mode === "notes"
				? {
						type: "noul",
						instructions: `Does ${source} ${s.id} actually respond to its question?`,
						criteria: {
							true: "It answers the question about the candidate",
							false: "Empty, off-topic or dodges the question",
						},
					}
				: {
						type: "noul",
						instructions: `Was this question asked and answered by the candidate in the transcript: "${s.question}"?`,
						criteria: {
							true: "The transcript contains the candidate's answer to it",
							false: "Not asked, not answered, or only small talk",
						},
					};
		q[`${s.id}__specific`] = {
			type: "noul",
			instructions: `Is ${subject} specific, with concrete facts (projects, numbers, names, dates, their own words)?`,
			criteria: {
				true: "Concrete details only this candidate's call would produce",
				false: "Generic praise or filler that could describe almost anyone",
			},
		};
		q[`${s.id}__fit`] = {
			type: "noul",
			instructions: `Does ${subject} show this: "${s.whatGoodLooksLike}"?`,
		};
		q[`${s.id}__contradicts`] = {
			type: "noul",
			instructions: `Does ${subject} contradict the candidate's profile notes or another answer in the call?`,
			criteria: {
				true: "States something incompatible with the profile or another answer",
				false: "Consistent, or nothing to compare",
			},
		};
		if (mode === "transcript") {
			q[`${s.id}__ev`] = {
				type: "choice",
				instructions: `Which transcript segment contains the candidate's answer to "${s.question}"?`,
				criteria: {
					...Object.fromEntries(segmentIds.map((id) => [id, null])),
					none: "Not answered in the transcript",
				},
			};
		}
	}
	if (d.recommendation) {
		q.recommendation_consistent = {
			type: "noul",
			instructions: "Is the recruiter's recommendation consistent with what the candidate said?",
		};
	}
	if (d.script.kind === "language" && d.script.language) {
		q.cefr = {
			type: "score",
			instructions: `Which CEFR level best describes the candidate's spoken ${d.script.language.name} in this ${
				mode === "transcript"
					? "transcript (judge only the candidate's turns)"
					: "call, judging from the quotes and notes"
			}?`,
			criteria: CEFR_DESCRIPTORS,
		};
	}
	return q;
}

function checkFrom(q: ScriptQuestion, answer: string, p: Probs, mode: Mode): QuestionCheck {
	const tooShort = mode === "notes" && (words(answer).length < MIN_WORDS || GENERIC.test(answer.trim()));
	const missing = tooShort || (mode === "transcript" && !answer) || p.addressed < CALL_THRESHOLDS.addressed;
	const generic = !missing && p.specific < CALL_THRESHOLDS.specific;
	const contradiction = !missing && p.contradicts >= CALL_THRESHOLDS.contradiction;
	// Work quality: missing 0, generic 0.35, otherwise 0.6-1.0 by specificity.
	const quality = missing ? 0 : generic ? 0.35 : 0.6 + 0.4 * p.specific;
	return { questionId: q.id, missing, generic, contradiction, fit: missing ? 0 : p.fit, quality };
}

/** Pure: checks → verdict, score, reasons. Exported for tests. */
export function decideCall(
	deliverable: Pick<CallDeliverable, "recommendation">,
	checks: QuestionCheck[],
	recommendationConsistent: number,
	/** The script's questions: reasons quote them instead of ids (missing/checks keep the ids). */
	questions?: { id: string; question: string }[],
): Decided {
	const t = CALL_THRESHOLDS;
	const n = Math.max(1, checks.length);
	const missing = checks.filter((c) => c.missing).map((c) => c.questionId);
	const generic = checks.filter((c) => c.generic).map((c) => c.questionId);
	const contradictions = checks.filter((c) => c.contradiction).map((c) => c.questionId);
	const quality = checks.reduce((s, c) => s + c.quality, 0) / n;
	const score = Math.max(0, Math.round(100 * quality) - t.contradictionPenalty * contradictions.length);
	const answered = checks.filter((c) => !c.missing);
	const candidateFit = answered.length ? Math.round((100 * answered.reduce((s, c) => s + c.fit, 0)) / n) : 0;
	const inconsistent = Boolean(deliverable.recommendation) && recommendationConsistent < t.consistent;

	const text = new Map((questions ?? []).map((q) => [q.id, q.question]));
	const quote = (ids: string[]) =>
		ids
			.map((id) => {
				const q = text.get(id);
				if (!q) return id;
				return `"${q.length > 70 ? `${q.slice(0, 69).trimEnd()}…` : q}"`;
			})
			.join("; ");
	const reasons: string[] = [];
	if (missing.length) reasons.push(`No usable answer to ${quote(missing)}.`);
	if (generic.length) reasons.push(`Generic answers without candidate-specific facts: ${quote(generic)}.`);
	if (contradictions.length)
		reasons.push(`Answers contradict the profile or each other: ${quote(contradictions)}.`);
	if (inconsistent)
		reasons.push(`The recommendation (${deliverable.recommendation}) doesn't match what the answers say.`);

	let verdict: CallReview["verdict"];
	if (answered.length / n < t.minAnsweredShare || score < t.rejectScore || contradictions.length >= 2) {
		verdict = "REJECT";
	} else if (
		score >= t.acceptScore &&
		missing.length <= t.acceptMissing &&
		!contradictions.length &&
		!inconsistent
	) {
		verdict = "ACCEPT";
	} else {
		verdict = "ESCALATE";
	}
	if (verdict === "ACCEPT" && !reasons.length) reasons.push("Every question has a specific, usable answer.");
	return { verdict, score, missing, reasons, candidateFit, checks };
}

const rank = (level: CefrLevel) => CEFR_LEVELS.indexOf(level);

/** Applies the language assessment: candidate fit is how close the level is to the requirement. */
export function applyLanguage(
	decided: Decided,
	required: { name: string; level: CefrLevel },
	estimate: { level: CefrLevel | "UNKNOWN"; source: "transcript" | "recruiter" | "notes" },
	recruiterLevel?: CefrLevel,
): Decided {
	const reasons = [...decided.reasons];
	let verdict = decided.verdict;
	const meetsLevel = estimate.level !== "UNKNOWN" && rank(estimate.level) >= rank(required.level);
	const candidateFit =
		estimate.level === "UNKNOWN"
			? 0
			: meetsLevel
				? Math.min(100, 85 + 5 * (rank(estimate.level) - rank(required.level)))
				: Math.round((70 * (rank(estimate.level) + 1)) / (rank(required.level) + 1));
	if (estimate.level === "UNKNOWN") {
		reasons.push(`No ${required.name} level could be established; send a transcript or the assessed level.`);
		if (verdict === "ACCEPT") verdict = "ESCALATE";
	} else {
		reasons.unshift(
			`${required.name}: ${estimate.level} (${estimate.source}), ${meetsLevel ? "meets" : "below"} the required ${required.level}.`,
		);
	}
	if (
		recruiterLevel &&
		estimate.source === "transcript" &&
		estimate.level !== "UNKNOWN" &&
		Math.abs(rank(recruiterLevel) - rank(estimate.level)) >= CALL_THRESHOLDS.levelDisagreement
	) {
		reasons.push(`The recruiter assessed ${recruiterLevel}, the transcript suggests ${estimate.level}.`);
		if (verdict === "ACCEPT") verdict = "ESCALATE";
	}
	return {
		...decided,
		verdict,
		reasons,
		candidateFit,
		language: {
			required: `${required.name} ${required.level}`,
			cefrLevel: estimate.level,
			meetsLevel,
			source: estimate.source,
		},
	};
}

const SPEAKER = /^\s*([\p{L}][\p{L} .'-]{0,40}?)\s*:/u;
const fold = (s: string) =>
	s
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/ł/g, "l")
		.toLowerCase();

/**
 * Recall transcript checks: at least two speakers, a minimum call length, the candidate's name
 * present (as a speaker or in the text), and coverage of the script. Duration comes from the
 * recording metadata, or is estimated at 150 spoken words per minute.
 */
export function transcriptIntegrity(
	d: Pick<CallDeliverable, "script" | "transcript" | "recording">,
	checks: QuestionCheck[],
): NonNullable<CallReview["integrity"]> | undefined {
	const transcript = d.transcript?.trim();
	if (!transcript) return undefined;
	const labels = new Set(
		transcript
			.split(/\n+/)
			.map((l) => l.match(SPEAKER)?.[1]?.trim())
			.filter((x): x is string => Boolean(x)),
	);
	const speakerNames = d.recording?.speakers.length ? d.recording.speakers : [...labels];
	const words = transcript.split(/\s+/).length;
	const durationSeconds = d.recording ? d.recording.durationSeconds : Math.round((words / 150) * 60);
	const name = fold(d.script.candidate.name);
	const first = name.split(/\s+/)[0] ?? name;
	const candidateNamed =
		speakerNames.some((s) => fold(s).includes(first)) || fold(transcript).includes(first);
	const coverage = checks.length ? checks.filter((c) => !c.missing).length / checks.length : 0;
	const failed: string[] = [];
	if (speakerNames.length < 2) failed.push(`only ${speakerNames.length} speaker in the transcript`);
	if (durationSeconds < CALL_THRESHOLDS.minCallSeconds[d.script.kind])
		failed.push(
			`call too short (${Math.round(durationSeconds / 60)} min${d.recording ? "" : ", estimated"}; needs ${CALL_THRESHOLDS.minCallSeconds[d.script.kind] / 60})`,
		);
	if (!candidateNamed) failed.push(`${d.script.candidate.name} isn't named in the transcript`);
	if (coverage < CALL_THRESHOLDS.minCoverage)
		failed.push(`only ${Math.round(coverage * 100)}% of the script is covered`);
	return {
		speakers: speakerNames.length,
		durationSeconds,
		durationSource: d.recording ? "recording" : "estimated",
		candidateNamed,
		coverage: Math.round(coverage * 100) / 100,
		failed,
	};
}

/** Folds integrity failures into the decision: −10 each, 2+ reject, 1 blocks auto-accept. */
export function applyIntegrity(
	decided: Decided,
	integrity: NonNullable<CallReview["integrity"]> | undefined,
): Decided {
	if (!integrity?.failed.length) return integrity ? { ...decided, integrity } : decided;
	const score = Math.max(0, decided.score - CALL_THRESHOLDS.integrityPenalty * integrity.failed.length);
	const verdict =
		integrity.failed.length >= 2 ? "REJECT" : decided.verdict === "ACCEPT" ? "ESCALATE" : decided.verdict;
	return {
		...decided,
		score,
		verdict,
		integrity,
		reasons: [...decided.reasons, `Transcript check: ${integrity.failed.join("; ")}.`],
	};
}

/**
 * Answers vs. recommendation, deterministically: ADVANCE with a candidate fit under 40, or PASS
 * with a fit of 75+, contradicts the notes and is rejected. A missing recommendation blocks accept.
 */
export function applyRecommendationCheck(
	decided: Decided,
	recommendation: CallDeliverable["recommendation"],
): Decided {
	if (decided.language) return decided; // language checks judge the level, not a hire recommendation
	if (!recommendation) {
		return decided.verdict === "ACCEPT"
			? {
					...decided,
					verdict: "ESCALATE",
					reasons: [...decided.reasons, "No recommendation from the recruiter."],
				}
			: decided;
	}
	const contradicts =
		(recommendation === "ADVANCE" && decided.candidateFit < 40 && decided.checks.some((c) => !c.missing)) ||
		(recommendation === "PASS" && decided.candidateFit >= 75);
	if (!contradicts) return decided;
	return {
		...decided,
		verdict: "REJECT",
		reasons: [
			...decided.reasons,
			`The recommendation (${recommendation}) contradicts the answers (candidate fit ${decided.candidateFit}/100).`,
		],
	};
}

/** No-show from recording metadata: the candidate isn't a speaker, or the call was very short. */
export function isNoShow(d: Pick<CallDeliverable, "recording" | "script">): string | null {
	if (!d.recording) return null;
	if (d.script.kind === "reference") {
		// The referee speaks, not the candidate: any second speaker besides the recruiter will do.
		if (d.recording.speakers.length < 2) return `${d.recording.speakers.length} speaker(s), no referee`;
	} else {
		const first = fold(d.script.candidate.name).split(/\s+/)[0] ?? "";
		const present = d.recording.speakers.some((s) => fold(s).includes(first));
		if (!present) return `${d.recording.speakers.length} speaker(s), none is the candidate`;
	}
	if (d.recording.durationSeconds < POLICY.noShowMaxSeconds)
		return `${Math.round(d.recording.durationSeconds / 60)} min call`;
	return null;
}

const KIND_LABEL = {
	screening: "Screening call",
	reference: "Reference check",
	language: "Language check",
} as const;

/** The first clause of an answer, at most ~12 words: "6 years of Rust in production". */
export function answerClause(answer: string, maxWords = 12): string {
	const first = answer.trim().split(/(?<=[.!?])\s+/)[0] ?? "";
	let cut = (first.split(/;|\s\(|\s[—–-]\s/)[0] ?? first).trim();
	// "6 years of Rust in production: 3 on payments…" → cut at the colon, but keep "Lending pool: she wrote it…".
	const colon = cut.indexOf(":");
	if (colon > 0 && cut.slice(0, colon).split(/\s+/).length >= 5) cut = cut.slice(0, colon);
	cut = cut.replace(/[.,]+$/, "").trim();
	const words = cut.split(/\s+/).filter(Boolean);
	return words.length > maxWords ? `${words.slice(0, maxWords).join(" ")}…` : cut;
}

/** Answers worth leading with: per kind, the questions that carry the decision. */
const SUMMARY_IDS: Record<CallDeliverable["script"]["kind"], string[]> = {
	screening: ["q-logistics"],
	reference: ["ref-strength", "ref-rehire"],
	language: [],
};

/**
 * One plain sentence for the company (the drawer shows every question and answer, and the scores
 * live in their own fields): the strongest facts, no recommendation tokens, no numbers of ours.
 */
export function templateSummary(d: CallDeliverable, answers: Map<string, string>, review: Decided) {
	if (review.verdict === "REJECT") {
		const total = review.checks.length;
		const unusable = review.checks.filter((c) => c.missing || c.generic).length;
		const why =
			unusable > 0
				? `${unusable} of ${total} answers weren't usable`
				: (review.reasons[0] ?? "the answers weren't usable").replace(/\.$/, "");
		return `Sent back to the recruiter: ${why}.`;
	}
	if (review.language) {
		const [lang, required] = [
			review.language.required.split(" ")[0],
			review.language.required.split(" ").at(-1),
		];
		return `${lang} ${review.language.cefrLevel}, ${review.language.meetsLevel ? "meets" : "below"} the required ${required}.`;
	}
	const usable = review.checks.filter((c) => !c.missing && !c.generic && answers.get(c.questionId));
	const byFit = [...usable].sort((a, b) => b.fit - a.fit);
	const criterionIds = new Set(d.script.questions.filter((q) => q.criterionId).map((q) => q.id));
	const pinned = SUMMARY_IDS[d.script.kind].filter((id) => usable.some((c) => c.questionId === id));
	const lead =
		d.script.kind === "screening"
			? byFit
					.filter((c) => criterionIds.has(c.questionId))
					.slice(0, 2)
					.map((c) => c.questionId)
			: [];
	const ids = [...new Set([...lead, ...pinned, ...byFit.map((c) => c.questionId)])].slice(
		0,
		d.script.kind === "reference" ? 2 : 3,
	);
	const clauseFor = (id: string) => {
		const a = answers.get(id) ?? "";
		if (id === "ref-rehire")
			return /^\s*(yes|definitely|absolutely)\b/i.test(a) ? "the referee would hire again" : answerClause(a);
		return answerClause(a);
	};
	// Lowercase a part's first letter unless it starts a name or an acronym ("Rust", "SDK").
	const soften = (part: string, i: number) =>
		i === 0 || /^[A-Z][A-Z0-9]|^[A-Z]\w*\s[A-Z]/.test(part) || /^(I|Rust|English|Anchor|Solana)\b/.test(part)
			? part
			: part.charAt(0).toLowerCase() + part.slice(1);
	const parts = ids.map(clauseFor).filter(Boolean).map(soften);
	if (!parts.length) return "The call notes need a closer look; see the answers.";
	const sentence = parts.join("; ");
	const capped = `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`;
	return /[.…]$/.test(capped) ? capped : `${capped}.`;
}

const RECOMMENDATION_WORDS = {
	ADVANCE: "recommends moving forward",
	MAYBE: "is unsure",
	PASS: "recommends not moving forward",
} as const;

const SummaryOutput = z.object({ summary: z.string() });

const STOP = new Set(
	"the and for with from that this have what your you about how did does when which were was are".split(" "),
);
const tokensOf = (s: string) =>
	new Set(
		s
			.toLowerCase()
			.split(/[^a-z0-9ąćęłńóśźż]+/)
			.filter((t) => t.length > 3 && !STOP.has(t)),
	);

/** Offline transcript mode: the segment sharing the most words with the question and its rubric. */
function offlineExtract(q: ScriptQuestion, segments: string[]): string {
	const wanted = tokensOf(`${q.question} ${q.whatGoodLooksLike}`);
	let best = "";
	let bestHits = 1;
	for (const seg of segments) {
		const hits = [...tokensOf(seg)].filter((t) => wanted.has(t)).length;
		if (hits > bestHits) {
			best = seg;
			bestHits = hits;
		}
	}
	return best;
}

/**
 * Reviews any call deliverable. Notes mode when `answers` has content, transcript mode when only
 * a transcript is given (Recall). Language scripts also get a CEFR estimate.
 */
export async function reviewCall(input: CallDeliverableInput): Promise<CallReview> {
	const raw = CallDeliverable.parse(input);
	// Flag injection attempts on the raw text, then score only what's left after removing them.
	const flags = detectInjection(raw.transcript, ...raw.answers.map((a) => a.answer));
	const d: CallDeliverable = flags.length
		? {
				...raw,
				answers: raw.answers.map((a) => ({ ...a, answer: stripInjection(a.answer) })),
				transcript: raw.transcript
					?.split("\n")
					.map((line) => {
						const speaker = line.match(SPEAKER)?.[0] ?? "";
						const kept = stripInjection(line.slice(speaker.length));
						return kept ? `${speaker}${kept}` : "";
					})
					.filter(Boolean)
					.join("\n"),
			}
		: raw;
	const hasNotes = d.answers.some((a) => a.answer.trim());
	const mode: Mode = !hasNotes && d.transcript?.trim() ? "transcript" : "notes";
	const segments = mode === "transcript" ? transcriptSegments(d.transcript ?? "") : [];
	const segmentIds = segments.map((_, i) => `t${i + 1}`);
	const answers = new Map(d.answers.map((a) => [a.questionId, a.answer ?? ""]));
	let probs: Map<string, Probs> | null = null;
	let consistent = 1;
	let cefr: CefrLevel | null = null;
	let engine: CallReview["engine"] = "offline";

	if (jevKey() && process.env.REVIEW_ENGINE !== "offline") {
		try {
			const state =
				mode === "notes"
					? {
							call: d.script.kind,
							candidate: d.script.candidate,
							questions: Object.fromEntries(
								d.script.questions.map((q) => [
									q.id,
									{ question: q.question, answer: answers.get(q.id) ?? "" },
								]),
							),
							...(d.recommendation ? { recommendation: d.recommendation } : {}),
							...(d.transcript ? { transcript: d.transcript.slice(0, 20_000) } : {}),
						}
					: {
							call: d.script.kind,
							candidate: d.script.candidate,
							transcript: Object.fromEntries(segments.map((seg, i) => [segmentIds[i], seg])),
							...(d.recommendation ? { recommendation: d.recommendation } : {}),
						};
			const result = await askJev(state, jevQuestions(d, mode, segmentIds), { timeoutMs: 15_000 });
			probs = new Map(
				d.script.questions.map((q) => [
					q.id,
					{
						addressed: noulOf(result.answers[`${q.id}__addressed`]) ?? 0,
						specific: noulOf(result.answers[`${q.id}__specific`]) ?? 0,
						fit: noulOf(result.answers[`${q.id}__fit`]) ?? 0,
						contradicts: noulOf(result.answers[`${q.id}__contradicts`]) ?? 0,
					},
				]),
			);
			if (mode === "transcript") {
				for (const q of d.script.questions) {
					const ev = result.answers[`${q.id}__ev`];
					if (ev?.type !== "choice" || ev.choice === "none") continue;
					// A confident pick, or Jev says it was answered and the answer spans neighbouring segments.
					const answeredP = noulOf(result.answers[`${q.id}__addressed`]) ?? 0;
					if ((ev.probabilities[ev.choice] ?? 0) < CALL_THRESHOLDS.evidence && answeredP < 0.5) continue;
					const seg = segments[segmentIds.indexOf(ev.choice)];
					if (seg) answers.set(q.id, seg);
				}
			}
			consistent = noulOf(result.answers.recommendation_consistent) ?? 1;
			const score = result.answers.cefr;
			if (score?.type === "score")
				cefr = CEFR_LEVELS[Math.max(0, Math.min(5, Math.round(score.score)))] ?? null;
			engine = "jev";
		} catch (error) {
			console.warn(
				"[agent] Jev call review failed, using heuristics:",
				error instanceof Error ? error.message : error,
			);
		}
	}

	if (mode === "transcript" && !probs) {
		for (const q of d.script.questions) {
			const seg = offlineExtract(q, segments);
			if (seg) answers.set(q.id, seg);
		}
	}

	const checks = d.script.questions.map((q) => {
		const answer = answers.get(q.id) ?? "";
		return checkFrom(q, answer, probs?.get(q.id) ?? offlineProbs(q, answer), mode);
	});
	let decided = decideCall(d, checks, consistent, d.script.questions);
	if (d.script.kind === "language" && d.script.language) {
		const estimate =
			d.transcript && cefr
				? { level: cefr, source: "transcript" as const }
				: d.assessedLevel
					? { level: d.assessedLevel, source: "recruiter" as const }
					: { level: cefr ?? ("UNKNOWN" as const), source: "notes" as const };
		decided = applyLanguage(decided, d.script.language, estimate, d.assessedLevel);
	}
	decided = applyIntegrity(decided, transcriptIntegrity(d, checks));
	decided = applyRecommendationCheck(decided, d.recommendation);
	const noShow = isNoShow(d);
	if (noShow) {
		decided = {
			...decided,
			verdict: "REJECT",
			reasons: [`${d.script.candidate.name} didn't show up (recording: ${noShow}).`, ...decided.reasons],
		};
	}
	const confidence: CallReview["confidence"] =
		d.recording || (decided.integrity && !decided.integrity.failed.length) ? "recorded" : "self-reported";
	if (flags.length) {
		decided = {
			...decided,
			reasons: [
				...decided.reasons,
				`Contains text aimed at the agent (${flags.join(", ")}); a person should check it.`,
			],
		};
	}
	// Payout wording only on the final verdict: a rejected or escalated call is not being paid.
	if (confidence === "self-reported" && decided.verdict === "ACCEPT" && !flags.length)
		decided = {
			...decided,
			reasons: [
				...decided.reasons,
				"No recording: paid with a holdback until the candidate confirms the call.",
			],
		};
	const extractedAnswers =
		mode === "transcript"
			? d.script.questions.map((q) => ({ questionId: q.id, answer: answers.get(q.id) ?? "" }))
			: undefined;
	const template = templateSummary(d, answers, decided);

	let summaryForCompany = template;
	if (decided.verdict !== "REJECT" && resolveProviderName() !== "offline") {
		({ summary: summaryForCompany } = await complete({
			system: prompt("system"),
			prompt: prompt("call-summary", {
				kind: KIND_LABEL[d.script.kind].toLowerCase(),
				name: d.script.candidate.name,
				recommendation: d.recommendation ? RECOMMENDATION_WORDS[d.recommendation] : "gave no recommendation",
				qa: [
					...(decided.language ? [`Assessed level: ${decided.reasons[0]}`] : []),
					...d.script.questions.map(
						(q) => `Q: ${q.question}\nA: ${untrusted("recruiter_notes", answers.get(q.id) || "(no answer)")}`,
					),
				].join("\n\n"),
			}),
			schema: SummaryOutput,
			schemaName: "call_summary",
			timeoutMs: SUMMARY_BUDGET_MS,
			fast: true,
			offline: () => ({ summary: template }),
		}));
	}
	return {
		...decided,
		summaryForCompany,
		engine,
		flags,
		confidence,
		noShow: Boolean(noShow),
		...(extractedAnswers ? { extractedAnswers } : {}),
	};
}

export const reviewScreening = (deliverable: CallDeliverableInput) => reviewCall(deliverable);
export const reviewReference = (deliverable: CallDeliverableInput) => reviewCall(deliverable);
/** Transcript-only review (e.g. a Recall recording of the call): answers are extracted by Jev. */
export const reviewTranscript = (input: {
	script: CallDeliverable["script"];
	transcript: string;
	recommendation?: CallDeliverable["recommendation"];
}) => reviewCall({ ...input, answers: [] });

export type LanguageReview = CallReview & { cefrLevel: CefrLevel | "UNKNOWN"; meetsLevel: boolean };
/** Language check: the CallReview plus the CEFR level flattened for convenience. */
export async function reviewLanguage(input: CallDeliverableInput): Promise<LanguageReview> {
	if (input.script.kind !== "language") throw new Error("reviewLanguage needs a language script");
	const review = await reviewCall(input);
	return {
		...review,
		cefrLevel: review.language?.cefrLevel ?? "UNKNOWN",
		meetsLevel: review.language?.meetsLevel ?? false,
	};
}
