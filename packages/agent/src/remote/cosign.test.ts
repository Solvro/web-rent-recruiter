import {
	getClaimTaskInstruction,
	getCloseTaskInstruction,
	SCOUT_PROGRAM_ADDRESS,
} from "@scout/shared/program";
import {
	appendTransactionMessageInstructions,
	createNoopSigner,
	createTransactionMessage,
	generateKeyPairSigner,
	getBase64EncodedWireTransaction,
	type Instruction,
	type KeyPairSigner,
	partiallySignTransactionMessageWithSigners,
	pipe,
	setTransactionMessageFeePayerSigner,
	setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { type CosignPolicy, checkCosign } from "./cosign.ts";

let agent: KeyPairSigner;
let scout: KeyPairSigner;
let relayer: KeyPairSigner;
let roleVault: KeyPairSigner;
let otherRole: KeyPairSigner;
let policy: CosignPolicy;

beforeAll(async () => {
	[agent, scout, relayer, roleVault, otherRole] = await Promise.all(
		Array.from({ length: 5 }, () => generateKeyPairSigner()),
	);
	policy = {
		programId: SCOUT_PROGRAM_ADDRESS,
		roleVault: roleVault.address,
		agent: agent.address,
		relayer: relayer.address,
	};
});

async function wire(ixs: Instruction[], feePayer = createNoopSigner(relayer.address)) {
	const msg = pipe(
		createTransactionMessage({ version: 0 }),
		(m) => setTransactionMessageFeePayerSigner(feePayer, m),
		(m) =>
			setTransactionMessageLifetimeUsingBlockhash(
				{ blockhash: "11111111111111111111111111111111" as never, lastValidBlockHeight: 1n },
				m,
			),
		(m) => appendTransactionMessageInstructions(ixs, m),
	);
	return getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(msg));
}
const claim = (role = roleVault.address, gatekeeper = agent.address) =>
	getClaimTaskInstruction({
		payer: createNoopSigner(relayer.address),
		scout,
		gatekeeper: createNoopSigner(gatekeeper),
		scoutProfile: scout.address,
		roleVault: role,
		task: scout.address,
	});

describe("checkCosign (gatekeeper)", () => {
	it("co-signs a recruiter's claim on its own role", async () => {
		expect(checkCosign(await wire([claim()]), policy)).toBeNull();
	});

	it("refuses another role, another gatekeeper, or a different fee payer", async () => {
		expect(checkCosign(await wire([claim(otherRole.address)]), policy)).toMatch(/different role/);
		expect(checkCosign(await wire([claim(roleVault.address, otherRole.address)]), policy)).toMatch(
			/isn't a signer|gatekeeper/,
		);
		expect(checkCosign(await wire([claim()], scout), policy)).toMatch(/fee payer/);
	});

	it("refuses anything but claim/deliver, e.g. a close_task smuggled in with the agent as authority", async () => {
		const close = getCloseTaskInstruction({
			payer: createNoopSigner(relayer.address),
			authority: createNoopSigner(agent.address),
			roleVault: roleVault.address,
			task: scout.address,
		} as never);
		expect(checkCosign(await wire([claim(), close]), policy)).toMatch(
			/only claim_task and submit_deliverable/,
		);
	});

	it("refuses garbage", () => {
		expect(checkCosign("not-a-tx", policy)).toMatch(/not a valid/);
	});
});
