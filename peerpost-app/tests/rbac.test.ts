import { describe, expect, it } from "vitest";
import type { AppUser } from "@/lib/auth";
import { isAdmin, isApproved } from "@/lib/rbac";

const user = (over: Partial<AppUser>): AppUser =>
	({ id: "u", role: "user", approved: false, ...over }) as AppUser;

describe("isAdmin", () => {
	it("is true only for the admin role", () => {
		expect(isAdmin(user({ role: "admin" }))).toBe(true);
		expect(isAdmin(user({ role: "user" }))).toBe(false);
	});
});

describe("isApproved", () => {
	it("treats admins as always approved", () => {
		expect(isApproved(user({ role: "admin", approved: false }))).toBe(true);
	});
	it("honours the approved flag for regular users", () => {
		expect(isApproved(user({ role: "user", approved: true }))).toBe(true);
		expect(isApproved(user({ role: "user", approved: false }))).toBe(false);
	});
});
