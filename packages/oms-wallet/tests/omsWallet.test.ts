import {afterEach, describe, expect, it, vi} from "vitest";

import {Networks, OMSWallet} from "../src";
import {parsePublishableKey} from "../src/publishableKey";
import {MemoryStorageManager} from "../src/storageManager";

const walletAddress = "0x9999999999999999999999999999999999999999";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("OMSWallet publishable key routing", () => {
    it.each([
        ["pk_local_sdbx_project_key", "https://sandbox-api.local.polygon-dev.technology"],
        ["pk_local_live_project_key", "https://api.local.polygon-dev.technology"],
        ["pk_dev_sdbx_project_key", "https://sandbox-api.dev.polygon-dev.technology"],
        ["pk_dev_live_project_key", "https://api.dev.polygon-dev.technology"],
        ["pk_stg_sdbx_project_key", "https://sandbox-api.stg.polygon-dev.technology"],
        ["pk_stg_live_project_key", "https://api.stg.polygon-dev.technology"],
        ["pk_sdbx_project_key", "https://sandbox-api.polygon.technology"],
        ["pk_live_project_key", "https://api.polygon.technology"],
    ])("derives service URLs from %s", (publishableKey, apiUrl) => {
        expect(parsePublishableKey(publishableKey)).toEqual({
            projectId: "prj_project",
            walletApiUrl: apiUrl,
            indexerGatewayUrl: `${apiUrl}/v1/IndexerGateway/`,
        });
    });

    it("uses the derived URLs for WaaS and IndexerGateway requests", async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = input.toString();

            if (url.endsWith("/v1/WaasPublic/IsValidMessageSignature")) {
                return jsonResponse({isValid: true});
            }

            if (url.endsWith("/v1/IndexerGateway/GetTokenBalancesDetails")) {
                return jsonResponse({
                    page: {page: 0, pageSize: 40, more: false},
                    nativeBalances: [],
                    balances: [],
                });
            }

            throw new Error(`Unexpected request: ${url}`);
        });
        vi.stubGlobal("fetch", fetchMock);

        const oms = new OMSWallet({
            publishableKey: "pk_stg_live_project_key",
            storage: new MemoryStorageManager(),
        });

        await expect(oms.wallet.isValidMessageSignature({
            network: Networks.polygon,
            walletAddress,
            message: "hello",
            signature: "0xsignature",
        })).resolves.toBe(true);
        await expect(oms.indexer.getBalances({
            networks: [Networks.polygon],
            walletAddress,
            includeMetadata: false,
        })).resolves.toMatchObject({
            status: 200,
            nativeBalances: [],
            balances: [],
        });

        expect(fetchMock.mock.calls[0][0].toString()).toBe(
            "https://api.stg.polygon-dev.technology/v1/WaasPublic/IsValidMessageSignature",
        );
        expect(fetchMock.mock.calls[1][0].toString()).toBe(
            "https://api.stg.polygon-dev.technology/v1/IndexerGateway/GetTokenBalancesDetails",
        );
    });

    it("rejects unsupported publishable key prefixes", () => {
        expect(() => new OMSWallet({
            publishableKey: "pk_test_sdbx_project_key",
            storage: new MemoryStorageManager(),
        })).toThrow("Invalid publishableKey.");
    });
});

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: {"Content-Type": "application/json"},
    });
}
