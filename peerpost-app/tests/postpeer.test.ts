import { describe, expect, it } from "vitest";
import { asIntegrationArray } from "@/lib/postpeer";

describe("asIntegrationArray", () => {
	it("extracts the integrations array from the envelope", () => {
		const res = {
			success: true,
			total: 1,
			integrations: [{ id: "1", platform: "twitter" as const }],
		};
		expect(asIntegrationArray(res)).toHaveLength(1);
		expect(asIntegrationArray(res)[0].id).toBe("1");
	});

	it("returns an empty array when integrations is missing", () => {
		// biome-ignore lint/suspicious/noExplicitAny: testing a malformed envelope
		expect(asIntegrationArray({ success: true, total: 0 } as any)).toEqual([]);
	});
});
