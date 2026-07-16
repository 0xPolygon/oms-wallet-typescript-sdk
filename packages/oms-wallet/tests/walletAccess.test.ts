import {afterEach, describe, expect, it, vi} from "vitest";

import {WalletClient} from "../src/clients/walletClient";
import type {CredentialSigner} from "../src/credentialSigner";
import {MemoryStorageManager} from "../src/storageManager";

class MockSigner implements CredentialSigner {
    readonly signingAlgorithm = "ecdsa-p256-sha256";

    async credentialId(): Promise<string> {
        return "0x04" + "11".repeat(64);
    }

    async nextNonce(): Promise<string> {
        return "42";
    }

    async sign(): Promise<string> {
        return "0x" + "22".repeat(64);
    }

    async hasCredential(): Promise<boolean> {
        return true;
    }
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("WalletClient access management", () => {
    it("lists all wallet access pages as a flattened grant array", async () => {
        const requests: unknown[] = [];
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = input.toString();
            const body = JSON.parse(init?.body as string);

            if (url.endsWith("/ListAccess")) {
                requests.push(body);
                if (requests.length === 1) {
                    return jsonResponse({
                        credentials: [testCredential("11")],
                        page: {cursor: "cursor-2"},
                    });
                }
                return jsonResponse({
                    credentials: [testCredential("22", false)],
                    page: {},
                });
            }

            throw new Error(`Unexpected request: ${url}`);
        });
        vi.stubGlobal("fetch", fetchMock);

        const wallet = createWalletWithSession();

        await expect(wallet.listAccess({pageSize: 2})).resolves.toEqual([
            testCredential("11"),
            testCredential("22", false),
        ]);
        expect(requests).toEqual([
            {walletId: "wallet-id", page: {limit: 2}},
            {walletId: "wallet-id", page: {limit: 2, cursor: "cursor-2"}},
        ]);
    });

    it("yields wallet access pages for paginated callers", async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = input.toString();

            if (url.endsWith("/ListAccess")) {
                return jsonResponse({
                    credentials: [testCredential()],
                    page: {},
                });
            }

            throw new Error(`Unexpected request: ${url}`);
        });
        vi.stubGlobal("fetch", fetchMock);

        const wallet = createWalletWithSession();
        const pages = [];
        for await (const page of wallet.listAccessPages({pageSize: 25})) {
            pages.push(page);
        }

        expect(pages).toEqual([{grants: [testCredential()]}]);
    });

    it("rejects access page iteration when the active session changes mid-page", async () => {
        let resolveSecondPage!: (response: Response) => void;
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = input.toString();

            if (url.endsWith("/ListAccess")) {
                if (requestCount(fetchMock, "/ListAccess") === 1) {
                    return jsonResponse({
                        credentials: [testCredential("11")],
                        page: {cursor: "cursor-2"},
                    });
                }

                return new Promise<Response>(resolve => {
                    resolveSecondPage = resolve;
                });
            }

            throw new Error(`Unexpected request: ${url}`);
        });
        vi.stubGlobal("fetch", fetchMock);

        const wallet = createWalletWithSession();
        const iterator = wallet.listAccessPages({pageSize: 25})[Symbol.asyncIterator]();

        await expect(iterator.next()).resolves.toEqual({
            done: false,
            value: {grants: [testCredential("11")]},
        });

        const secondPage = iterator.next();
        await waitForRequest(fetchMock, "/ListAccess", 2);
        await wallet.signOut();
        resolveSecondPage(jsonResponse({
            credentials: [testCredential("22")],
            page: {},
        }));

        await expect(secondPage).rejects.toMatchObject({
            code: "OMS_SESSION_MISSING",
            operation: "wallet.listAccessPages",
        });
    });
});

function createWalletWithSession(): WalletClient {
    const wallet = new WalletClient({
        publishableKey: "publishable-key",
        projectId: "project-id",
        environment: testEnvironment(),
        storage: new MemoryStorageManager(),
        credentialSigner: new MockSigner(),
    });
    (wallet as any).persistSession("wallet-id", "0x1111111111111111111111111111111111111111", {
        expiresAt: "2099-01-01T00:00:00Z",
        auth: {type: "email", email: "user@example.com"},
        signerCredentialId: "0x04" + "11".repeat(64),
        signerKeyType: "ecdsa-p256-sha256",
    });
    return wallet;
}

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: {"Content-Type": "application/json"},
    });
}

function testCredential(seed = "11", isCaller = true) {
    return {
        credentialId: "0x" + seed.repeat(32),
        expiresAt: "2099-01-01T00:00:00Z",
        isCaller,
    };
}

function testEnvironment() {
    return {
        walletApiUrl: "https://wallet.example",
        indexerGatewayUrl: "https://indexer.example",
    };
}

function requestCount(fetchMock: ReturnType<typeof vi.fn>, endpoint: string): number {
    return fetchMock.mock.calls.filter(([input]) => input.toString().endsWith(endpoint)).length;
}

async function waitForRequest(
    fetchMock: ReturnType<typeof vi.fn>,
    endpoint: string,
    count = 1,
): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (requestCount(fetchMock, endpoint) >= count) return;
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    throw new Error(`Timed out waiting for ${endpoint}`);
}
