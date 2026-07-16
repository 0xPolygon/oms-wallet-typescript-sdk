import {afterEach, describe, expect, it, vi} from "vitest";

import type {CredentialSigner} from "../src/credentialSigner";
import {AuthMode, IdentityType, Waas} from "../src/generated/waas.gen";
import {createSignedFetch} from "../src/signedFetch";

class RecordingSigner implements CredentialSigner {
    readonly signingAlgorithm = "ecdsa-p256-sha256";
    readonly preimages: string[] = [];

    async credentialId(): Promise<string> {
        return `0x04${"11".repeat(64)}`;
    }

    async nextNonce(): Promise<string> {
        return "42";
    }

    async sign(preimage: string): Promise<string> {
        this.preimages.push(preimage);
        return `0x${"22".repeat(64)}`;
    }
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("wallet request signing", () => {
    it("signs generated WaaS wallet RPC requests with the canonical preimage and signature header", async () => {
        const request = {
            identityType: IdentityType.Email,
            authMode: AuthMode.OTP,
            metadata: {email: "user@example.com"},
        };
        const body = JSON.stringify(request);
        const signer = new RecordingSigner();
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            verifier: "verifier-id",
            challenge: "challenge-id",
        }), {status: 200}));
        vi.stubGlobal("fetch", fetchMock);

        const signedFetch = createSignedFetch("publishable-key", signer, "project-id");
        const client = new Waas("https://wallet.example", signedFetch);
        await client.commitVerifier(request);

        expect(signer.preimages).toEqual([
            "POST /v1/Waas/CommitVerifier\n" +
            "nonce: 42\n" +
            "scope: project-id\n\n" +
            body,
        ]);

        expect(fetchMock).toHaveBeenCalledWith(
            "https://wallet.example/v1/Waas/CommitVerifier",
            expect.objectContaining({
                method: "POST",
                body,
            }),
        );

        const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
        expect(headers).toMatchObject({
            "Api-Key": "publishable-key",
            "Content-Type": "application/json",
            "OMS-Wallet-Signature": `alg="ecdsa-p256-sha256", scope="project-id", cred="0x04${"11".repeat(64)}", nonce=42, sig="0x${"22".repeat(64)}"`,
        });
    });
});
