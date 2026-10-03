/**
 * Turns a growing partial draft into a calm, paced reveal: one field at a time, in reading order of the finished
 * job post, never faster than a reader can follow and never ahead of what the agent has actually understood.
 */
import { useEffect, useMemo, useState } from "react";
import type { PartialDraft } from "./stream";

export type FieldKey = string; // "title" | "seniority" | "location" | "salary" | "summary" | "must:0" | … | "languages"

/** Keys of the job post in the order a reader sees them. */
export function documentOrder(p: PartialDraft): FieldKey[] {
	const c = p.criteria;
	return [
		"title",
		"seniority",
		"location",
		"salary",
		"summary",
		...(c?.mustHave ?? []).map((_, i) => `must:${i}`),
		...(c?.niceToHave ?? []).map((_, i) => `nice:${i}`),
		...(c?.dealBreakers ?? []).map((_, i) => `deal:${i}`),
		"languages",
	];
}

/**
 * A field is settled once the agent has moved past it in its output (the model writes fields in schema order:
 * title, summary, must-haves, nice-to-haves, seniority, location, salary, languages, deal-breakers), or the
 * stream is done. Until then it may still be changing mid-word.
 */
export function isSettled(key: FieldKey, p: PartialDraft, done: boolean): boolean {
	if (done) return true;
	const c = p.criteria;
	const has = {
		summary: p.summary !== undefined,
		criteria: c !== undefined,
		nice: (c?.niceToHave?.length ?? 0) > 0,
		seniority: c?.seniority !== undefined,
		location: c?.location !== undefined,
		salary: c?.salaryRange !== undefined,
		languages: (c?.languages?.length ?? 0) > 0,
		deal: (c?.dealBreakers?.length ?? 0) > 0,
	};
	const after = (...later: boolean[]) => later.some(Boolean);
	const [kind, index] = key.split(":");
	const i = Number(index);
	switch (kind) {
		case "title":
			return after(has.summary, has.criteria);
		case "summary":
			return after(has.criteria);
		case "must":
			return i + 1 < (c?.mustHave?.length ?? 0) || after(has.nice, has.seniority, has.location, has.salary);
		case "nice":
			return i + 1 < (c?.niceToHave?.length ?? 0) || after(has.seniority, has.location, has.salary);
		case "seniority":
			return has.seniority && after(has.location, has.salary, has.languages, has.deal);
		case "location":
			return has.location && after(has.salary, has.languages, has.deal);
		case "salary":
			return has.salary && after(has.languages, has.deal);
		case "languages":
			return has.languages && after(has.deal);
		case "deal":
			return i + 1 < (c?.dealBreakers?.length ?? 0);
		default:
			return false;
	}
}

/** Pause after revealing a field; list items flow faster than headline fields. */
const pauseFor = (key: FieldKey, reduced: boolean) => {
	const base = key.includes(":") ? 170 : 260;
	return reduced ? Math.round(base * 0.5) : base;
};

/**
 * Reveal fields one by one. `skip()` shows everything at once. `lastKey` is the most recently revealed field (used to
 * highlight where in the job description it came from).
 */
export function useReveal(partial: PartialDraft, done: boolean, reduced: boolean) {
	const [shown, setShown] = useState<Set<FieldKey>>(() => new Set());
	const [lastKey, setLastKey] = useState<FieldKey | null>(null);
	const [skipped, setSkipped] = useState(false);

	const order = useMemo(() => documentOrder(partial), [partial]);
	const settled = order.filter((k) => isSettled(k, partial, done) && present(k, partial));
	const complete = done && settled.every((k) => shown.has(k));
	// Once everything has been shown it stays shown, including lines the person adds while editing.
	const [finished, setFinished] = useState(false);
	useEffect(() => {
		if (complete) setFinished(true);
	}, [complete]);
	// Partials arrive faster than the reveal pace: only restart the timer when the set of revealable fields changes.
	const settledKey = settled.join("|");

	useEffect(() => {
		const settled = settledKey ? settledKey.split("|") : [];
		if (skipped) {
			setShown(new Set(settled));
			return;
		}
		const next = settled.find((k) => !shown.has(k));
		if (!next) return;
		const t = setTimeout(
			() => {
				setShown((s) => new Set(s).add(next));
				setLastKey(next);
			},
			shown.size === 0 ? 120 : pauseFor(lastKey ?? next, reduced),
		);
		return () => clearTimeout(t);
	}, [settledKey, shown, skipped, lastKey, reduced]);

	return {
		isShown: (k: FieldKey) => finished || shown.has(k),
		/** The agent is still working on the field, or has it and it's next in line (placeholder shimmer). */
		isPending: (k: FieldKey) => !finished && !shown.has(k) && (!done || settled.includes(k)),
		lastKey,
		/** The field the agent resolves next (its source sentence is highlighted while it waits). */
		nextKey: finished || skipped ? null : (settled.find((k) => !shown.has(k)) ?? null),
		complete: complete || finished,
		progress: settled.length ? shown.size / Math.max(order.length, 1) : 0,
		skip: () => setSkipped(true),
		skipped,
	};
}

/** Does the partial actually have a value for this field? (Salary may be legitimately null = "not stated".) */
function present(key: FieldKey, p: PartialDraft): boolean {
	const c = p.criteria;
	switch (key) {
		case "title":
			return !!p.title;
		case "summary":
			return !!p.summary;
		case "seniority":
			return !!c?.seniority;
		case "location":
			return !!c?.location?.mode;
		case "salary":
			return c?.salaryRange !== undefined;
		case "languages":
			return (c?.languages?.length ?? 0) > 0;
		default:
			return true;
	}
}
