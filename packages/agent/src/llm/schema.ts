/**
 * JSON Schema for strict structured output. Drops keywords some upstream models reject
 * (zod still enforces them after parsing), requires every property and forbids extras.
 */
const UNSUPPORTED = new Set([
	"$schema",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"pattern",
	"format",
]);

export function strictSchema(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(strictSchema);
	if (!node || typeof node !== "object") return node;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(node)) {
		if (!UNSUPPORTED.has(key)) out[key] = strictSchema(value);
	}
	if (out.type === "object" && out.properties) {
		out.additionalProperties = false;
		out.required = Object.keys(out.properties as object);
	}
	return out;
}
