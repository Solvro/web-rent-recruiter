import type { Criteria, Criterion } from "@scout/shared";

const MAX_SLUG = 32;

/** "5+ years of production Rust" -> "5plus-years-of-production-rust", cut at a word boundary. */
export function slugify(label: string): string {
	const words = label
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/\+/g, "plus")
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
	let slug = "";
	for (const word of words) {
		const next = slug ? `${slug}-${word}` : word;
		if (next.length > MAX_SLUG) break;
		slug = next;
	}
	return slug || words[0]?.slice(0, MAX_SLUG) || "criterion";
}

/** Stable, unique slug ids across all criterion lists; weights clamped to 1-5. */
export function normalizeCriteria(criteria: Criteria): Criteria {
	const used = new Set<string>();
	const fix = (c: Criterion): Criterion => {
		const base = slugify(c.id || c.label);
		let id = base;
		for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
		used.add(id);
		return { id, label: c.label.trim(), weight: Math.min(5, Math.max(1, Math.round(c.weight))) };
	};
	return {
		...criteria,
		mustHave: criteria.mustHave.map(fix),
		niceToHave: criteria.niceToHave.map(fix),
		dealBreakers: criteria.dealBreakers.map(fix),
	};
}
