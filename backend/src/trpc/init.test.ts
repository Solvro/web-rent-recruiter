import { describe, expect, it } from "vitest";
import { clientIp } from "./init.ts";

describe("clientIp", () => {
	it("trusts forwarded headers only from the local proxy", () => {
		expect(clientIp("127.0.0.1", { "cf-connecting-ip": "203.0.113.7" })).toBe("203.0.113.7");
		expect(clientIp("::1", { "x-forwarded-for": "198.51.100.2, 10.0.0.1" })).toBe("198.51.100.2");
		expect(clientIp("127.0.0.1", {})).toBe("127.0.0.1");
		expect(clientIp("192.0.2.5", { "cf-connecting-ip": "203.0.113.7" })).toBe("192.0.2.5");
	});
});
