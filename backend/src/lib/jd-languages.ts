/**
 * Languages with a CEFR level written in the job description ("Fluent English (C1)") must reach the criteria:
 * the agent books a language check only from an explicit level (requiredLanguage). A model's draft can drop it.
 */
import type { Criteria } from "@scout/shared";

const LANGS =
	"English|German|Polish|French|Spanish|Italian|Dutch|Portuguese|Ukrainian|Czech|Slovak|Romanian|Swedish|Danish|Norwegian|Finnish|Hungarian|Lithuanian|Japanese|Chinese|Mandarin";
const IN_JD = new RegExp(`\\b(${LANGS})\\b[^\\n.;,]{0,12}?\\(?\\b([ABC][12])\\b\\)?`, "gi");

export function languagesFromJd(jd: string): string[] {
	const out = new Map<string, string>();
	for (const m of jd.matchAll(IN_JD)) {
		const name = (m[1] ?? "").charAt(0).toUpperCase() + (m[1] ?? "").slice(1).toLowerCase();
		const level = (m[2] ?? "").toUpperCase();
		if (name && level && !out.has(name)) out.set(name, `${name} (${level})`);
	}
	return [...out.values()];
}

/** Adds JD languages the draft missed (or lists without a level); keeps everything the draft had. */
export function withJdLanguages(jd: string, criteria: Criteria): Criteria {
	const languages = [...criteria.languages];
	for (const entry of languagesFromJd(jd)) {
		const name = entry.split(" ")[0] ?? entry;
		const i = languages.findIndex((l) => l.toLowerCase().includes(name.toLowerCase()));
		if (i === -1) languages.push(entry);
		else if (!/\b[ABC][12]\b/i.test(languages[i] ?? "")) languages[i] = entry;
	}
	return { ...criteria, languages };
}
