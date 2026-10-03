import { readFileSync } from "node:fs";
import { toBaseUnits } from "@scout/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { planGigs } from "./gigs/plan.ts";
import { offlineDraftRole } from "./offline.ts";

const jd = (name: string) => readFileSync(new URL(`./fixtures/jd-real/${name}`, import.meta.url), "utf-8");
const labels = (cs: { label: string }[]) => cs.map((c) => c.label).join(" | ");

beforeAll(() => {
	process.env.LLM_PROVIDER = "offline";
});

describe("drafting from a pasted job description (offline)", () => {
	it("Customer Success Manager: title, company, must-haves and Polish come from the text", async () => {
		const d = offlineDraftRole(jd("customer-success-warsaw.txt"));
		expect(d.title).toBe("Customer Success Manager");
		expect(d.company).toBe("Insider One");
		expect(d.criteria.seniority).toBe("MID"); // "international" is not "intern"
		expect(labels(d.criteria.mustHave)).toMatch(/Customer Success/);
		expect(labels(d.criteria.mustHave)).not.toMatch(/business reviews|A\/B|go-to/i); // duties stay out
		expect(labels([...d.criteria.mustHave, ...d.criteria.niceToHave])).toMatch(/communication/i); // soft bullets kept
		expect(d.criteria.languages).toEqual(["Polish (C1)", "English"]);
		const plan = await planGigs({ criteria: d.criteria, title: d.title, budget: toBaseUnits(750) });
		const text = plan.gigs.map((g) => `${g.title} ${g.brief}`).join(" ") + plan.rationale;
		expect(text).not.toMatch(/rust|solana|engineer/i);
		expect(text).toMatch(/Customer Success/);
		expect(plan.gigs.find((g) => g.variant === "language")?.title).toMatch(/Polish/);
	});

	it("Solutions Engineer: location stays out of the title; every requirement bullet is kept", () => {
		const d = offlineDraftRole(jd("solutions-engineer-remote.txt"));
		expect(d.title).toBe("Senior Solutions Engineer");
		expect(d.company).toBe("QuickNode");
		expect(d.criteria.seniority).toBe("SENIOR");
		expect(d.criteria.location.mode).toBe("REMOTE");
		const all = labels([...d.criteria.mustHave, ...d.criteria.niceToHave]);
		for (const want of [
			/Solutions Engineer/,
			/JavaScript\/TypeScript or Python/,
			/APIs/,
			/communication and technical leadership/,
			/time zones/,
		])
			expect(all).toMatch(want);
		expect(d.criteria.languages).toEqual(["English"]);
	});

	it("Senior Go engineer: Go must-haves, German as a plus isn't required, no lead from the duties", () => {
		const d = offlineDraftRole(jd("senior-go-engineer.txt"));
		expect(d.title).toMatch(/^Senior Go Engineer/);
		expect(d.company).toBe("Northwind Pay");
		expect(d.criteria.seniority).toBe("SENIOR");
		expect(labels(d.criteria.mustHave)).toMatch(/Go/);
		expect(labels(d.criteria.mustHave)).not.toMatch(/design reviews|mentor/i);
		expect(labels(d.criteria.niceToHave)).toMatch(/Payments or banking/);
		expect(d.criteria.languages).toEqual(["English (C1)"]);
	});
});
