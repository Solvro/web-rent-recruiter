import { describe, expect, it } from "vitest";
import { checkRelayerPolicy } from "./tx.ts";

const RELAYER = "Re1ayer1111111111111111111111111111111111111";
const PROGRAM = "Scout11111111111111111111111111111111111111";
const USER = "User111111111111111111111111111111111111111";
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM = "11111111111111111111111111111111";
const COMPUTE = "ComputeBudget111111111111111111111111111111";
const ACC = "Acc11111111111111111111111111111111111111111";

const idl = {
	instructions: [
		{
			name: "submit_candidate",
			discriminator: [1, 2, 3, 4, 5, 6, 7, 8],
			accounts: [{ name: "payer" }, { name: "scout" }, { name: "submission" }],
			args: [],
		},
		{
			name: "top_up",
			discriminator: [9, 9, 9, 9, 9, 9, 9, 9],
			accounts: [{ name: "payer" }, { name: "company" }, { name: "company_token_account" }],
			args: [],
		},
		{
			name: "reject_submission",
			discriminator: [7, 7, 7, 7, 7, 7, 7, 7],
			accounts: [{ name: "payer", signer: true }, { name: "rent_payer" }, { name: "submission" }],
			args: [],
		},
	],
};
const opts = { relayer: RELAYER, programId: PROGRAM, idl, usdcMint: ACC };
// static accounts: 0 relayer (fee payer), 1 user, 2 acc, 3 program, 4 ATA, 5 system, 6 compute
const staticAccounts = [RELAYER, USER, ACC, PROGRAM, ATA, SYSTEM, COMPUTE];

describe("checkRelayerPolicy", () => {
	it("accepts the relayer as fee payer and as the IDL `payer` of a Scout instruction", () => {
		const msg = {
			staticAccounts,
			instructions: [
				{ programAddressIndex: 6, accountIndices: [], data: [2, 0, 0, 0, 0] },
				{ programAddressIndex: 3, accountIndices: [0, 1, 2], data: [1, 2, 3, 4, 5, 6, 7, 8, 42] },
			],
		};
		expect(checkRelayerPolicy(msg, opts)).toBeNull();
	});

	it("accepts the relayer funding an ATA creation", () => {
		const msg = {
			staticAccounts,
			instructions: [{ programAddressIndex: 4, accountIndices: [0, 2, 1, 2, 5] }],
		};
		expect(checkRelayerPolicy(msg, opts)).toBeNull();
	});

	it("rejects a different fee payer", () => {
		const msg = { staticAccounts: [USER, RELAYER, PROGRAM], instructions: [] };
		expect(checkRelayerPolicy(msg, opts)).toMatch(/fee payer/);
	});

	it("rejects System program instructions (relayer SOL transfer)", () => {
		const msg = {
			staticAccounts,
			instructions: [{ programAddressIndex: 5, accountIndices: [0, 1], data: [2] }],
		};
		expect(checkRelayerPolicy(msg, opts)).toMatch(/not allowed/);
	});

	it("rejects the relayer in a non-payer position of a Scout instruction", () => {
		const msg = {
			staticAccounts,
			instructions: [{ programAddressIndex: 3, accountIndices: [1, 0, 2], data: [9, 9, 9, 9, 9, 9, 9, 9] }],
		};
		expect(checkRelayerPolicy(msg, opts)).toMatch(/relayer used as "company"/);
	});

	it("accepts a user's USDC transfer_checked, but not with the relayer or another mint", () => {
		const t = { ...opts, tokenPrograms: [SYSTEM] };
		const ix = (accs: number[], data = [12, 1, 0, 0, 0, 0, 0, 0, 0, 6]) => ({
			staticAccounts,
			instructions: [{ programAddressIndex: 5, accountIndices: accs, data }],
		});
		expect(checkRelayerPolicy(ix([4, 2, 4, 1]), t)).toBeNull();
		expect(checkRelayerPolicy(ix([4, 2, 0, 1]), t)).toMatch(/relayer referenced/);
		expect(checkRelayerPolicy(ix([4, 1, 4, 1]), t)).toMatch(/unexpected mint/);
		expect(checkRelayerPolicy(ix([4, 2, 4, 1], [3]), t)).toMatch(/only USDC transfer_checked/);
	});

	it("accepts the relayer as the rent_payer refund target of reject_submission", () => {
		const msg = {
			staticAccounts,
			instructions: [{ programAddressIndex: 3, accountIndices: [1, 0, 2], data: [7, 7, 7, 7, 7, 7, 7, 7] }],
		};
		expect(checkRelayerPolicy(msg, opts)).toBeNull();
	});

	it("rejects unknown Scout instructions that reference the relayer", () => {
		const msg = {
			staticAccounts,
			instructions: [{ programAddressIndex: 3, accountIndices: [0], data: [0, 0, 0, 0, 0, 0, 0, 0] }],
		};
		expect(checkRelayerPolicy(msg, opts)).toMatch(/unknown Scout instruction/);
	});

	it("rejects the relayer as ATA owner (non-funding position)", () => {
		const msg = {
			staticAccounts,
			instructions: [{ programAddressIndex: 4, accountIndices: [1, 2, 0, 2, 5] }],
		};
		expect(checkRelayerPolicy(msg, opts)).toMatch(/only fund ATA/);
	});

	it("rejects address lookup tables", () => {
		const msg = { staticAccounts, instructions: [], addressTableLookups: [{}] };
		expect(checkRelayerPolicy(msg, opts)).toMatch(/lookup/);
	});

	it("rejects ATA creation for another mint", () => {
		const msg = {
			staticAccounts: [...staticAccounts, "Mint1111111111111111111111111111111111111111"],
			instructions: [{ programAddressIndex: 4, accountIndices: [0, 2, 1, 7, 5] }],
		};
		expect(checkRelayerPolicy(msg, opts)).toMatch(/unexpected mint/);
	});
});
