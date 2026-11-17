import type { Address } from 'viem';

import { encodeFunctionData, getAddress, isAddress, isAddressEqual, zeroAddress } from 'viem';

import type { Network, OMSWallet, OMSWalletExtension } from '@polygonlabs/oms-wallet';

import { createDefaultStorage } from '@polygonlabs/oms-wallet';

import type { CreateBackend, PrivacyBackend } from './backend.js';
import type { OMSWalletPrivacyStage } from './errors.js';
import type { PrivacyContracts } from './networks.js';
import type { PrivacyQuote, PrivacyQuoteKind } from './quote.js';
import type {
  DeliveryPollingOptions,
  DeliveryStatus,
  PrivacyActions,
  PrivacyOptions,
  PrivateBalance
} from './types.js';

import { OMSWalletPrivacyError } from './errors.js';
import { createDepositGuard, erc20Abi } from './guard.js';
import { createProviderBackend } from './internal/hinkal/backend.js';
import { privacyContracts, privacyNetworks } from './networks.js';
import { createQuote, quoteInternals } from './quote.js';
import { PrivacySessions, requireActive } from './session.js';
import { DepositRun } from './transactions.js';

/** How long a quote stays valid. */
export const QUOTE_TTL_MS = 5 * 60_000;
const DEFAULT_DELIVERY_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_DELIVERY_INTERVAL_MS = 3_000;

/**
 * Adds `oms.privacy` to an `OMSWallet`:
 *
 * ```ts
 * const oms = new OMSWallet({ publishableKey }).extend(privacy());
 * const quote = await oms.privacy.quoteShield({ network: Networks.polygon, token, amount });
 * await oms.privacy.shield(quote);
 * ```
 */
export function privacy(
  options: PrivacyOptions = {}
): OMSWalletExtension<{ readonly privacy: PrivacyActions }> {
  return createPrivacyExtension(createProviderBackend, options);
}

/** Not exported from the package; tests pass a fake backend. */
export function createPrivacyExtension(
  createBackend: CreateBackend,
  options: PrivacyOptions = {}
): OMSWalletExtension<{ readonly privacy: PrivacyActions }> {
  return (oms, context) => {
    const storage = options.storage ?? createDefaultStorage();
    const sessions = new PrivacySessions(oms, context, storage, createBackend);
    return { privacy: createPrivacyActions(oms, sessions) };
  };
}

function createPrivacyActions(oms: OMSWallet, sessions: PrivacySessions): PrivacyActions {
  const actions: PrivacyActions = {
    networks: privacyNetworks,

    async getBalances(params = {}) {
      const operation = 'privacy.getBalances';
      const networks = params.networks ?? privacyNetworks;
      for (const network of networks) requireContracts(network, operation);
      return sessions.run(operation, async (backend) => {
        const chainIds = networks.map((network) => network.id);
        const [spendable, recoverable] = await backendCall(operation, 'quote', [], () =>
          Promise.all([backend.balances(chainIds), backend.recoverableBalances(chainIds)])
        );
        const byKey = new Map<
          string,
          { network: Network; token: Address; amount: bigint; recoverable: bigint }
        >();
        const entry = (chainId: number, token: Address) => {
          const network = networks.find((candidate) => candidate.id === chainId);
          if (!network) return undefined;
          const key = `${chainId}:${token.toLowerCase()}`;
          let value = byKey.get(key);
          if (!value) {
            value = { network, token: getAddress(token), amount: 0n, recoverable: 0n };
            byKey.set(key, value);
          }
          return value;
        };
        for (const balance of spendable) {
          const value = entry(balance.chainId, balance.token);
          if (value) value.amount += balance.amount;
        }
        for (const balance of recoverable) {
          const value = entry(balance.chainId, balance.token);
          if (value) value.recoverable += balance.amount;
        }
        return [...byKey.values()]
          .filter((balance) => balance.amount > 0n || balance.recoverable > 0n)
          .map((balance): PrivateBalance => Object.freeze(balance));
      });
    },

    async quoteShield(params) {
      const operation = 'privacy.quoteShield';
      requireContracts(params.network, operation);
      const token = requireAddress(params.token, 'token', operation);
      requireAmount(params.amount, operation);
      const wallet = sessions.activeAddress(operation);
      return createQuote(
        {
          kind: 'shield',
          network: params.network,
          token,
          amount: params.amount,
          fee: 0n,
          expiresAt: expiry()
        },
        { wallet, backendData: undefined }
      );
    },

    async quoteUnshield(params) {
      const operation = 'privacy.quoteUnshield';
      requireContracts(params.network, operation);
      const token = requireAddress(params.token, 'token', operation);
      requireAmount(params.amount, operation);
      const to = params.to === undefined ? undefined : requireAddress(params.to, 'to', operation);
      return sessions.run(operation, async (backend, wallet) => {
        const { fee, data } = await backendCall(operation, 'quote', [], () =>
          backend.quoteFee({
            kind: 'unshield',
            chainId: params.network.id,
            token,
            amount: params.amount
          })
        );
        return createQuote(
          {
            kind: 'unshield',
            network: params.network,
            token,
            amount: params.amount,
            fee,
            to: to ?? wallet,
            expiresAt: expiry()
          },
          { wallet, backendData: data }
        );
      });
    },

    async quotePrivateSend(params) {
      const operation = 'privacy.quotePrivateSend';
      requireContracts(params.network, operation);
      const token = requireAddress(params.token, 'token', operation);
      const to = requireAddress(params.to, 'to', operation);
      requireAmount(params.amount, operation);
      return sessions.run(operation, async (backend, wallet) => {
        const { fee, data } = await backendCall(operation, 'quote', [], () =>
          backend.quoteFee({
            kind: 'privateSend',
            chainId: params.network.id,
            token,
            amount: params.amount
          })
        );
        return createQuote(
          {
            kind: 'privateSend',
            network: params.network,
            token,
            amount: params.amount,
            fee,
            to,
            expiresAt: expiry()
          },
          { wallet, backendData: data }
        );
      });
    },

    async shield(quote, options = {}) {
      const operation = 'privacy.shield';
      return sessions.run(operation, async (backend, wallet) => {
        useQuote(quote, 'shield', wallet, operation);
        const contracts = await checkedContracts(backend, quote.network, operation);
        const chainId = quote.network.id;
        const run = new DepositRun(oms, {
          operation,
          network: quote.network,
          wallet,
          token: quote.token,
          total: quote.total,
          guard: createDepositGuard({
            chainId,
            token: quote.token,
            total: quote.total,
            spender: contracts.pool,
            pool: contracts.pool,
            depositSelector: contracts.depositSelector
          }),
          options
        });

        if (!isNative(quote.token)) {
          // Leave the allowance at exactly `total`, so the deposit can move no more than that.
          const allowance = await backendCall(operation, 'approve', run.txnIds, () =>
            backend.readAllowance(chainId, quote.token, wallet, contracts.pool)
          );
          if (allowance !== quote.total) {
            if (allowance !== 0n) await run.send(approveCall(quote.token, contracts.pool, 0n));
            await run.send(approveCall(quote.token, contracts.pool, quote.total));
          }
        }
        const deposit = await backendCall(operation, 'deposit', run.txnIds, () =>
          backend.buildShieldDeposit({ chainId, token: quote.token, amount: quote.amount })
        );
        await run.send(deposit);
        return Object.freeze({ transactions: Object.freeze([...run.transactions]) });
      });
    },

    async privateSend(quote, options = {}) {
      const operation = 'privacy.privateSend';
      const sent = await sessions.run(operation, async (backend, wallet) => {
        const internals = useQuote(quote, 'privateSend', wallet, operation);
        const contracts = await checkedContracts(backend, quote.network, operation);
        const chainId = quote.network.id;
        const run = new DepositRun(oms, {
          operation,
          network: quote.network,
          wallet,
          token: quote.token,
          total: quote.total,
          guard: createDepositGuard({
            chainId,
            token: quote.token,
            total: quote.total,
            spender: contracts.sendSpender,
            pool: contracts.pool,
            depositSelector: contracts.depositSelector
          }),
          options
        });

        if (!isNative(quote.token)) {
          // The backend approves exactly `total` when the allowance is lower and skips approving
          // when it is enough, so only a larger allowance must be reset first.
          const allowance = await backendCall(operation, 'approve', run.txnIds, () =>
            backend.readAllowance(chainId, quote.token, wallet, contracts.sendSpender)
          );
          if (allowance > quote.total)
            await run.send(approveCall(quote.token, contracts.sendSpender, 0n));
        }

        let deliveryId: string;
        try {
          ({ deliveryId } = await backend.privateSend(
            {
              chainId,
              token: quote.token,
              amount: quote.amount,
              to: quote.to!,
              feeData: internals.backendData
            },
            (call) => run.send(call)
          ));
        } catch (error) {
          if (run.failure) throw run.failure;
          if (error instanceof OMSWalletPrivacyError) throw error;
          const deposited = run.confirmedSteps.includes('deposit');
          throw run.error({
            code: 'OMS_PRIVACY_SERVICE_ERROR',
            stage: deposited ? 'delivery' : 'deposit',
            message: deposited
              ? 'The deposit executed but its delivery could not be scheduled. The funds are recoverable with recover().'
              : 'The privacy service failed before the deposit.'
          });
        }
        run.emit({ step: 'delivery', state: 'pending', deliveryId });
        return { run, deliveryId };
      });

      const result = {
        transactions: Object.freeze([...sent.run.transactions]),
        deliveryId: sent.deliveryId
      };
      if (!options.waitForDelivery) return Object.freeze(result);
      const delivery = await waitForDelivery(
        actions,
        sent.deliveryId,
        sent.run.txnIds,
        options.deliveryPolling
      );
      sent.run.emit({
        step: 'delivery',
        state: 'delivered',
        deliveryId: sent.deliveryId,
        ...(delivery.txnHash ? { txnHash: delivery.txnHash } : {})
      });
      return Object.freeze({ ...result, delivery });
    },

    async unshield(quote) {
      const operation = 'privacy.unshield';
      return sessions.run(operation, async (backend, wallet) => {
        const internals = useQuote(quote, 'unshield', wallet, operation);
        const chainId = quote.network.id;
        const balances = await backendCall(operation, 'withdraw', [], () =>
          backend.balances([chainId])
        );
        const available = sumFor(balances, chainId, quote.token);
        if (available < quote.total) {
          throw new OMSWalletPrivacyError({
            code: 'OMS_PRIVACY_INSUFFICIENT_BALANCE',
            operation,
            stage: 'withdraw',
            message: 'The private balance cannot cover the amount and fee.'
          });
        }
        const { txnHash } = await backendCall(operation, 'withdraw', [], () =>
          backend.unshield({
            chainId,
            token: quote.token,
            amount: quote.amount,
            to: quote.to!,
            feeData: internals.backendData,
            beforeSubmit: () => requireActive(oms, wallet, operation)
          })
        );
        return Object.freeze({ txnHash });
      });
    },

    async getDeliveryStatus(params) {
      const operation = 'privacy.getDeliveryStatus';
      if (typeof params.deliveryId !== 'string' || params.deliveryId.trim() === '') {
        throw invalidParams(operation, 'deliveryId is required.');
      }
      return sessions.run(operation, (backend) =>
        backendCall(operation, 'delivery', [], () => backend.deliveryStatus(params.deliveryId))
      );
    },

    async recover(params) {
      const operation = 'privacy.recover';
      requireContracts(params.network, operation);
      const token = requireAddress(params.token, 'token', operation);
      return sessions.run(operation, async (backend, wallet) => {
        const chainId = params.network.id;
        const recoverable = await backendCall(operation, 'withdraw', [], () =>
          backend.recoverableBalances([chainId])
        );
        if (sumFor(recoverable, chainId, token) === 0n) {
          throw new OMSWalletPrivacyError({
            code: 'OMS_PRIVACY_NOTHING_TO_RECOVER',
            operation,
            stage: 'withdraw',
            message: 'There are no recoverable funds for this token.'
          });
        }
        const { txnHashes } = await backendCall(operation, 'withdraw', [], () =>
          backend.recover({
            chainId,
            token,
            to: wallet,
            beforeSubmit: () => requireActive(oms, wallet, operation)
          })
        );
        return Object.freeze({ txnHashes: Object.freeze([...txnHashes]) });
      });
    }
  };
  return Object.freeze(actions);
}

async function waitForDelivery(
  actions: PrivacyActions,
  deliveryId: string,
  txnIds: ReadonlyArray<string>,
  polling: DeliveryPollingOptions = {}
): Promise<DeliveryStatus> {
  const operation = 'privacy.privateSend';
  const timeoutMs = polling.timeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;
  const intervalMs = polling.intervalMs ?? DEFAULT_DELIVERY_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let status: DeliveryStatus;
    try {
      status = await actions.getDeliveryStatus({ deliveryId });
    } catch (error) {
      // The send went through; only its status is unknown. Keep everything needed to follow it.
      throw new OMSWalletPrivacyError({
        code: error instanceof OMSWalletPrivacyError ? error.code : 'OMS_PRIVACY_SERVICE_ERROR',
        operation,
        stage: 'delivery',
        txnIds,
        deliveryId,
        message:
          'The private send was submitted, but its delivery status could not be read. Do not send ' +
          'it again; check getDeliveryStatus with this deliveryId later.',
        cause: error instanceof OMSWalletPrivacyError ? error.cause : undefined
      });
    }
    if (status.status === 'delivered') return status;
    if (status.status === 'failed') {
      throw new OMSWalletPrivacyError({
        code: 'OMS_PRIVACY_DELIVERY_FAILED',
        operation,
        stage: 'delivery',
        txnIds,
        deliveryId,
        message:
          'The private send could not be delivered. The funds are recoverable with recover().'
      });
    }
    if (Date.now() + intervalMs > deadline) {
      throw new OMSWalletPrivacyError({
        code: 'OMS_PRIVACY_DELIVERY_TIMEOUT',
        operation,
        stage: 'delivery',
        txnIds,
        deliveryId,
        message:
          'The delivery did not finish in time. It may still finish; check getDeliveryStatus.'
      });
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function expiry(): string {
  return new Date(Date.now() + QUOTE_TTL_MS).toISOString();
}

function isNative(token: Address): boolean {
  return isAddressEqual(token, zeroAddress);
}

function approveCall(token: Address, spender: Address, amount: bigint) {
  return {
    to: token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }),
    value: 0n
  };
}

function sumFor(
  balances: ReadonlyArray<{ chainId: number; token: Address; amount: bigint }>,
  chainId: number,
  token: Address
): bigint {
  return balances
    .filter((balance) => balance.chainId === chainId && isAddressEqual(balance.token, token))
    .reduce((sum, balance) => sum + balance.amount, 0n);
}

function invalidParams(operation: string, message: string): OMSWalletPrivacyError {
  return new OMSWalletPrivacyError({ code: 'OMS_PRIVACY_INVALID_PARAMS', operation, message });
}

function requireContracts(network: Network, operation: string): PrivacyContracts {
  const contracts = network && privacyContracts(network);
  if (!contracts) {
    throw new OMSWalletPrivacyError({
      code: 'OMS_PRIVACY_UNSUPPORTED_NETWORK',
      operation,
      message: `Private balances are not available on ${network?.name ?? 'this network'}.`
    });
  }
  return contracts;
}

function requireAddress(value: string, name: string, operation: string): Address {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) {
    throw invalidParams(operation, `${name} must be an address.`);
  }
  return getAddress(value);
}

function requireAmount(amount: bigint, operation: string): void {
  if (typeof amount !== 'bigint' || amount <= 0n)
    throw invalidParams(operation, 'amount must be a positive bigint.');
}

/** Checks a quote can run now for `wallet` and marks it used. */
function useQuote<K extends PrivacyQuoteKind>(
  quote: PrivacyQuote<K>,
  kind: K,
  wallet: Address,
  operation: string
) {
  const internals = quoteInternals(quote);
  if (!internals || quote.kind !== kind) {
    throw invalidParams(
      operation,
      `Pass a quote from quote${kind[0]!.toUpperCase()}${kind.slice(1)}.`
    );
  }
  const invalid = (message: string) =>
    new OMSWalletPrivacyError({
      code: 'OMS_PRIVACY_QUOTE_INVALID',
      operation,
      stage: 'quote',
      message
    });
  if (internals.used) throw invalid('This quote was already used.');
  if (Date.parse(quote.expiresAt) <= Date.now())
    throw invalid('This quote expired. Request a new one.');
  if (!isAddressEqual(internals.wallet, wallet))
    throw invalid('This quote was made for another wallet.');
  internals.used = true;
  return internals;
}

async function checkedContracts(
  backend: PrivacyBackend,
  network: Network,
  operation: string
): Promise<PrivacyContracts> {
  const contracts = requireContracts(network, operation);
  await backendCall(operation, 'setup', [], async () =>
    backend.checkContracts(network.id, contracts)
  );
  return contracts;
}

/** Runs a backend call; its failures become a generic service error without the backend's text. */
async function backendCall<T>(
  operation: string,
  stage: OMSWalletPrivacyStage,
  txnIds: ReadonlyArray<string>,
  call: () => Promise<T>
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof OMSWalletPrivacyError) throw error;
    throw new OMSWalletPrivacyError({
      code: 'OMS_PRIVACY_SERVICE_ERROR',
      operation,
      stage,
      txnIds,
      message: 'The privacy service failed.'
    });
  }
}
