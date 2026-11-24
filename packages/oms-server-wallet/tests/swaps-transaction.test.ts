import { expect, it } from 'vitest';
import { Address, Payload } from '@0xsequence/wallet-primitives';
import { bytesToHex, encodeFunctionData, hexToBytes } from 'viem';
import {
  deployAbi,
  recoveryContext,
  validateRecoveryTransaction
} from '../src/trails/recovery-transaction.js';
import { WalletEngine } from '../src/engine.js';
import { createSingleProcessExecutor } from '@polygonlabs/oms-server-wallet-sdk';
import { intentSchema } from '../src/trails/protocol.js';
import { validateTypedData } from '../src/typed-data.js';
import { owner, token, quoteFixture, recoveryFixture } from './fixtures/trails.js';
import { executeData } from './swap-harness.js';
import { FakeWaas, MemoryStore } from './helpers.js';

const balances = [{ asset: token, amount: '1000' }];
function built() {
  const prepared = recoveryFixture();
  return {
    prepared,
    intent: intentSchema.parse(quoteFixture().intent),
    tx: {
      to: prepared.intentAddress,
      data: executeData(prepared.payload.encoded),
      value: '0',
      chainId: 137,
      intentAddress: prepared.intentAddress,
      payloadHash: prepared.payloadHash,
      requiresDeploy: false
    }
  };
}
function engineHarness() {
  const store = new MemoryStore();
  const remote = new FakeWaas();
  const engine = new WalletEngine({
    namespace: 'test',
    subject: 'customer-1',
    issuer: 'https://issuer.example',
    audience: 'oms-server-wallet',
    getIdToken: async () => ({
      token: `fixture-${crypto.randomUUID()}`,
      expiresAt: Math.floor(Date.now() / 1000) + 300
    }),
    store,
    executor: createSingleProcessExecutor(),
    transport: remote
  });
  return { engine, primitives: engine.lockedPrimitives(), remote };
}

it('validates an intent execute envelope and grants a non-forgeable zero-value capability', async () => {
  const { prepared, intent, tx } = built();
  const capability = validateRecoveryTransaction(tx, prepared, intent, owner, balances);
  expect(Object.isFrozen(capability)).toBe(true);
  const h = engineHarness();
  await h.engine.core.createOrRestore();
  const operation = await h.primitives.prepareRecoveryLocked('swp_recovery_test', capability);
  expect(operation.kind).toBe('recovery');
  expect(h.remote.calls.find((c) => c.method === 'PrepareEthereumTransaction')?.body).toMatchObject(
    { to: tx.to, data: tx.data, value: '0', mode: 'relayer' }
  );
  expect(() => h.primitives.prepareRecoveryLocked('swp_forged_test', { ...capability })).toThrow();
  await h.primitives.executeEvmOperationLocked(operation.id, ['recovery'], {
    skipGate: true,
    bypassReviewId: true
  });
  h.remote.txnStatus = 'executed';
  expect((await h.primitives.refreshEvmOperationLocked(operation.id))?.status).toBe('executed');
});
it('validates the separate factory + guest envelope when the intent wallet needs deployment', () => {
  const { prepared, intent, tx } = built();
  const salt = `0x${'12'.repeat(32)}` as const;
  const address = Address.from(hexToBytes(salt), recoveryContext);
  prepared.intentAddress = address;
  prepared.payload.intentAddress = address;
  prepared.typedData.domain.verifyingContract = address;
  intent.originIntentAddress = address;
  prepared.payloadHash = validateTypedData(prepared.typedData, 137).digest;
  const call = (to: `0x${string}`, data: `0x${string}`): Payload.Call => ({
    to,
    data,
    value: 0n,
    gasLimit: 0n,
    delegateCall: false,
    onlyFallback: false,
    behaviorOnError: 'revert'
  });
  const payload: Payload.Calls = {
    type: 'call',
    space: 0n,
    nonce: 0n,
    calls: [
      call(
        recoveryContext.factory,
        encodeFunctionData({
          abi: deployAbi,
          functionName: 'deploy',
          args: [recoveryContext.stage1, salt]
        })
      ),
      call(address, executeData(prepared.payload.encoded))
    ]
  };
  const deployment = {
    ...tx,
    to: recoveryContext.guest,
    requiresDeploy: true,
    intentAddress: address,
    payloadHash: prepared.payloadHash,
    data: bytesToHex(Payload.encode(payload))
  };
  expect(validateRecoveryTransaction(deployment, prepared, intent, owner, balances).to).toBe(
    recoveryContext.guest
  );
  payload.calls[0].to = owner;
  expect(() =>
    validateRecoveryTransaction(
      { ...deployment, data: bytesToHex(Payload.encode(payload)) },
      prepared,
      intent,
      owner,
      balances
    )
  ).toThrow();
});
it('rejects calldata suffixes, altered signed calls, changed targets, hashes, chain and value', () => {
  const { prepared, intent, tx } = built();
  const mutations = [
    { ...tx, data: `${tx.data}00` },
    { ...tx, to: owner },
    { ...tx, value: '1' },
    { ...tx, chainId: 8453 },
    { ...tx, payloadHash: `0x${'ff'.repeat(32)}` },
    { ...tx, data: executeData(`${prepared.payload.encoded}00`) },
    { ...tx, requiresDeploy: true },
    { ...tx, data: executeData(prepared.payload.encoded, '0x') }
  ];
  for (const variant of mutations)
    expect(() => validateRecoveryTransaction(variant, prepared, intent, owner, balances)).toThrow();
});
it('prepares only the managed wallet self-call for owner deployment, and rejects unsponsored recovery', async () => {
  const h = engineHarness();
  await h.engine.core.createOrRestore();
  await h.primitives.prepareDeploymentLocked('swp_deployment_test', 8453);
  expect(h.remote.calls.find((c) => c.method === 'PrepareEthereumTransaction')?.body).toMatchObject(
    { network: '8453', to: owner, value: '0', data: '0x', mode: 'relayer' }
  );
  h.remote.sponsored = false;
  await expect(
    h.primitives.prepareDeploymentLocked('swp_deployment_fail', 137)
  ).rejects.toMatchObject({
    code: 'SPONSORSHIP_REQUIRED'
  });
  const { prepared, intent, tx } = built();
  await expect(
    h.primitives.prepareRecoveryLocked(
      'swp_recovery_fail',
      validateRecoveryTransaction(tx, prepared, intent, owner, balances)
    )
  ).rejects.toMatchObject({ code: 'SPONSORSHIP_REQUIRED' });
});
