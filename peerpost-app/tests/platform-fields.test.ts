import { describe, expect, it } from "vitest";
import { buildPlatformData } from "@/lib/platform-fields";

describe("buildPlatformData", () => {
	it("includes documented defaults for YouTube and merges user values", () => {
		const out = buildPlatformData("youtube", { title: "Hello" });
		expect(out).toMatchObject({
			title: "Hello",
			visibility: "public",
			categoryId: "22",
		});
	});

	it("splits comma/newline tag fields into arrays and drops empties", () => {
		const out = buildPlatformData("youtube", { tags: "a, b ,,\nc" });
		expect(out?.tags).toEqual(["a", "b", "c"]);
	});

	it("coerces number fields", () => {
		const out = buildPlatformData("tiktok", { videoCoverTimestampMs: "1500" });
		expect(out?.videoCoverTimestampMs).toBe(1500);
	});

	it("coerces checkbox fields to booleans", () => {
		const out = buildPlatformData("youtube", { madeForKids: true });
		expect(out?.madeForKids).toBe(true);
	});

	it("returns undefined when nothing meaningful is set (Twitter has no defaults)", () => {
		expect(buildPlatformData("twitter", {})).toBeUndefined();
	});

	it("omits Pinterest boardId (the composer merges that special field in)", () => {
		const out = buildPlatformData("pinterest", {
			boardId: "abc",
			title: "Pin",
		});
		expect(out).toMatchObject({ title: "Pin" });
		expect(out?.boardId).toBeUndefined();
	});

	it("ignores unknown platforms", () => {
		expect(buildPlatformData("mastodon", { foo: "bar" })).toBeUndefined();
	});
});
