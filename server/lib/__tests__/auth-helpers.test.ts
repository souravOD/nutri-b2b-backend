/// <reference types="jest" />

import { normalizeText, normalizeLower, normalizeRole, emailDomain } from "../auth-helpers.js";

describe("normalizeText", () => {
    it("trims whitespace", () => {
        expect(normalizeText("  hello  ")).toBe("hello");
    });

    it("returns null for empty string", () => {
        expect(normalizeText("")).toBeNull();
    });

    it("returns null for whitespace-only string", () => {
        expect(normalizeText("   ")).toBeNull();
    });

    it("returns null for null/undefined", () => {
        expect(normalizeText(null)).toBeNull();
        expect(normalizeText(undefined)).toBeNull();
    });

    it("preserves case", () => {
        expect(normalizeText("Hello World")).toBe("Hello World");
    });
});

describe("normalizeLower", () => {
    it("returns lowercase trimmed value", () => {
        expect(normalizeLower("  Hello World  ")).toBe("hello world");
    });

    it("returns null for empty/null", () => {
        expect(normalizeLower("")).toBeNull();
        expect(normalizeLower(null)).toBeNull();
    });
});

describe("normalizeRole", () => {
    it("maps 'admin' to vendor_admin", () => {
        expect(normalizeRole("admin")).toBe("vendor_admin");
    });

    it("maps 'vendor_admin' to vendor_admin", () => {
        expect(normalizeRole("vendor_admin")).toBe("vendor_admin");
    });

    it("maps 'operator' to vendor_operator", () => {
        expect(normalizeRole("operator")).toBe("vendor_operator");
    });

    it("maps 'vendor_operator' to vendor_operator", () => {
        expect(normalizeRole("vendor_operator")).toBe("vendor_operator");
    });

    it("maps 'superadmin' to superadmin", () => {
        expect(normalizeRole("superadmin")).toBe("superadmin");
    });

    it("maps 'viewer' to vendor_viewer", () => {
        expect(normalizeRole("viewer")).toBe("vendor_viewer");
    });

    it("defaults null/undefined to vendor_viewer", () => {
        expect(normalizeRole(null)).toBe("vendor_viewer");
        expect(normalizeRole(undefined)).toBe("vendor_viewer");
    });

    it("defaults unknown input to vendor_viewer", () => {
        expect(normalizeRole("manager")).toBe("vendor_viewer");
    });
});

describe("emailDomain", () => {
    it("extracts domain from standard email", () => {
        expect(emailDomain("user@example.com")).toBe("example.com");
    });

    it("handles uppercase", () => {
        expect(emailDomain("User@EXAMPLE.COM")).toBe("example.com");
    });

    it("returns null for no @ sign", () => {
        expect(emailDomain("invalid-email")).toBeNull();
    });

    it("returns null for empty input", () => {
        expect(emailDomain("")).toBeNull();
        expect(emailDomain(null)).toBeNull();
    });

    it("handles email with subdomain", () => {
        expect(emailDomain("admin@mail.company.co.uk")).toBe("mail.company.co.uk");
    });
});
