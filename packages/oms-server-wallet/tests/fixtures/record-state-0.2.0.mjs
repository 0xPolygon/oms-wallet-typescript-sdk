// Records the raw store a published 0.2.0 ServerWallet leaves behind, encrypted with a test key.
// Run it in a scratch project with `@polygonlabs/oms-server-wallet-sdk@0.2.0` installed:
//   node record-state-0.2.0.mjs > state-0.2.0.json
import {
  ServerWallet,
  SerialExecutor,
  EncryptedStore,
  UpstreamError
} from '@polygonlabs/oms-server-wallet-sdk';
const raw = new Map();
const inner = { read: async (k) => raw.get(k) ?? null, write: async (k, v) => void raw.set(k, v) };
const key = Buffer.alloc(32, 7).toString('base64');
const wallet = {
  id: 'wallet-legacy',
  address: '0x1111111111111111111111111111111111111111',
  networkFamily: 'evm',
  type: 'ethereum'
};
const transport = {
  async request(method, body, credential) {
    if (method === 'CommitVerifier') return { verifier: body.handle };
    if (method === 'CompleteAuth')
      return {
        identity: { type: 'oidc', iss: 'https://issuer.example', sub: 'customer-1' },
        credential: {
          credentialId: credential.credentialId,
          expiresAt: '2099-01-01T00:00:00.000Z'
        },
        wallets: []
      };
    if (method === 'CreateWallet') return { wallet };
    if (method === 'SignMessage') return { signature: '0x1234' };
    if (method === 'IsValidMessageSignature') return { isValid: true };
    if (method === 'PrepareEthereumTransaction')
      return {
        txnId: 'txn-legacy',
        status: 'quoted',
        sponsored: true,
        expiresAt: '2099-01-01T00:00:00.000Z'
      };
    if (method === 'Execute') return { status: 'pending' };
    throw new UpstreamError(7200, method);
  }
};
const client = new ServerWallet({
  subject: 'customer-1',
  issuer: 'https://issuer.example',
  audience: 'oms-server-wallet',
  tokenProvider: async () => ({ token: 'fixture-token', expiresAt: 4102444800 }),
  store: new EncryptedStore(inner, key, 'customer-1'),
  executor: new SerialExecutor(),
  transport
});
await client.createOrRestore();
await client.signMessage('legacy-sign-1', 137, 'hello');
await client.prepareTransfer('legacy-transfer-1', {
  chainId: 137,
  to: '0x2222222222222222222222222222222222222222',
  asset: 'native',
  amount: '1000'
});
await client.executeTransfer('legacy-transfer-1');
console.log(
  JSON.stringify(
    {
      sdkVersion: '0.2.0',
      subject: 'customer-1',
      encryptionKey: key,
      store: Object.fromEntries(raw)
    },
    null,
    2
  )
);
