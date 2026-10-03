import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { candidateHash, normalizeProfileUrl, toHex } from "./candidate-hash.ts";

describe("normalizeProfileUrl", () => {
	it.each([
		["https://www.linkedin.com/in/Jane-Doe/", "linkedin.com/in/jane-doe"],
		["http://linkedin.com/in/jane-doe?utm_source=share#about", "linkedin.com/in/jane-doe"],
		["  LinkedIn.com/in/jane-doe//  ", "linkedin.com/in/jane-doe"],
		["https://github.com/janedoe", "github.com/janedoe"],
	])("%s → %s", (input, expected) => {
		expect(normalizeProfileUrl(input)).toBe(expected);
	});
});

describe("candidateHash", () => {
	it("is stable across cosmetic URL differences", () => {
		const a = candidateHash("salt", "https://www.linkedin.com/in/jane-doe/");
		const b = candidateHash("salt", "linkedin.com/in/Jane-Doe?trk=x");
		expect(toHex(a)).toBe(toHex(b));
		expect(a).toHaveLength(32);
	});

	it("differs per role salt", () => {
		expect(toHex(candidateHash("a", "linkedin.com/in/x"))).not.toBe(
			toHex(candidateHash("b", "linkedin.com/in/x")),
		);
	});

	it("matches sha256(salt + normalized)", () => {
		const expected = createHash("sha256")
			.update("s" + "github.com/x")
			.digest("hex");
		expect(toHex(candidateHash("s", "https://github.com/x/"))).toBe(expected);
	});
});
