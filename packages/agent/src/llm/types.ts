import type { z } from "zod";

export interface CompleteOptions<S extends z.ZodType> {
	system: string;
	prompt: string;
	schema: S;
	schemaName: string;
	/** Deterministic answer used offline and as the last-resort fallback. */
	offline: () => z.infer<S>;
	/** Aborts the model call; the offline answer is returned instead. */
	timeoutMs?: number;
	/** Use the fast tier (OPENROUTER_FAST_MODEL) for latency-critical one-liners. */
	fast?: boolean;
	/**
	 * Still call the model when DEMO_FAST is on (e.g. drafting criteria from a pasted JD, which
	 * has no sensible template). Everything else returns its template instantly in DEMO_FAST.
	 */
	essential?: boolean;
	/** Incremented with the reported cost (USD) of every model call this completion makes. */
	meter?: { costUsd: number };
}
