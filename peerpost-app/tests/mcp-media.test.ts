import { describe, expect, it } from "vitest";
import { parseDriveUrl } from "../mcp-server/drive";
import {
	normalizeUrl,
	parseBase64Media,
	sniffMime,
} from "../mcp-server/postpeer";
import { supports, videoPlatformData } from "../mcp-server/tools";

describe("parseDriveUrl", () => {
	it("detects folder links", () => {
		expect(
			parseDriveUrl("https://drive.google.com/drive/folders/AbC-123"),
		).toEqual({
			kind: "folder",
			id: "AbC-123",
		});
	});
	it("detects file links (/file/d/ and ?id=)", () => {
		expect(parseDriveUrl("https://drive.google.com/file/d/XyZ_9/view")).toEqual(
			{
				kind: "file",
				id: "XyZ_9",
			},
		);
		expect(parseDriveUrl("https://drive.google.com/open?id=File_42")).toEqual({
			kind: "file",
			id: "File_42",
		});
	});
	it("returns null for non-Drive URLs", () => {
		expect(parseDriveUrl("https://example.com/image.png")).toBeNull();
	});
});

describe("normalizeUrl", () => {
	it("rewrites a Drive file link to a direct download", () => {
		expect(
			normalizeUrl("https://drive.google.com/file/d/ID123/view?usp=sharing"),
		).toBe("https://drive.google.com/uc?export=download&id=ID123");
	});
	it("leaves non-Drive URLs unchanged", () => {
		expect(normalizeUrl("https://cdn.example.com/a.jpg")).toBe(
			"https://cdn.example.com/a.jpg",
		);
	});
});

describe("sniffMime", () => {
	const pad = (head: number[]) =>
		Buffer.concat([Buffer.from(head), Buffer.alloc(12)]);
	it("identifies PNG and JPEG by magic bytes", () => {
		expect(sniffMime(pad([0x89, 0x50, 0x4e, 0x47]))).toBe("image/png");
		expect(sniffMime(pad([0xff, 0xd8, 0xff]))).toBe("image/jpeg");
	});
	it("returns null for unknown bytes", () => {
		expect(sniffMime(pad([0x00, 0x01, 0x02]))).toBeNull();
	});
});

describe("parseBase64Media", () => {
	it("splits a data URI into mime + bytes", () => {
		const png = Buffer.from([0x89, 0x50]).toString("base64");
		const r = parseBase64Media(`data:image/png;base64,${png}`);
		expect(r.mime).toBe("image/png");
		expect(r.bytes[0]).toBe(0x89);
	});
	it("treats a bare string as raw base64 with no mime", () => {
		const r = parseBase64Media(Buffer.from([0xff, 0xd8]).toString("base64"));
		expect(r.mime).toBe("");
		expect(r.bytes[0]).toBe(0xff);
	});
});

describe("supports (platform capabilities)", () => {
	it("knows video-only platforms", () => {
		expect(supports("youtube", "video")).toBe(true);
		expect(supports("youtube", "text")).toBe(false);
		expect(supports("youtube", "image")).toBe(false);
		expect(supports("tiktok", "video")).toBe(true);
		expect(supports("tiktok", "text")).toBe(false);
	});
	it("knows full-capability platforms", () => {
		for (const cap of ["text", "image", "video"] as const) {
			expect(supports("twitter", cap)).toBe(true);
		}
	});
	it("instagram is media-only (no text)", () => {
		expect(supports("instagram", "text")).toBe(false);
		expect(supports("instagram", "image")).toBe(true);
		expect(supports("instagram", "video")).toBe(true);
	});
	it("pinterest and unknown platforms support nothing here", () => {
		expect(supports("pinterest", "video")).toBe(false);
		expect(supports("mastodon", "text")).toBe(false);
	});
});

describe("videoPlatformData", () => {
	it("uses the title for YouTube, defaulting to the caption", () => {
		expect(
			videoPlatformData("youtube", "My caption", { title: "Real Title" }),
		).toEqual({
			title: "Real Title",
			visibility: "public",
		});
		expect(videoPlatformData("youtube", "My caption", {})).toEqual({
			title: "My caption",
			visibility: "public",
		});
	});
	it("truncates the YouTube title to 100 chars and falls back to Untitled", () => {
		const long = "x".repeat(150);
		expect(
			(videoPlatformData("youtube", long, {}) as { title: string }).title,
		).toHaveLength(100);
		expect(videoPlatformData("youtube", "", {})).toEqual({
			title: "Untitled Video",
			visibility: "public",
		});
	});
	it("honours YouTube visibility", () => {
		expect(
			videoPlatformData("youtube", "c", { visibility: "unlisted" })?.visibility,
		).toBe("unlisted");
	});
	it("sets TikTok privacy (default public)", () => {
		expect(videoPlatformData("tiktok", "c", {})).toEqual({
			privacyLevel: "PUBLIC_TO_EVERYONE",
		});
		expect(
			videoPlatformData("tiktok", "c", { privacyLevel: "SELF_ONLY" }),
		).toEqual({
			privacyLevel: "SELF_ONLY",
		});
	});
	it("returns undefined for platforms with no special video data", () => {
		expect(videoPlatformData("twitter", "c", {})).toBeUndefined();
	});
});
