/**
 * The role draft as a stream, so the company can watch its agent read the job description: the model's partial
 * output arrives field by field (AI SDK `streamText` + `Output.object`). Without a model, or if it fails, the
 * deterministic offline draft is streamed field by field at a reading pace instead, so the experience is the same.
 */
import { Criteria } from "@scout/shared";
import { jsonSchema, Output, streamText } from "ai";
import { z } from "zod";
import { normalizeCriteria } from "./criteria.ts";
import { getModel } from "./llm/models.ts";
import { strictSchema } from "./llm/schema.ts";
import { offlineDraftRole } from "./offline.ts";
import { prompt } from "./prompts.ts";
import { untrusted } from "./untrusted.ts";

/** Same fields as draftRole's: the posting's own company comes back too (null when it doesn't name one). */
const DraftOutput = z.object({
	title: z.string(),
	company: z.string().nullable(),
	summary: z.string(),
	criteria: Criteria,
});
export type RoleDraft = z.infer<typeof DraftOutput>;

/** Partial draft while the agent is still reading: any field may be missing or cut mid-word. */
export type PartialRoleDraft = {
	title?: string;
	summary?: string;
	criteria?: Partial<Omit<Criteria, "location" | "salaryRange">> & {
		location?: Partial<Criteria["location"]>;
		salaryRange?: Partial<NonNullable<Criteria["salaryRange"]>> | null;
	};
};

export type DraftStreamEvent =
	| { type: "status"; text: string }
	| { type: "partial"; draft: PartialRoleDraft }
	| { type: "draft"; draft: RoleDraft; source: "model" | "offline" };

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve) => {
		if (signal?.aborted) return resolve();
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				resolve();
			},
			{ once: true },
		);
	});

/** What the agent says it is doing, from how far the partial draft got. */
export function statusFor(draft: PartialRoleDraft): string {
	const c = draft.criteria;
	if (!draft.title) return "Reading the job description…";
	if (!c) return "Reading the role…";
	if (c.dealBreakers?.length) return "Looking for deal-breakers…";
	if (c.languages?.length) return "Checking languages…";
	if (c.salaryRange !== undefined) return "Checking the salary range…";
	if (c.location) return "Checking location…";
	if (c.niceToHave?.length) return "Noting nice-to-haves…";
	if (c.mustHave?.length) return "Reading requirements…";
	return "Reading the role…";
}

/**
 * The offline draft, revealed in schema order with a reading pace (~150–250 ms between fields).
 * Same events as the model stream, so the client cannot tell the difference except by speed.
 */
async function* paced(draft: RoleDraft, signal?: AbortSignal): AsyncGenerator<DraftStreamEvent> {
	const c = draft.criteria;
	const steps: PartialRoleDraft[] = [];
	const at = (criteria: PartialRoleDraft["criteria"], summary = true): PartialRoleDraft => ({
		title: draft.title,
		...(summary ? { summary: draft.summary } : {}),
		criteria,
	});
	steps.push({ title: draft.title });
	steps.push(at(undefined));
	for (let i = 1; i <= c.mustHave.length; i++) steps.push(at({ mustHave: c.mustHave.slice(0, i) }));
	for (let i = 1; i <= c.niceToHave.length; i++)
		steps.push(at({ mustHave: c.mustHave, niceToHave: c.niceToHave.slice(0, i) }));
	const base = { mustHave: c.mustHave, niceToHave: c.niceToHave, seniority: c.seniority };
	steps.push(at({ ...base, location: c.location }));
	steps.push(at({ ...base, location: c.location, salaryRange: c.salaryRange }));
	steps.push(at({ ...base, location: c.location, salaryRange: c.salaryRange, languages: c.languages }));
	for (let i = 1; i <= c.dealBreakers.length; i++)
		steps.push(at({ ...c, dealBreakers: c.dealBreakers.slice(0, i) }));
	for (const step of steps) {
		if (signal?.aborted) return;
		yield { type: "status", text: statusFor(step) };
		yield { type: "partial", draft: step };
		await sleep(150 + Math.round(Math.random() * 100), signal);
	}
	yield { type: "draft", draft, source: "offline" };
}

/**
 * Stream the agent's draft of a role. Emits a status first (so a client can tell the stream is alive), then
 * partial drafts, then exactly one final `draft` event with normalized criteria.
 */
export async function* streamDraftRole(
	jobDescription: string,
	options: { signal?: AbortSignal; timeoutMs?: number } = {},
): AsyncGenerator<DraftStreamEvent> {
	yield { type: "status", text: "Reading the job description…" };
	const offline = () => {
		const d = offlineDraftRole(jobDescription);
		return { ...d, criteria: normalizeCriteria(d.criteria) };
	};
	const model = getModel("main");
	if (!model) {
		yield* paced(offline(), options.signal);
		return;
	}

	const abortSignal = AbortSignal.any(
		[options.signal, AbortSignal.timeout(options.timeoutMs ?? 45_000)].filter(Boolean) as AbortSignal[],
	);
	const schema = jsonSchema(strictSchema(z.toJSONSchema(DraftOutput)) as Parameters<typeof jsonSchema>[0]);
	try {
		const result = streamText({
			model,
			system: prompt("system"),
			prompt: prompt("draft-role", { jobDescription: untrusted("job_description", jobDescription) }),
			output: Output.object({ schema, name: "role_draft" }),
			abortSignal,
			maxRetries: 1,
		});
		let lastStatus = "";
		let lastSent = 0;
		for await (const partial of result.partialOutputStream) {
			const draft = partial as PartialRoleDraft;
			const status = statusFor(draft);
			if (status !== lastStatus) {
				lastStatus = status;
				yield { type: "status", text: status };
			}
			// Coalesce: a partial at most every ~60 ms is plenty for the UI.
			const now = Date.now();
			if (now - lastSent < 60) continue;
			lastSent = now;
			yield { type: "partial", draft };
		}
		const parsed = DraftOutput.safeParse(await result.output);
		if (parsed.success) {
			yield {
				type: "draft",
				draft: { ...parsed.data, criteria: normalizeCriteria(parsed.data.criteria) },
				source: "model",
			};
			return;
		}
		console.warn("[agent] streamed draft did not match the schema, using the offline draft");
	} catch (error) {
		if (options.signal?.aborted) return;
		console.warn(
			"[agent] streamed draft failed, using the offline draft:",
			error instanceof Error ? error.message.slice(0, 300) : error,
		);
	}
	yield* paced(offline(), options.signal);
}
