import { createHash, randomBytes } from "node:crypto";

/**
 * Lowercase, drop protocol, `www.`, query, fragment and trailing slashes, so the same person can't be
 * re-submitted under a cosmetically different URL.
 */
export function normalizeProfileUrl(url: string): string {
	let u = url.trim().toLowerCase();
	u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
	u = u.replace(/^www\./, "");
	u = u.split("#")[0].split("?")[0];
	return u.replace(/\/+$/, "");
}

/** sha256(roleSalt + normalized profileUrl), 32 bytes. */
export function candidateHash(roleSalt: string, profileUrl: string): Uint8Array {
	return new Uint8Array(
		createHash("sha256")
			.update(roleSalt + normalizeProfileUrl(profileUrl))
			.digest(),
	);
}

export const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
export const fromHex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
export const newRoleSalt = () => randomBytes(16).toString("hex");
