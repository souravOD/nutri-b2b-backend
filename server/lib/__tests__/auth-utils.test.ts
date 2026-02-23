/// <reference types="jest" />

// Mock node-appwrite (imported at module scope by auth.ts)
jest.mock("node-appwrite", () => {
    const mockClient = {
        setEndpoint: jest.fn().mockReturnThis(),
        setProject: jest.fn().mockReturnThis(),
        setJWT: jest.fn().mockReturnThis(),
    };
    return {
        Client: jest.fn(() => mockClient),
        Account: jest.fn(() => ({ get: jest.fn() })),
        Databases: jest.fn(),
        Query: {},
        Teams: jest.fn(),
    };
});

// Mock database to avoid real connections
jest.mock("../database.js", () => ({
    db: { execute: jest.fn() },
    readDb: { execute: jest.fn() },
    primaryPool: { query: jest.fn() },
}));

import { extractJWT } from "../auth.js";

describe("extractJWT", () => {
    const mockReq = (headers: Record<string, string | string[] | undefined>) => ({
        headers,
    }) as any;

    it("extracts JWT from Bearer header", () => {
        const jwt = extractJWT(mockReq({ authorization: "Bearer abc.def.ghi" }));
        expect(jwt).toBe("abc.def.ghi");
    });

    it("extracts JWT from x-appwrite-jwt header", () => {
        const jwt = extractJWT(mockReq({ "x-appwrite-jwt": "xyz.123.456" }));
        expect(jwt).toBe("xyz.123.456");
    });

    it("prefers Bearer over x-appwrite-jwt", () => {
        const jwt = extractJWT(
            mockReq({
                authorization: "Bearer from-bearer",
                "x-appwrite-jwt": "from-header",
            })
        );
        expect(jwt).toBe("from-bearer");
    });

    it("returns null when no auth headers present", () => {
        expect(extractJWT(mockReq({}))).toBeNull();
    });

    it("returns null for non-Bearer authorization", () => {
        expect(extractJWT(mockReq({ authorization: "Basic abc123" }))).toBeNull();
    });

    it("handles array authorization header", () => {
        const jwt = extractJWT(
            mockReq({ authorization: ["Bearer first-token", "Bearer second-token"] })
        );
        expect(jwt).toBe("first-token");
    });
});
