/**
 * The company's daily digest: every escalation with `delivery: "digest"` is batched into one
 * message instead of a notification each. Items needing a person now (flags, blocked calls)
 * are sent immediately by the backend and never wait for the digest.
 */
export interface DigestItem {
	candidateName?: string;
	question: string;
	/** e.g. "sourcing", "screening". */
	kind?: string;
	deliverableId?: string;
}

export function buildEscalationDigest(
	items: DigestItem[],
	context: { roleTitle: string; date?: string },
): { title: string; body: string; count: number } | null {
	if (!items.length) return null;
	const lines = items.map(
		(i, n) => `${n + 1}. ${i.candidateName ? `${i.candidateName}: ` : ""}${i.question}`,
	);
	return {
		title: `${items.length} decision${items.length === 1 ? "" : "s"} for ${context.roleTitle}${context.date ? ` · ${context.date}` : ""}`,
		body: [
			`Your agent handled everything else today. These need a yes or no from you:`,
			...lines,
			"Reply in the thread or use the buttons; anything you skip stays here tomorrow.",
		].join("\n"),
		count: items.length,
	};
}
