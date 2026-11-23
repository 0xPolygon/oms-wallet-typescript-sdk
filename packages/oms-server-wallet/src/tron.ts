import type { ChainOperation } from './chains.js';
import type { FeeOption } from './protocol.js';

import { isTronAddress } from './addresses.js';
import { ChainWallet } from './chains.js';
import { WalletError } from './errors.js';
import { canonicalJson } from './json.js';
import { validateTronTypedData } from './typed-data.js';

export const TRON_NETWORKS = ['tron:mainnet', 'tron:nile'] as const;
export type TronNetwork = (typeof TRON_NETWORKS)[number];
/** TIP-712 domain chain IDs. */
export const TRON_CHAIN_IDS: Record<TronNetwork, number> = {
  'tron:mainnet': 728126428,
  'tron:nile': 3448148188
};

/**
 * Tron charges bandwidth and energy, burning TRX for what the wallet's delegated resources don't
 * cover. Without `maxFee` only fully covered (sponsored) transactions are sent. With it, the
 * wallet pays the quoted TRX fee when it is at most `maxFee` sun; WaaS prices the transaction
 * again at execution and refuses it if the cost rose above the quote.
 *
 * Both limits apply to the quote and that re-check, not to the signed transaction. On chain a
 * contract call is capped only by the fee limit WaaS seals into it, 1.2 times the estimated
 * energy of the whole call, which the quote does not expose. If delegated resources are used up
 * or withdrawn after the re-check, or the call needs more energy than estimated, the wallet can
 * burn TRX up to that limit, even on a sponsored quote.
 */
interface TronFeePolicy {
  /** The most the wallet may pay, in sun (1 TRX = 1,000,000 sun), as a decimal string. */
  maxFee?: string;
}
/** A TRX transfer, or with `data` (even `0x`) a call carrying pre-encoded calldata. */
export interface TronTransaction extends TronFeePolicy {
  network: TronNetwork;
  /** Base58Check recipient or contract (`T…`). */
  to: string;
  /** Sun, as a decimal string. Default `'0'`; a transfer must send more. */
  value?: string;
  data?: `0x${string}`;
}
/** A contract call the wallet service ABI-encodes. Address arguments may be `T…` addresses. */
export interface TronContractCall extends TronFeePolicy {
  network: TronNetwork;
  /** Base58Check contract address (`T…`). */
  contract: string;
  /** The function name alone, such as `transfer`; WaaS derives the signature from the arguments. */
  method: string;
  args?: { type: string; value: unknown }[];
}
export interface TronOperation extends ChainOperation {
  family: 'tron';
  kind: 'transaction' | 'contractCall' | 'sign' | 'signTypedData';
  network?: TronNetwork;
  transaction?: Required<Pick<TronTransaction, 'to' | 'value'>> & Pick<TronTransaction, 'data'>;
  call?: Pick<TronContractCall, 'contract' | 'method' | 'args'>;
  maxFee?: string;
}

const MAX_MESSAGE_BYTES = 16_384;
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const isSignature = (value: string) => /^0x[0-9a-fA-F]{130}$/.test(value);
const abiType =
  /^(address|bool|string|bytes([1-9]|[12][0-9]|3[0-2])?|u?int(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?)(\[[0-9]{0,3}\])*$/;

function fields(input: unknown, allowed: string[], code: string) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new WalletError(code, 'Provide the Tron transaction to prepare.');
  const record = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  );
  const unexpected = Object.keys(record).find((key) => !allowed.includes(key));
  if (unexpected) throw new WalletError(code, `Unexpected field "${unexpected}".`);
  return record;
}
function requireNetwork(network: unknown): TronNetwork {
  if (!TRON_NETWORKS.includes(network as TronNetwork))
    throw new WalletError('UNSUPPORTED_NETWORK', 'Select tron:mainnet or tron:nile.');
  return network as TronNetwork;
}
const sun = (value: unknown, allowZero: boolean) =>
  typeof value === 'string' &&
  /^(0|[1-9][0-9]{0,18})$/.test(value) &&
  BigInt(value) < 2n ** 63n &&
  (allowZero || value !== '0');
function requireMaxFee(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!sun(value, false))
    throw new WalletError('INVALID_FEE', 'Set maxFee as a positive amount of sun.');
  return value as string;
}

function normalizeTransaction(input: unknown) {
  const record = fields(input, ['network', 'to', 'value', 'data', 'maxFee'], 'INVALID_TRANSACTION');
  const network = requireNetwork(record.network);
  if (!isTronAddress(record.to))
    throw new WalletError('INVALID_ADDRESS', 'Provide a Base58Check Tron address (T…).');
  const value = record.value ?? '0';
  const data = record.data;
  if (data !== undefined && (typeof data !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(data)))
    throw new WalletError('INVALID_CALL', 'Calldata must be 0x-prefixed, even-length hex.');
  if (!sun(value, data !== undefined))
    throw new WalletError(
      'INVALID_AMOUNT',
      data === undefined
        ? 'A TRX transfer needs a positive amount of sun.'
        : 'Provide the call value in sun.'
    );
  return {
    network,
    transaction: {
      to: record.to as string,
      value: value as string,
      ...(data === undefined ? {} : { data: (data as string).toLowerCase() as `0x${string}` })
    },
    maxFee: requireMaxFee(record.maxFee)
  };
}
function normalizeContractCall(input: unknown) {
  const record = fields(input, ['network', 'contract', 'method', 'args', 'maxFee'], 'INVALID_CALL');
  const network = requireNetwork(record.network);
  if (!isTronAddress(record.contract))
    throw new WalletError('INVALID_ADDRESS', 'Provide a Base58Check contract address (T…).');
  if (typeof record.method !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(record.method))
    throw new WalletError('INVALID_CALL', 'Provide the function name alone, such as "transfer".');
  const args = record.args ?? [];
  if (
    !Array.isArray(args) ||
    args.length > 32 ||
    args.some(
      (arg) =>
        !arg ||
        typeof arg !== 'object' ||
        Object.keys(arg).some((key) => key !== 'type' && key !== 'value') ||
        typeof arg.type !== 'string' ||
        !abiType.test(arg.type) ||
        !('value' in arg)
    )
  )
    throw new WalletError(
      'INVALID_CALL',
      'Provide up to 32 arguments, each an ABI type and its value.'
    );
  // Snapshot the arguments as bounded, lossless JSON so the call can't change once queued.
  const snapshot = JSON.parse(canonicalJson(args, 65_536)) as { type: string; value: unknown }[];
  return {
    network,
    call: { contract: record.contract as string, method: record.method, args: snapshot },
    maxFee: requireMaxFee(record.maxFee)
  };
}
function requireMessage(message: unknown): string {
  if (
    typeof message !== 'string' ||
    !message ||
    loneSurrogate.test(message) ||
    new TextEncoder().encode(message).length > MAX_MESSAGE_BYTES
  )
    throw new WalletError('INVALID_MESSAGE', 'Messages must contain 1–16,384 UTF-8 bytes.');
  return message;
}

/**
 * The identity's Tron wallet: a secp256k1 EOA. Transactions run in native mode, paid by the
 * wallet's delegated resources (sponsored) or, under a caller-set `maxFee`, in TRX.
 */
export class TronWallet extends ChainWallet<TronOperation> {
  protected readonly family = 'tron';

  async prepareTransaction(id: string, input: TronTransaction): Promise<TronOperation> {
    const { network, transaction, maxFee } = normalizeTransaction(input);
    return this.context.run(() => this.prepareTransactionLocked(id, network, transaction, maxFee));
  }
  async sendTransaction(id: string, input: TronTransaction): Promise<TronOperation> {
    const { network, transaction, maxFee } = normalizeTransaction(input);
    return this.context.run(async () => {
      const op = await this.prepareTransactionLocked(id, network, transaction, maxFee);
      return this.executeLocked(op.id, ['transaction']);
    });
  }
  async prepareContractCall(id: string, input: TronContractCall): Promise<TronOperation> {
    const { network, call, maxFee } = normalizeContractCall(input);
    return this.context.run(() => this.prepareCallLocked(id, network, call, maxFee));
  }
  async sendContractCall(id: string, input: TronContractCall): Promise<TronOperation> {
    const { network, call, maxFee } = normalizeContractCall(input);
    return this.context.run(async () => {
      const op = await this.prepareCallLocked(id, network, call, maxFee);
      return this.executeLocked(op.id, ['contractCall']);
    });
  }
  /** Submits a prepared transaction or contract call once. */
  execute(id: string): Promise<TronOperation> {
    return this.context.run(() => this.executeLocked(id, ['transaction', 'contractCall']));
  }
  /** Signs a TIP-191 message and checks the signature with WaaS. */
  async signMessage(id: string, message: string): Promise<TronOperation> {
    const text = requireMessage(message);
    return this.signLocked(
      id,
      'sign',
      { message: text },
      (wallet) => ({
        method: 'SignMessage',
        params: { network: '', walletId: wallet.id, message: text }
      }),
      (wallet, signature) => ({
        valid: isSignature(signature),
        method: 'IsValidMessageSignature',
        params: { networkFamily: 'tron', walletAddress: wallet.address, message: text, signature }
      })
    );
  }
  /**
   * Signs TIP-712 typed data bound to the network's chain ID and a verifying contract, then checks
   * the signature with WaaS. Callers must validate what the data authorizes first.
   */
  async signTypedData(id: string, network: TronNetwork, input: unknown): Promise<TronOperation> {
    const chainId = TRON_CHAIN_IDS[requireNetwork(network)];
    // Snapshot synchronously so callers cannot mutate an authorization while it is queued.
    const { typedData, digest } = validateTronTypedData(input, chainId);
    return this.signLocked(
      id,
      'signTypedData',
      { network, digest },
      (wallet) => ({
        method: 'SignTypedData',
        params: { network: '', walletId: wallet.id, typedData }
      }),
      (wallet, signature) => ({
        valid: isSignature(signature),
        method: 'IsValidTypedDataSignature',
        params: { networkFamily: 'tron', walletAddress: wallet.address, typedData, signature }
      }),
      { network }
    );
  }

  private prepareTransactionLocked(
    id: string,
    network: TronNetwork,
    transaction: NonNullable<TronOperation['transaction']>,
    maxFee: string | undefined
  ) {
    return this.prepareLocked(
      id,
      'transaction',
      { network, ...transaction, maxFee },
      { network, transaction, ...(maxFee ? { maxFee } : {}) },
      (wallet) => {
        if (transaction.to === wallet.address)
          throw new WalletError('INVALID_ADDRESS', 'The recipient cannot be the sending wallet.');
        return {
          method: 'PrepareTronTransaction',
          params: { network, walletId: wallet.id, ...transaction, mode: 'native' }
        };
      }
    );
  }
  private prepareCallLocked(
    id: string,
    network: TronNetwork,
    call: NonNullable<TronOperation['call']>,
    maxFee: string | undefined
  ) {
    return this.prepareLocked(
      id,
      'contractCall',
      { network, ...call, maxFee },
      { network, call, ...(maxFee ? { maxFee } : {}) },
      (wallet) => {
        if (call.contract === wallet.address)
          throw new WalletError('INVALID_CALL', 'Calls to the wallet itself are not allowed.');
        return {
          method: 'PrepareTronContractCall',
          params: {
            network,
            walletId: wallet.id,
            contract: call.contract,
            method: call.method,
            args: call.args,
            mode: 'native'
          }
        };
      }
    );
  }
  protected payment(op: TronOperation): FeeOption | undefined {
    const quote = op.quote!;
    if (quote.sponsored) return undefined;
    if (!op.maxFee)
      throw new WalletError(
        'SPONSORSHIP_REQUIRED',
        'Delegated resources do not cover this transaction. Delegate energy and bandwidth to the wallet, or set maxFee to pay in TRX.',
        409
      );
    const options = quote.feeOptions.filter(
      (option) => option.token.symbol === 'TRX' && option.token.type.toUpperCase() === 'NATIVE'
    );
    if (options.length !== 1 || options[0].value === '0')
      throw new WalletError('INVALID_RESPONSE', 'WaaS quoted no single TRX fee.', 502);
    if (BigInt(options[0].value) > BigInt(op.maxFee))
      throw new WalletError(
        'FEE_LIMIT_EXCEEDED',
        `The quoted fee of ${options[0].value} sun exceeds maxFee.`,
        409
      );
    return options[0];
  }
}
