/**
 * Plain words for anything the agent or the backend writes into the company's view: no verdict codes, gig-type
 * enums, question ids or chain words. A last line of defence; the backend writes plain text for new rows.
 */
const VERDICT: Record<string, string> = {
	ADVANCE: "move forward",
	MAYBE: "maybe",
	PASS: "not a fit",
	ACCEPT: "accepted",
	REJECT: "not accepted",
	ESCALATE: "asked you",
};
const TYPE: Record<string, string> = {
	SOURCING: "sourcing",
	SCREENING_CALL: "screening call",
	LANGUAGE_CHECK: "language check",
	REFERENCE_CHECK: "reference check",
};

export function plain(text: string): string {
	let t = text
		// Markdown emphasis from the agent: the words stay, the asterisks go.
		.replace(/\*\*(.+?)\*\*/g, "$1")
		.replace(/(^|\s)\*(\S.*?\S)\*(?=\s|$|[.,;:])/g, "$1$2")
		// " · 51" after a name is a fit score: say so.
		.replace(/('s profile|profile) · (\d{1,3})\b/g, "$1 · fit $2")
		.replace(/\bcheck out\b/g, "are solid")
		// Backend log shorthand: "delivered X → scored 90 → waiting for …" → "delivered X · fit 90 · waiting for …"
		.replace(/\s*→\s*scored (\d{1,3})\s*→\s*/g, " · fit $1 · ")
		.replace(/\s*→\s*/g, " · ")
		// A bare "(96)" after the work it scores repeats the detail line ("…, 96/100"): drop it.
		.replace(/\s\((\d{1,3})\)(?=[\s.,;]|$)/g, "")
		// "26/100 PASS", "ACCEPT 96/100" → "26/100", "96/100"
		.replace(/\b(ADVANCE|MAYBE|PASS|ACCEPT|REJECT|ESCALATE)\s+(\d{1,3}\/100)/g, "$2")
		.replace(/(\d{1,3}\/100)\s*\(?(ADVANCE|MAYBE|PASS|ACCEPT|REJECT|ESCALATE)\)?/g, "$1")
		.replace(/\(\s*(ADVANCE|MAYBE|PASS)\s*\)/g, (_, v: string) => `(${VERDICT[v]})`)
		.replace(/\b(ADVANCE|MAYBE|PASS|ACCEPT|REJECT|ESCALATE)\b/g, (v) => VERDICT[v] ?? v)
		.replace(/\b(SOURCING|SCREENING_CALL|LANGUAGE_CHECK|REFERENCE_CHECK)\b/g, (v) => TYPE[v] ?? v)
		// raw question ids: "ref-strength, ref-growth" → "2 answers"
		.replace(
			/No usable answer to ((?:q|ref|lang)-[a-z0-9-]+(?:\s*,\s*(?:q|ref|lang)-[a-z0-9-]+)*)/g,
			(_, m: string) => {
				const n = m.split(",").length;
				return n === 1 ? "One answer wasn't usable" : `${n} answers weren't usable`;
			},
		)
		.replace(
			/\b(?:(?:q|ref|lang)-[a-z0-9-]+)(?:\s*,\s*(?:q|ref|lang)-[a-z0-9-]+)+/g,
			(m) => `${m.split(",").length} answers`,
		)
		.replace(/\b(?:q|ref|lang)-[a-z0-9-]+\b/g, "one answer")
		.replace(/\s*\((?:proof )?on-chain\)/gi, "")
		.replace(/\bon-chain\b/gi, "on record")
		.replace(/\bgig\(s\)/g, "tasks")
		.replace(/\bgigs\b/g, "tasks")
		.replace(/\bgig\b/g, "task")
		.replace(/\bbount(y|ies)\b/gi, (_, e: string) => (e === "y" ? "price" : "prices"))
		.replace(/\s{2,}/g, " ")
		.trim();
	t = t.charAt(0).toUpperCase() + t.slice(1);
	return t;
}

/** Plumbing the company never needs to see ("getStatus done", "listPendingDeliverables done"). */
export const isPlumbing = (text: string) => /^[a-z]+[A-Z]\w*( done| failed)?\.?$/.test(text.trim());
