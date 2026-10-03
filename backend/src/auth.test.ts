import { generateKeyPairSigner, signBytes } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rows: { tokenHash: string; wallet: string; expiresAt: Date }[] = [];
vi.mock("./db/index.ts", () => ({
	schema: { sessions: { tokenHash: "tokenHash", expiresAt: "expiresAt" } },
	db: {
		insert: () => ({ values: async (v: (typeof rows)[number]) => void rows.push(v) }),
		delete: () => ({ where: async () => {} }),
		select: () => ({ from: () => ({ where: async () => rows.slice(-1) }) }),
	},
}));

const { createNonce, verifyLogin } = await import("./auth.ts");

async function sign(signer: Awaited<ReturnType<typeof generateKeyPairSigner>>, message: string) {
	return Buffer.from(await signBytes(signer.keyPair.privateKey, new TextEncoder().encode(message))).toString(
		"base64",
	);
}

describe("Sign-In-With-Solana", () => {
	beforeEach(() => void rows.splice(0));

	it("issues a session for a valid signature, once", async () => {
		const me = await generateKeyPairSigner();
		const { message } = createNonce(me.address);
		const res = await verifyLogin({ wallet: me.address, message, signature: await sign(me, message) });
		expect(res.wallet).toBe(me.address);
		expect(res.token.length).toBeGreaterThan(30);
		expect(rows[0]?.tokenHash).not.toBe(res.token); // only the hash is stored
		await expect(
			verifyLogin({ wallet: me.address, message, signature: await sign(me, message) }),
		).rejects.toThrow(/unknown or altered/);
	});

	it("rejects a signature from another wallet", async () => {
		const me = await generateKeyPairSigner();
		const attacker = await generateKeyPairSigner();
		const { message } = createNonce(me.address);
		await expect(
			verifyLogin({ wallet: me.address, message, signature: await sign(attacker, message) }),
		).rejects.toThrow(/does not match/);
	});

	it("rejects an altered message or a nonce issued to someone else", async () => {
		const me = await generateKeyPairSigner();
		const other = await generateKeyPairSigner();
		const { message } = createNonce(other.address);
		const forged = message.replace(other.address, me.address);
		await expect(
			verifyLogin({ wallet: me.address, message: forged, signature: await sign(me, forged) }),
		).rejects.toThrow(/unknown or altered/);
	});
});
