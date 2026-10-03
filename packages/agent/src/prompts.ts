import { readFileSync } from "node:fs";

const cache = new Map<string, string>();

export type PromptName =
	| "system"
	| "draft-role"
	| "budget-rationale"
	| "review-submission"
	| "pipeline-summary"
	| "review-summary"
	| "gig-briefs"
	| "screening-script"
	| "reference-script"
	| "call-summary"
	| "shortlist";

/** Loads backend/src/agent/prompts/<name>.md and fills {{placeholders}}. */
export function prompt(name: PromptName, vars: Record<string, string | number> = {}): string {
	let template = cache.get(name);
	if (template === undefined) {
		template = readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), "utf-8").trim();
		cache.set(name, template);
	}
	return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
		if (!(key in vars)) throw new Error(`Prompt ${name} is missing {{${key}}}`);
		return String(vars[key]);
	});
}
