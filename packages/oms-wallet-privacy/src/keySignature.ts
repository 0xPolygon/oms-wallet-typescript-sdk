import type { Address, Hex } from 'viem';

import {
  bytesToHex,
  concat,
  decodeAbiParameters,
  encodeAbiParameters,
  hashMessage,
  hexToBytes,
  isAddressEqual,
  keccak256,
  recoverAddress,
  recoverMessageAddress,
  serializeSignature,
  toBytes
} from 'viem';

import { Signature as SequenceSignature } from '@0xsequence/wallet-primitives';

const ERC6492_MAGIC = '6492649264926492649264926492649264926492649264926492649264926492';
/** secp256k1 group order / 2: canonical signatures have `s` at or below it. */
const HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

export class KeySignatureError extends Error {
  override readonly name = 'KeySignatureError';
}

/**
 * The part of a wallet's signature over `message` that only depends on the wallet's own key, the
 * wallet address, the chain and the message.
 *
 * A WaaS smart-contract wallet's signature also encodes its current configuration: it is wrapped
 * in ERC-6492 until the wallet is deployed, and pending configuration updates (such as smart
 * sessions being added, revoked or expiring) are chained onto it. All of those change the full
 * signature. The wallet key's ECDSA signature over the message itself does not, so keys are
 * derived from that. EOA-mode wallets return that ECDSA signature directly.
 *
 * Fails closed: anything other than exactly one ECDSA signer that alone meets the configuration's
 * threshold and recovers against the expected hash is rejected.
 */
export async function innerKeySignature(params: {
  signature: Hex;
  wallet: Address;
  chainId: number;
  message: string;
}): Promise<{ signature: Hex; signer: Address }> {
  let bytes = hexToBytes(params.signature);

  // ERC-6492 wrapper (undeployed wallet): abi.encode(factory, deployData, innerSignature) ++ magic.
  if (bytesToHex(bytes).endsWith(ERC6492_MAGIC)) {
    const [, , inner] = decodeAbiParameters(
      [{ type: 'address' }, { type: 'bytes' }, { type: 'bytes' }],
      bytesToHex(bytes.slice(0, bytes.length - 32))
    );
    bytes = hexToBytes(inner);
  }

  // EOA mode: a plain personal-sign ECDSA signature by the wallet address itself.
  if (bytes.length === 65) {
    const signature = canonical(bytes);
    const signer = await recoverMessageAddress({ message: params.message, signature });
    if (!isAddressEqual(signer, params.wallet)) {
      throw new KeySignatureError('The signature is not from the wallet.');
    }
    return { signature, signer };
  }

  // Chained signature: flag 0x01, then uint24-length-prefixed links. The first link signs the
  // message; later links sign configuration updates that are not on chain yet.
  if (bytes.length > 0 && (bytes[0]! & 0x03) === 0x01) {
    if (bytes.length < 4) throw new KeySignatureError('Malformed chained signature.');
    const length = (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!;
    if (length === 0 || 4 + length > bytes.length) {
      throw new KeySignatureError('Malformed chained signature.');
    }
    bytes = bytes.slice(4, 4 + length);
  }

  let decoded: ReturnType<typeof SequenceSignature.decodeSignature>;
  try {
    decoded = SequenceSignature.decodeSignature(bytes);
  } catch {
    throw new KeySignatureError('Unsupported wallet signature.');
  }
  if ((bytes[0]! & 0x03) === 0x01 || decoded.suffix?.length) {
    throw new KeySignatureError('Unsupported nested chained signature.');
  }

  const leaves = ecdsaLeaves(decoded.configuration.topology);
  if (leaves.length !== 1) {
    throw new KeySignatureError(`Expected one wallet key signature, found ${leaves.length}.`);
  }
  const leaf = leaves[0]!;
  if (leaf.weight < decoded.configuration.threshold) {
    throw new KeySignatureError('The wallet key signature does not meet the threshold alone.');
  }

  const signature = canonical(
    hexToBytes(
      serializeSignature({
        r: bytesToHex(toBytes(leaf.r, { size: 32 })),
        s: bytesToHex(toBytes(leaf.s, { size: 32 })),
        yParity: leaf.yParity
      })
    )
  );
  const hash = sequenceDigestHash(params.wallet, params.chainId, hashMessage(params.message));
  const signer = await recoverAddress({ hash, signature });
  return { signature, signer };
}

/** Sequence v3 `DigestPayload` hash: what the wallet key signs for a message. */
export function sequenceDigestHash(wallet: Address, chainId: number, messageDigest: Hex): Hex {
  const domain = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' }
      ],
      [
        keccak256(
          toBytes(
            'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'
          )
        ),
        keccak256(toBytes('Sequence Wallet')),
        keccak256(toBytes('3')),
        BigInt(chainId),
        wallet
      ]
    )
  );
  const message = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }],
      // No parent wallets: the hash of an empty list.
      [
        keccak256(toBytes('Message(bytes message,address[] wallets)')),
        messageDigest,
        keccak256('0x')
      ]
    )
  );
  return keccak256(concat(['0x1901', domain, message]));
}

interface EcdsaLeaf {
  weight: bigint;
  r: bigint;
  s: bigint;
  yParity: number;
}

/** Signer leaves in the signed topology whose signature is a plain ECDSA signature over the hash. */
function ecdsaLeaves(node: unknown, out: EcdsaLeaf[] = []): EcdsaLeaf[] {
  if (Array.isArray(node)) {
    for (const child of node) ecdsaLeaves(child, out);
    return out;
  }
  if (typeof node !== 'object' || node === null) return out;
  const candidate = node as {
    type?: string;
    weight?: bigint;
    signature?: { type?: string; r?: bigint; s?: bigint; yParity?: number };
  };
  if (candidate.type === 'unrecovered-signer') {
    const signature = candidate.signature;
    if (signature?.type !== 'hash') {
      throw new KeySignatureError(`Unsupported signer signature type ${String(signature?.type)}.`);
    }
    out.push({
      weight: BigInt(candidate.weight ?? 0n),
      r: BigInt(signature.r ?? 0n),
      s: BigInt(signature.s ?? 0n),
      yParity: Number(signature.yParity ?? 0)
    });
    return out;
  }
  for (const value of Object.values(candidate)) {
    if (typeof value === 'object') ecdsaLeaves(value, out);
  }
  return out;
}

/** 65-byte r ‖ s ‖ v with v in {27, 28} and a low `s`, or an error. */
function canonical(bytes: Uint8Array): Hex {
  if (bytes.length !== 65) throw new KeySignatureError('Malformed ECDSA signature.');
  const s = BigInt(bytesToHex(bytes.slice(32, 64)));
  if (s === 0n || s > HALF_ORDER) throw new KeySignatureError('Non-canonical ECDSA signature.');
  const v = bytes[64]!;
  const normalized = v < 27 ? v + 27 : v;
  if (normalized !== 27 && normalized !== 28)
    throw new KeySignatureError('Malformed ECDSA signature.');
  const out = new Uint8Array(bytes);
  out[64] = normalized;
  return bytesToHex(out);
}
