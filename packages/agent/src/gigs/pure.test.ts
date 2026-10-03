import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Follows relative imports from pure.ts and fails on anything server-side. */
function importGraph(entry: URL, seen = new Set<string>()): Set<string> {
	if (seen.has(entry.href)) return seen;
	seen.add(entry.href);
	const src = readFileSync(entry, "utf-8");
	for (const m of src.matchAll(/(?:import|export)[^"']*from\s+["']([^"']+)["']/g)) {
		const spec = m[1] ?? "";
		if (spec.startsWith(".")) importGraph(new URL(spec, entry), seen);
		else seen.add(`pkg:${spec}`);
	}
	return seen;
}

describe("gigs/pure.ts", () => {
	it("imports nothing server-side (browser-safe for the app)", () => {
		const graph = [...importGraph(new URL("./pure.ts", import.meta.url))];
		const packages = graph.filter((g) => g.startsWith("pkg:"));
		expect(packages.every((p) => p === "pkg:@scout/shared" || p === "pkg:zod")).toBe(true);
		expect(graph.some((g) => /\/(llm|runner|prompts|jev|review)\b/.test(g))).toBe(false);
	});

	it("gives the app the same split as the agent", async () => {
		const { splitBudget } = await import("./pure.ts");
		expect(splitBudget(500, "SENIOR").sourcingBounty).toBe(20);
	});
});
