import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.ts", () => ({
	schema: { roles: { companyWallet: "companyWallet", id: "id" } },
	db: {
		select: () => ({ from: () => ({ where: async () => [{ company: "COMPANY" }] }) }),
	},
}));

const { visibleEvent } = await import("./event-visibility.ts");

describe("events visibility", () => {
	it("agent chat and timeline only reach the role's company", async () => {
		const chat = { type: "agent.message" as const, roleId: "r1", delta: "Karolina looks strong" };
		expect(await visibleEvent(chat, "COMPANY")).toEqual(chat);
		expect(await visibleEvent(chat, "RECRUITER")).toBeNull();
		expect(await visibleEvent(chat, null)).toBeNull();
		expect(
			await visibleEvent(
				{ type: "agent.activity", roleId: "r1", message: "Booked a screening for Karolina" },
				null,
			),
		).toBeNull();
	});

	it("others get ids and payouts without the status text", async () => {
		const e = { type: "role.updated" as const, roleId: "r1", message: "Your agent is screening Karolina" };
		expect(await visibleEvent(e, "RECRUITER")).toEqual({ type: "role.updated", roleId: "r1" });
		const paid = {
			type: "submission.accepted" as const,
			roleId: "r1",
			submissionId: "s1",
			scout: "S",
			payout: "3150000",
		};
		expect(await visibleEvent(paid, "S")).toEqual(paid);
	});
});
