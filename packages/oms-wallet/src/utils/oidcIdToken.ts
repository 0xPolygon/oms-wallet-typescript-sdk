import {base64UrlDecodeString, base64UrlEncodeBytes} from "./oidcRedirect.js";

interface OidcIdTokenPayload {
    exp?: unknown;
}

export function oidcIdTokenExpiresAtEpochSeconds(idToken: string): number {
    const payload = parseOidcIdTokenPayload(idToken);
    const expiresAt = epochSecondsFromClaim(payload.exp);
    if (expiresAt === undefined) {
        throw new Error(payload.exp === undefined
            ? "OIDC ID token is missing an exp claim"
            : "OIDC ID token exp claim is invalid");
    }
    return expiresAt;
}

export async function oidcIdTokenHandleHash(idToken: string): Promise<string> {
    if (!globalThis.crypto?.subtle) {
        throw new Error("OIDC ID token auth requires crypto.subtle");
    }
    const digest = await globalThis.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(idToken),
    );
    return base64UrlEncodeBytes(new Uint8Array(digest));
}

function parseOidcIdTokenPayload(idToken: string): OidcIdTokenPayload {
    const parts = idToken.split(".");
    if (parts.length < 2) {
        throw new Error("OIDC ID token must contain header and payload sections");
    }
    try {
        const payload = JSON.parse(base64UrlDecodeString(parts[1]));
        if (!payload || typeof payload !== "object") {
            throw new Error("OIDC ID token payload is invalid");
        }
        return payload as OidcIdTokenPayload;
    } catch (error) {
        if (error instanceof Error && error.message.startsWith("OIDC ID token")) {
            throw error;
        }
        throw new Error("OIDC ID token payload is invalid");
    }
}

function epochSecondsFromClaim(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
        return value;
    }
    if (typeof value === "string" && /^\d+$/.test(value)) {
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) ? parsed : undefined;
    }
    return undefined;
}
