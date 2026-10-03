import { describe, expect, it } from "vitest";
import { slugify } from "./slug.ts";

describe("slugify", () => {
	it.each([
		["Ola Wiśniewska", "ola-wisniewska"],
		["Lucía Fernández", "lucia-fernandez"],
		["Bartłomiej  Łukasz", "bartlomiej-lukasz"],
		["  Jan  Kos!! ", "jan-kos"],
		["???", "user"],
	])("%s → %s", (name, slug) => {
		expect(slugify(name)).toBe(slug);
	});
});
