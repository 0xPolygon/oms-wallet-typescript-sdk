# OMS Wallet Privacy

Private balances for [OMS Wallet](../oms-wallet/README.md) Ethereum wallets: shield tokens into a
private balance, unshield them to any address, and send privately so that the recipient's transfer
has no on-chain link to the sender.

```bash
pnpm add @polygonlabs/oms-wallet @polygonlabs/oms-wallet-privacy viem
```

ESM only. Requires `@polygonlabs/oms-wallet` 0.5 or later.

## Usage

```typescript
import { Networks, OMSWallet } from '@polygonlabs/oms-wallet';
import { privacy } from '@polygonlabs/oms-wallet-privacy';

const oms = new OMSWallet({ publishableKey }).extend(privacy());
// Sign in as usual with oms.wallet, then:

const usdc = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';

// Shield: wallet → private balance
const shieldQuote = await oms.privacy.quoteShield({
  network: Networks.polygon,
  token: usdc,
  amount: 1_000_000n
});
await oms.privacy.shield(shieldQuote);

// Private send: wallet → recipient, delivered later by the privacy service
const sendQuote = await oms.privacy.quotePrivateSend({
  network: Networks.polygon,
  token: usdc,
  amount: 1_000_000n,
  to: '0x1111111111111111111111111111111111111111'
});
const sent = await oms.privacy.privateSend(sendQuote, { waitForDelivery: true });

// Unshield: private balance → an address (the own wallet by default)
const unshieldQuote = await oms.privacy.quoteUnshield({
  network: Networks.polygon,
  token: usdc,
  amount: 500_000n
});
await oms.privacy.unshield(unshieldQuote);

const balances = await oms.privacy.getBalances();
```

`oms.privacy.networks` lists the networks with private balances: Ethereum, BNB Chain, Polygon, Base
and Arbitrum (mainnets only). Tokens are addresses; the native token is
`0x0000000000000000000000000000000000000000`. Amounts are bigints in base units.

### Quotes

Every operation starts with a quote: `{ kind, network, token, amount, fee, total, to?, expiresAt }`.
`amount` is what arrives, `fee` is the privacy fee in the same token, and `total = amount + fee` is
what leaves the wallet or the private balance. Network fees are separate (below). A quote is valid for
5 minutes, can be used once, and only for the wallet that was active when it was made. Shield has no
privacy fee.

### Wallet transactions and network fees

`shield` and `privateSend` send up to three wallet transactions: an allowance reset to 0, an approval
of exactly `total`, and the deposit. Steps that are not needed are skipped; native-token deposits need
no approval. Each step is reported through `onProgress`: `prepared` with its `txnId` before anything
is submitted, and `confirmed` once it executed. `onProgress` is awaited for `prepared` events, so an
async callback can store the `txnId` durably first; if it throws or rejects, that transaction is not
executed (transactions confirmed earlier in the same operation stay done; reconcile every ID in
`txnIds`). Results list every transaction, with
its `networkFee` when one was paid (sponsored transactions have none).

By default the network fee of each transaction is paid in the token being moved, and the call fails
with `OMS_PRIVACY_NETWORK_FEE` before the transaction executes if the wallet cannot pay it on top
of `total`. Pass
`selectFeeOption` to choose another fee token, and `maxNetworkFee` to cap the fee in the moved
token.

`unshield` and `recover` send no wallet transaction: the privacy service submits the withdrawal, and
its fee is part of the quote. They stop with `OMS_PRIVACY_WALLET_CHANGED` if the active wallet
changed or signed out after the call started, even if the same wallet is active again, before the
withdrawal is handed to the service. Balance reads and quotes fail the same way instead of returning
results for a wallet that is no longer active.

### Private send delivery

A private send deposits `total` into the sender's private balance and pre-authorizes a payment of
`amount` to the recipient, which the privacy service submits later. `deliveryId` identifies it; treat
it as private. Check it with `getDeliveryStatus({ deliveryId })` (`pending`, `delivered` or
`failed`), or pass `waitForDelivery: true` (default timeout 15 minutes). If the status cannot be read
while waiting, the error still carries the `deliveryId` and transaction IDs: the send went through,
so do not send it again. If the deposit executed but the service did not confirm the delivery (a
`delivery`-stage `OMS_PRIVACY_SERVICE_ERROR` without a `deliveryId`), the delivery may still happen:
do not send it again either.

If delivery fails, the funds stay in the sender's private balance as `recoverable` in
`getBalances()`. `recover({ network, token })` pays all of them back to the wallet. Funds also show as
`recoverable` while a delivery is pending; `recover` and the delivery spend the same funds, so only
one of them goes through.

### Errors

Every failure is an `OMSWalletPrivacyError` with a `code` (`OMS_PRIVACY_*`), the `operation`, the
`stage` it reached, and `txnIds`: every wallet transaction created so far. For `shield` and
`privateSend`, an empty `txnIds` means no wallet transaction was sent; otherwise store the IDs and
reconcile: check each with `oms.wallet.getTransactionStatus({ txnId })`, then
`oms.privacy.getBalances()` for funds to recover. `unshield` and `recover` send no wallet
transaction, so their `txnIds` is always empty: when their message says the withdrawal may have been
submitted, check `getBalances()` before trying again.
A failed or timed-out call never re-sends a deposit on its own. `cause` is set only to an
`OMSWalletError` from the wallet; errors from the privacy service are not forwarded.

## API reference

See [API.md](./API.md) for every public function and type.

## How it works and what it trusts

- **Keys.** The private balance's keys are derived from the wallet's signature over a fixed message
  that starts with `OMS Wallet reserved message:`, signed on Polygon. OMS Wallet refuses that
  message in `signMessage`, so code that can only ask the wallet to sign, such as a dApp sending
  `personal_sign` through the wagmi connector, cannot obtain the signature; code that can call
  `OMSWallet.extend`, or any code running in the app itself, can. A smart
  wallet's full signature changes when the wallet is deployed and when its configuration changes
  (for example when remote access is granted, revoked or expires), so keys come only from the part
  that depends on the wallet's own key, the wallet address and the message: the wallet key's ECDSA
  signature inside it. The package decodes that part, requires exactly one such key signature that
  alone meets the wallet's threshold, and has WaaS confirm the full signature before using it; it
  never sends a wallet transaction to set up keys. The keys stay the same as long as WaaS keeps
  the wallet's key and its message-signing scheme unchanged; that is verified for deployment and
  configuration changes, and is an assumption WaaS must uphold for key rotation, recovery and
  signer changes. The package stores a fingerprint of the derived keys (in `localStorage` in
  browsers, in memory elsewhere, or in the `storage` passed to `privacy()`) and stops with
  `OMS_PRIVACY_KEY_MISMATCH` if they change, instead of showing an empty balance. This only
  detects a change where a fingerprint was stored before (the same browser or storage); on a new
  device a changed key would show an empty private balance, and it recovers nothing.
- **Privacy service.** Proofs are generated remotely: the service receives the private balance's
  viewing key, so it can see private balances and history. It cannot move funds: withdrawals are
  authorized by a spending key that stays on the device, and the recipient, amount and fee are part
  of what that key signs. Private sends are delivered by the service's relayer on its schedule.
- **What a deposit can move.** Wallet transactions are limited to approvals of an allowlisted
  contract and one deposit call to an allowlisted contract, in order, and the allowance is left at
  exactly `total` before the deposit, so a deposit can move at most `total`. Beyond that cap, the
  service is trusted to build the intended deposit.
- **Concurrency.** Operations of one wallet run one at a time in a page. Spending the same private
  funds twice from two tabs or devices fails at the protocol level.

## Runtime

Browsers (through a bundler) and Node 22, with no polyfills or bundler settings needed. The privacy
library is loaded on first use; it is large (about 2 MB gzipped). In browsers it needs Node's
`Buffer`, so the package sets `globalThis.Buffer` when the page has none.
In Node it logs to the console and this cannot be turned off. The package keeps one privacy session
per wallet and closes it after a minute without operations, or when the active wallet changes.
