import {
  createConfig,
  createStorage,
  connect,
  disconnect,
  reconnect,
  sendTransaction,
  signMessage,
  signTypedData,
  switchChain,
  type Storage
} from '@wagmi/core';
import { describe, expect, it, vi } from 'vitest';
import { http, type Chain, type Hex } from 'viem';

import { OMSWalletTransactionError } from '@polygonlabs/oms-wallet';
import { omsWalletConnector, stringToPersonalSignHex, type OMSWalletLike } from '../src/index.js';

const polygon = {
  id: 137,
  name: 'Polygon',
  nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
  rpcUrls: { default: { http: ['https://polygon.example'] } }
} as const satisfies Chain;

const mainnet = {
  id: 1,
  name: 'Ethereum',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://mainnet.example'] } }
} as const satisfies Chain;

const optimism = {
  id: 10,
  name: 'Optimism',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://optimism.example'] } }
} as const satisfies Chain;

const firstAddress = '0x9999999999999999999999999999999999999999';
const secondAddress = '0x8888888888888888888888888888888888888888';

const networks = [
  {
    id: 137,
    name: 'polygon',
    nativeTokenSymbol: 'POL',
    explorerUrl: 'https://polygonscan.com',
    displayName: 'Polygon'
  },
  {
    id: 1,
    name: 'mainnet',
    nativeTokenSymbol: 'ETH',
    explorerUrl: 'https://etherscan.io',
    displayName: 'Ethereum'
  }
] as const;

describe('omsWalletConnector', () => {
  it('rejects wagmi connect and eth_requestAccounts when there is no active OMS Wallet session', async () => {
    const omsWallet = createOmsWallet();
    const config = createWagmiConfig(omsWallet);

    await expect(
      connect(config, {
        connector: config.connectors[0],
        chainId: polygon.id
      })
    ).rejects.toThrow('Authenticate with the OMS Wallet SDK before connecting through wagmi.');

    const provider = await config.connectors[0].getProvider();
    await expect(
      provider.request({
        method: 'eth_requestAccounts'
      })
    ).rejects.toMatchObject({
      name: 'OMSWalletProviderRpcError',
      code: 4100,
      message:
        'No active OMS Wallet session. Authenticate with the OMS Wallet SDK before connecting through wagmi.'
    });
  });

  it.each([
    { walletType: 'solana', walletAddress: '9xQeWvG816bUx9EPjHmaT23yvVMuZwHngkQF5JC9YjCy' },
    { walletType: 'tron', walletAddress: 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL' },
    { walletType: 'solana', walletAddress: '0x9999999999999999999999999999999999999999' },
    { walletType: 'tron', walletAddress: '0x9999999999999999999999999999999999999999' },
    { walletType: 'ethereum', walletAddress: '0x99999999999999999999999999999999999999' }
  ] as const)('rejects connect for a $walletType wallet at $walletAddress', async (params) => {
    const omsWallet = createOmsWallet(params);
    const config = createWagmiConfig(omsWallet);

    await expect(
      connect(config, {
        connector: config.connectors[0],
        chainId: polygon.id
      })
    ).rejects.toThrow('The active OMS wallet is not an Ethereum wallet.');
  });

  it.each([
    { walletType: 'solana', walletAddress: '9xQeWvG816bUx9EPjHmaT23yvVMuZwHngkQF5JC9YjCy' },
    { walletType: 'tron', walletAddress: 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL' },
    { walletType: 'ethereum', walletAddress: '0x99999999999999999999999999999999999999' }
  ] as const)('is not authorized for a $walletType wallet at $walletAddress', async (params) => {
    const config = createWagmiConfig(createOmsWallet(params));

    await expect(config.connectors[0].isAuthorized()).resolves.toBe(false);
  });

  it('rejects connect when initialChainId is not configured in wagmi', async () => {
    const omsWallet = createOmsWallet({
      walletAddress: '0x9999999999999999999999999999999999999999'
    });
    const config = createConfig({
      chains: [polygon],
      connectors: [omsWalletConnector({ omsWallet, networks, initialChainId: mainnet.id })],
      transports: {
        [polygon.id]: http()
      }
    });

    await expect(connect(config, { connector: config.connectors[0] })).rejects.toThrow(
      'Chain 1 is not configured in wagmi.'
    );
  });

  it('rejects connect when no configured wagmi chain is supported by OMS', async () => {
    const omsWallet = createOmsWallet({
      walletAddress: '0x9999999999999999999999999999999999999999'
    });
    const config = createConfig({
      chains: [optimism],
      connectors: [omsWalletConnector({ omsWallet, networks })],
      transports: {
        [optimism.id]: http()
      }
    });

    await expect(connect(config, { connector: config.connectors[0] })).rejects.toThrow(
      'No wagmi chain is supported by OMS.'
    );
  });

  it('signs messages and typed data through the OMS Wallet', async () => {
    const omsWallet = createOmsWallet({
      walletAddress: '0x9999999999999999999999999999999999999999'
    });
    const config = createWagmiConfig(omsWallet);

    await connect(config, { connector: config.connectors[0] });

    await expect(signMessage(config, { message: 'hello' })).resolves.toBe('0xsigned-message');
    expect(omsWallet.wallet.signMessage).toHaveBeenCalledWith({
      network: networks[0],
      message: 'hello'
    });

    await expect(
      signTypedData(config, {
        domain: { name: 'OMS', chainId: 137 },
        primaryType: 'Mail',
        types: {
          Mail: [{ name: 'contents', type: 'string' }]
        },
        message: { contents: 'hello' }
      })
    ).resolves.toBe('0xsigned-typed-data');

    expect(omsWallet.wallet.signTypedData).toHaveBeenCalledWith({
      network: networks[0],
      typedData: expect.objectContaining({
        domain: { name: 'OMS', chainId: 137 },
        primaryType: 'Mail'
      })
    });
  });

  it('defaults to the exported OMS network registry', async () => {
    const omsWallet = createOmsWallet({
      walletAddress: '0x9999999999999999999999999999999999999999'
    });
    const config = createConfig({
      chains: [polygon],
      connectors: [omsWalletConnector({ omsWallet })],
      transports: {
        [polygon.id]: http()
      }
    });

    await connect(config, { connector: config.connectors[0] });
    await signMessage(config, { message: 'hello' });

    expect(omsWallet.wallet.signMessage).toHaveBeenCalledWith({
      network: expect.objectContaining({
        id: polygon.id,
        name: 'polygon'
      }),
      message: 'hello'
    });
  });

  it('rejects provider signing validation errors before calling OMS', async () => {
    const omsWallet = createOmsWallet({
      walletAddress: '0x9999999999999999999999999999999999999999'
    });
    const config = createWagmiConfig(omsWallet);

    await connect(config, { connector: config.connectors[0] });
    const provider = await config.connectors[0].getProvider();

    await expect(
      provider.request({
        method: 'personal_sign',
        params: { message: 'hello' }
      })
    ).rejects.toMatchObject({
      name: 'OMSWalletProviderRpcError',
      code: -32602,
      message: 'personal_sign requires positional parameters.'
    });
    await expect(
      provider.request({
        method: 'personal_sign',
        params: [123, omsWallet.wallet.activeWallet?.address]
      })
    ).rejects.toMatchObject({
      name: 'OMSWalletProviderRpcError',
      code: -32602,
      message: 'Signing message must be a string.'
    });
    await expect(
      provider.request({
        method: 'eth_signTypedData_v4',
        params: [omsWallet.wallet.activeWallet?.address, '{']
      })
    ).rejects.toMatchObject({
      name: 'OMSWalletProviderRpcError',
      code: -32602,
      message: 'Typed data must be JSON when passed as a string.'
    });
    await expect(
      provider.request({
        method: 'eth_signTypedData_v4',
        params: ['0x1111111111111111111111111111111111111111', { message: 'hello' }]
      })
    ).rejects.toMatchObject({
      name: 'OMSWalletProviderRpcError',
      code: 4100,
      message:
        'eth_signTypedData_v4 requested 0x1111111111111111111111111111111111111111, but the active OMS Wallet is 0x9999999999999999999999999999999999999999.'
    });
    expect(omsWallet.wallet.signMessage).not.toHaveBeenCalled();
    expect(omsWallet.wallet.signTypedData).not.toHaveBeenCalled();
  });

  it('sends transactions through the OMS Wallet and returns the EVM transaction hash', async () => {
    const omsWallet = createOmsWallet({
      walletAddress: '0x9999999999999999999999999999999999999999'
    });
    const config = createWagmiConfig(omsWallet);

    await connect(config, { connector: config.connectors[0] });

    await expect(
      sendTransaction(config, {
        to: '0x1111111111111111111111111111111111111111',
        value: 1n
      })
    ).resolves.toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    expect(omsWallet.wallet.sendTransaction).toHaveBeenCalledWith({
      network: networks[0],
      to: '0x1111111111111111111111111111111111111111',
      value: 1n,
      data: undefined,
      waitForStatus: true
    });
  });

  it('rejects provider transaction validation errors before calling OMS', async () => {
    const omsWallet = createOmsWallet({
      walletAddress: '0x9999999999999999999999999999999999999999'
    });
    const config = createWagmiConfig(omsWallet);
    const connector = config.connectors[0];

    await connect(config, { connector });
    const provider = await connector.getProvider();

    await expect(
      provider.request({
        method: 'eth_sendTransaction',
        params: { to: '0x1111111111111111111111111111111111111111' }
      })
    ).rejects.toMatchObject({
      name: 'OMSWalletProviderRpcError',
      code: -32602,
      message: 'eth_sendTransaction requires positional parameters.'
    });
    await expect(
      provider.request({
        method: 'eth_sendTransaction',
        params: [
          {
            from: omsWallet.wallet.activeWallet?.address,
            value: '0x1'
          }
        ]
      })
    ).rejects.toMatchObject({
      name: 'OMSWalletProviderRpcError',
      code: 4200,
      message:
        'Unsupported OMS provider method: eth_sendTransaction without a recipient address; contract deployment is not supported by the current OMS Wallet SDK.'
    });
    await expect(
      provider.request({
        method: 'eth_sendTransaction',
        params: [
          {
            from: omsWallet.wallet.activeWallet?.address,
            to: 'not-an-address',
            value: '0x1'
          }
        ]
      })
    ).rejects.toMatchObject({
      name: 'OMSWalletProviderRpcError',
      code: 4200,
      message:
        'Unsupported OMS provider method: eth_sendTransaction without a recipient address; contract deployment is not supported by the current OMS Wallet SDK.'
    });
    await expect(
      provider.request({
        method: 'eth_sendTransaction',
        params: [
          {
            from: omsWallet.wallet.activeWallet?.address,
            to: '0x1111111111111111111111111111111111111111',
            value: '0x1',
            chainId: 'not-a-chain'
          }
        ]
      })
    ).rejects.toMatchObject({
      name: 'OMSWalletProviderRpcError',
      code: -32602,
      message: 'Chain ID must be a positive safe integer.'
    });
    expect(omsWallet.wallet.sendTransaction).not.toHaveBeenCalled();
  });

  it('rejects non-quantity transaction values at the provider boundary', async () => {
    const omsWallet = createOmsWallet({
      walletAddress: '0x9999999999999999999999999999999999999999'
    });
    const config = createWagmiConfig(omsWallet);
    const connector = config.connectors[0];

    await connect(config, { connector });
    const provider = await connector.getProvider();

    await expect(
      provider.request({
        method: 'eth_sendTransaction',
        params: [
          {
            from: omsWallet.wallet.activeWallet?.address,
            to: '0x1111111111111111111111111111111111111111',
            value: 1
          }
        ]
      })
    ).rejects.toThrow('Transaction value must be a JSON-RPC quantity hex string.');
    expect(omsWallet.wallet.sendTransaction).not.toHaveBeenCalled();
  });

  it('uses a transaction request chainId without switching the connector chain', async () => {
    const omsWallet = createOmsWallet({
      walletAddress: '0x9999999999999999999999999999999999999999'
    });
    const config = createWagmiConfig(omsWallet);
    const connector = config.connectors[0];

    await connect(config, { connector });
    await expect(
      sendTransaction(config, {
        chainId: mainnet.id,
        to: '0x1111111111111111111111111111111111111111',
        value: 1n
      })
    ).resolves.toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    expect(omsWallet.wallet.sendTransaction).toHaveBeenCalledWith({
      network: networks[1],
      to: '0x1111111111111111111111111111111111111111',
      value: 1n,
      data: undefined,
      waitForStatus: true
    });
    await expect(connector.getChainId()).resolves.toBe(polygon.id);
  });

  it('resolves transaction options per wagmi transaction request', async () => {
    const omsWallet = createOmsWallet({
      walletAddress: '0x9999999999999999999999999999999999999999'
    });
    const selectFeeOption = vi.fn(async () => ({ token: 'USDC' }));
    const transactionOptions = vi.fn(() => ({
      selectFeeOption,
      statusPolling: { timeoutMs: 10_000 }
    }));
    const config = createWagmiConfig(omsWallet, { transactionOptions });

    await connect(config, { connector: config.connectors[0] });
    await sendTransaction(config, {
      chainId: mainnet.id,
      to: '0x1111111111111111111111111111111111111111',
      value: 1n
    });

    expect(transactionOptions).toHaveBeenCalledWith({
      chainId: mainnet.id,
      request: expect.objectContaining({
        from: '0x9999999999999999999999999999999999999999',
        to: '0x1111111111111111111111111111111111111111',
        value: '0x1'
      })
    });
    expect(omsWallet.wallet.sendTransaction).toHaveBeenCalledWith({
      network: networks[1],
      to: '0x1111111111111111111111111111111111111111',
      value: 1n,
      data: undefined,
      selectFeeOption,
      waitForStatus: true,
      statusPolling: { timeoutMs: 10_000 }
    });
  });

  it('rejects waitForStatus false because wagmi sendTransaction requires a hash', async () => {
    const omsWallet = createOmsWallet({
      walletAddress: '0x9999999999999999999999999999999999999999'
    });
    const config = createWagmiConfig(omsWallet, {
      transactionOptions: {
        waitForStatus: false
      } as never
    });

    await connect(config, { connector: config.connectors[0] });

    await expect(
      sendTransaction(config, {
        to: '0x1111111111111111111111111111111111111111',
        value: 1n
      })
    ).rejects.toThrow('waitForStatus: false is not supported');
    expect(omsWallet.wallet.sendTransaction).not.toHaveBeenCalled();
  });

  it('rejects with the OMS response when a sent transaction has no EVM hash', async () => {
    const omsWallet = createOmsWallet({
      walletAddress: '0x9999999999999999999999999999999999999999'
    });
    omsWallet.wallet.sendTransaction = vi.fn(async () => ({
      txnId: 'txn-without-hash',
      status: 'pending'
    }));
    const config = createWagmiConfig(omsWallet);

    await connect(config, { connector: config.connectors[0] });

    await expect(
      sendTransaction(config, {
        to: '0x1111111111111111111111111111111111111111',
        value: 1n
      })
    ).rejects.toMatchObject({
      message: expect.stringContaining('OMS transaction id: txn-without-hash'),
      cause: expect.objectContaining({
        code: -32603,
        cause: expect.objectContaining({
          code: -32603,
          data: expect.objectContaining({
            txnId: 'txn-without-hash'
          })
        })
      })
    });
  });

  it('rejects transactions for wagmi-configured chains that OMS does not support', async () => {
    const omsWallet = createOmsWallet({
      walletAddress: '0x9999999999999999999999999999999999999999'
    });
    const config = createConfig({
      chains: [polygon, optimism],
      connectors: [omsWalletConnector({ omsWallet, networks })],
      transports: {
        [polygon.id]: http(),
        [optimism.id]: http()
      }
    });
    const connector = config.connectors[0];

    await connect(config, { connector });
    const provider = await connector.getProvider();

    await expect(
      provider.request({
        method: 'eth_sendTransaction',
        params: [
          {
            from: omsWallet.wallet.activeWallet?.address,
            to: '0x1111111111111111111111111111111111111111',
            value: '0x1',
            chainId: '0xa'
          }
        ]
      })
    ).rejects.toMatchObject({
      name: 'OMSWalletProviderRpcError',
      code: 4901,
      message: 'OMS does not support chain 10.'
    });
    expect(omsWallet.wallet.sendTransaction).not.toHaveBeenCalled();
  });

  it('wraps SDK transaction failures as provider RPC errors', async () => {
    const omsWallet = createOmsWallet({
      walletAddress: '0x9999999999999999999999999999999999999999'
    });
    const sdkError = createTransactionExecutionError();
    omsWallet.wallet.sendTransaction = vi.fn(async () => {
      throw sdkError;
    });
    const config = createWagmiConfig(omsWallet);
    const connector = config.connectors[0];
    const expectedSdkErrorData = expect.objectContaining({
      name: 'OMSWalletTransactionError',
      code: 'OMS_TRANSACTION_EXECUTION_UNCONFIRMED',
      operation: 'wallet.execute',
      retryable: false,
      txnId: 'txn-execute',
      upstreamError: expect.objectContaining({
        service: 'waas',
        name: 'WebrpcRequestFailed',
        code: '-1'
      })
    });

    await connect(config, { connector });
    const provider = await connector.getProvider();

    await expect(
      provider.request({
        method: 'eth_sendTransaction',
        params: [
          {
            from: omsWallet.wallet.activeWallet?.address,
            to: '0x1111111111111111111111111111111111111111',
            value: '0x1'
          }
        ]
      })
    ).rejects.toMatchObject({
      name: 'OMSWalletProviderRpcError',
      code: -32603,
      message: 'Transaction execution failed before status could be confirmed',
      data: expectedSdkErrorData
    });

    // The same provider RPC error must survive wagmi's own sendTransaction error wrapping.
    const wagmiError = await sendTransaction(config, {
      to: '0x1111111111111111111111111111111111111111',
      value: 1n
    }).catch((error: unknown) => error);
    expect(
      findCause(wagmiError, (cause) => cause.name === 'OMSWalletProviderRpcError')
    ).toMatchObject({
      code: -32603,
      data: expectedSdkErrorData
    });
  });

  it('ignores wallet-managed transaction fields when sending transactions', async () => {
    const omsWallet = createOmsWallet({
      walletAddress: '0x9999999999999999999999999999999999999999'
    });
    const config = createWagmiConfig(omsWallet);
    const connector = config.connectors[0];

    await connect(config, { connector });
    const provider = await connector.getProvider();

    await expect(
      provider.request({
        method: 'eth_sendTransaction',
        params: [
          {
            from: omsWallet.wallet.activeWallet?.address,
            to: '0x1111111111111111111111111111111111111111',
            value: '0x1',
            gas: '0x5208',
            gasPrice: '0x1',
            maxFeePerGas: '0x2',
            maxPriorityFeePerGas: '0x1',
            nonce: '0x0',
            type: '0x2',
            accessList: []
          }
        ]
      })
    ).resolves.toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(omsWallet.wallet.sendTransaction).toHaveBeenCalledWith({
      network: networks[0],
      to: '0x1111111111111111111111111111111111111111',
      value: 1n,
      waitForStatus: true
    });
  });

  it('rejects unknown transaction fields', async () => {
    const omsWallet = createOmsWallet({
      walletAddress: '0x9999999999999999999999999999999999999999'
    });
    const config = createWagmiConfig(omsWallet);
    const connector = config.connectors[0];

    await connect(config, { connector });
    const provider = await connector.getProvider();

    await expect(
      provider.request({
        method: 'eth_sendTransaction',
        params: [
          {
            from: omsWallet.wallet.activeWallet?.address,
            to: '0x1111111111111111111111111111111111111111',
            customField: '0x1'
          }
        ]
      })
    ).rejects.toThrow('unsupported fields: customField');
    expect(omsWallet.wallet.sendTransaction).not.toHaveBeenCalled();
  });

  it('rejects provider requests for a different account', async () => {
    const omsWallet = createOmsWallet({
      walletAddress: '0x9999999999999999999999999999999999999999'
    });
    const config = createWagmiConfig(omsWallet);
    const connector = config.connectors[0];

    await connect(config, { connector });
    const provider = await connector.getProvider();

    await expect(
      provider.request({
        method: 'personal_sign',
        params: [stringToPersonalSignHex('hello'), '0x1111111111111111111111111111111111111111']
      })
    ).rejects.toMatchObject({
      code: 4100
    });
    await expect(
      provider.request({
        method: 'eth_sendTransaction',
        params: [
          {
            from: '0x1111111111111111111111111111111111111111',
            to: '0x2222222222222222222222222222222222222222'
          }
        ]
      })
    ).rejects.toMatchObject({
      code: 4100
    });
  });

  it('switches the OMS network used for signing and transactions', async () => {
    const omsWallet = createOmsWallet({
      walletAddress: '0x9999999999999999999999999999999999999999'
    });
    const config = createWagmiConfig(omsWallet);

    await connect(config, { connector: config.connectors[0] });
    await switchChain(config, { chainId: mainnet.id });
    await signMessage(config, { message: 'hello' });

    expect(omsWallet.wallet.signMessage).toHaveBeenLastCalledWith({
      network: networks[1],
      message: 'hello'
    });
  });

  it('syncs wagmi state when the provider switches chains directly', async () => {
    const omsWallet = createOmsWallet({
      walletAddress: '0x9999999999999999999999999999999999999999'
    });
    const config = createWagmiConfig(omsWallet);
    const connector = config.connectors[0];

    await connect(config, { connector });
    const provider = await connector.getProvider();
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x1' }]
    });

    expect(config.state.connections.get(config.state.current!)?.chainId).toBe(mainnet.id);
    await expect(connector.getChainId()).resolves.toBe(mainnet.id);
  });

  it('rejects provider chain switches to OMS-supported chains that are not configured in wagmi', async () => {
    const omsWallet = createOmsWallet({
      walletAddress: '0x9999999999999999999999999999999999999999'
    });
    const config = createConfig({
      chains: [polygon],
      connectors: [omsWalletConnector({ omsWallet, networks })],
      transports: {
        [polygon.id]: http()
      }
    });
    const connector = config.connectors[0];

    await connect(config, { connector });
    const provider = await connector.getProvider();
    await expect(
      provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0x1' }]
      })
    ).rejects.toMatchObject({
      code: 4901
    });

    expect(config.state.connections.get(config.state.current!)?.chainId).toBe(polygon.id);
    await expect(connector.getChainId()).resolves.toBe(polygon.id);
  });

  it('rejects provider chain switches to wagmi-configured chains that OMS does not support', async () => {
    const omsWallet = createOmsWallet({
      walletAddress: '0x9999999999999999999999999999999999999999'
    });
    const config = createConfig({
      chains: [polygon, optimism],
      connectors: [omsWalletConnector({ omsWallet, networks })],
      transports: {
        [polygon.id]: http(),
        [optimism.id]: http()
      }
    });
    const connector = config.connectors[0];

    await connect(config, { connector });
    const provider = await connector.getProvider();
    await expect(
      provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0xa' }]
      })
    ).rejects.toMatchObject({
      name: 'OMSWalletProviderRpcError',
      code: 4901,
      message: 'OMS does not support chain 10.'
    });

    expect(config.state.connections.get(config.state.current!)?.chainId).toBe(polygon.id);
    await expect(connector.getChainId()).resolves.toBe(polygon.id);
  });

  it('rejects wagmi switchChain calls to wagmi-configured chains that OMS does not support', async () => {
    const omsWallet = createOmsWallet({
      walletAddress: '0x9999999999999999999999999999999999999999'
    });
    const config = createConfig({
      chains: [polygon, optimism],
      connectors: [omsWalletConnector({ omsWallet, networks })],
      transports: {
        [polygon.id]: http(),
        [optimism.id]: http()
      }
    });
    const connector = config.connectors[0];

    await connect(config, { connector });

    await expect(switchChain(config, { chainId: optimism.id })).rejects.toThrow(
      'OMS does not support chain 10.'
    );
    expect(config.state.connections.get(config.state.current!)?.chainId).toBe(polygon.id);
    await expect(connector.getChainId()).resolves.toBe(polygon.id);
  });

  it('uses and validates initialChainId', async () => {
    const omsWallet = createOmsWallet({
      walletAddress: '0x9999999999999999999999999999999999999999'
    });
    const config = createWagmiConfig(omsWallet, { initialChainId: mainnet.id });

    await connect(config, { connector: config.connectors[0] });
    await signMessage(config, { message: 'hello' });

    expect(omsWallet.wallet.signMessage).toHaveBeenCalledWith({
      network: networks[1],
      message: 'hello'
    });
  });

  it('rejects initialChainId when OMS does not support it', async () => {
    const omsWallet = createOmsWallet({
      walletAddress: '0x9999999999999999999999999999999999999999'
    });
    const config = createConfig({
      chains: [polygon, optimism],
      connectors: [omsWalletConnector({ omsWallet, networks, initialChainId: optimism.id })],
      transports: {
        [polygon.id]: http(),
        [optimism.id]: http()
      }
    });

    await expect(config.connectors[0].getChainId()).resolves.toBe(polygon.id);
    const provider = await config.connectors[0].getProvider();
    await expect(provider.request({ method: 'eth_chainId' })).resolves.toBe('0x89');
    await expect(connect(config, { connector: config.connectors[0] })).rejects.toThrow(
      'OMS does not support chain 10.'
    );
  });

  it('disconnects wagmi without signing out the OMS Wallet', async () => {
    const omsWallet = createOmsWallet({
      walletAddress: '0x9999999999999999999999999999999999999999'
    });
    const config = createWagmiConfig(omsWallet);
    const connector = config.connectors[0];

    await connect(config, { connector });
    await disconnect(config);

    expect(omsWallet.wallet.signOut).not.toHaveBeenCalled();
    expect(omsWallet.wallet.activeWallet?.address).toBe(
      '0x9999999999999999999999999999999999999999'
    );
    await expect(connector.isAuthorized()).resolves.toBe(false);
    await expect(connector.getAccounts()).rejects.toThrow('Connector not connected.');

    await expect(connect(config, { connector })).resolves.toMatchObject({
      accounts: ['0x9999999999999999999999999999999999999999']
    });
  });

  it('does not reconnect automatically after disconnecting and refreshing', async () => {
    const omsWallet = createOmsWallet({
      walletAddress: '0x9999999999999999999999999999999999999999'
    });
    const storage = createMemoryStorage();
    const config = createWagmiConfig(omsWallet, {}, storage);
    const connector = config.connectors[0];

    await connect(config, { connector });
    await disconnect(config);

    const refreshedConfig = createWagmiConfig(omsWallet, {}, storage);
    const refreshedConnector = refreshedConfig.connectors[0];
    await expect(refreshedConnector.isAuthorized()).resolves.toBe(false);
    await expect(reconnect(refreshedConfig)).resolves.toEqual([]);
    expect(refreshedConfig.state.status).toBe('disconnected');

    await expect(
      connect(refreshedConfig, { connector: refreshedConnector })
    ).resolves.toMatchObject({
      accounts: ['0x9999999999999999999999999999999999999999']
    });
    await expect(refreshedConnector.isAuthorized()).resolves.toBe(true);
  });

  it('follows the session only while connected', async () => {
    // For example a config built again on every hot reload against one long-lived OMSWallet.
    const omsWallet = createOmsWallet();
    for (let built = 0; built < 5; built += 1) createWagmiConfig(omsWallet);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(omsWallet.sessionListenerCount()).toBe(0);

    const config = createWagmiConfig(omsWallet);
    const connector = config.connectors[0];
    // A connect that fails (no session yet) leaves no listener either.
    await expect(connect(config, { connector })).rejects.toThrow();
    expect(omsWallet.sessionListenerCount()).toBe(0);

    omsWallet.wallet.activeWallet = activeWallet(firstAddress);
    await connect(config, { connector });
    expect(omsWallet.sessionListenerCount()).toBe(1);
    await disconnect(config);
    expect(omsWallet.sessionListenerCount()).toBe(0);
  });

  it('disconnects when the session ends, and stays disconnected after a later sign-in', async () => {
    const omsWallet = createOmsWallet({ walletAddress: firstAddress });
    const storage = createMemoryStorage();
    const config = createWagmiConfig(omsWallet, {}, storage);
    const connector = config.connectors[0];
    await connect(config, { connector });

    omsWallet.changeSession(undefined);
    expect(config.state.status).toBe('disconnected');
    expect(omsWallet.sessionListenerCount()).toBe(0);

    // Signing in again does not reconnect wagmi, here or after a reload; the app calls connect.
    omsWallet.changeSession(activeWallet(firstAddress));
    await expect(connector.isAuthorized()).resolves.toBe(false);
    const refreshedConfig = createWagmiConfig(omsWallet, {}, storage);
    await expect(reconnect(refreshedConfig)).resolves.toEqual([]);
  });

  it('changes the account when another Ethereum wallet becomes active, and nothing else', async () => {
    const omsWallet = createOmsWallet({ walletAddress: firstAddress });
    const config = createWagmiConfig(omsWallet);
    const connector = config.connectors[0];
    await connect(config, { connector });
    const changes = vi.fn();
    connector.emitter.on('change', changes);

    // The same wallet again (for example an expiry update) changes nothing.
    omsWallet.changeSession(activeWallet(firstAddress));
    omsWallet.changeSession(activeWallet(secondAddress));

    expect(changes.mock.calls.map(([data]) => data.accounts)).toEqual([[secondAddress]]);
    expect(config.state.status).toBe('connected');
  });

  it('disconnects when a non-Ethereum wallet becomes active', async () => {
    const omsWallet = createOmsWallet({ walletAddress: firstAddress });
    const config = createWagmiConfig(omsWallet);
    await connect(config, { connector: config.connectors[0] });

    omsWallet.changeSession(activeWallet('3gFktQX6vki5M2DzN8Y1ESPUJ4fJ8o6hVQWf8vYvPypD', 'solana'));

    expect(config.state.status).toBe('disconnected');
  });

  it("follows a sign-out in a tab still connected after another tab's wagmi disconnected", async () => {
    // wagmi storage, and so its disconnected flag, is shared by the tabs.
    const omsWallet = createOmsWallet({ walletAddress: firstAddress });
    const storage = createMemoryStorage();
    const tabA = createWagmiConfig(omsWallet, {}, storage);
    const tabB = createWagmiConfig(omsWallet, {}, storage);
    await connect(tabA, { connector: tabA.connectors[0] });
    await connect(tabB, { connector: tabB.connectors[0] });
    await disconnect(tabA);

    omsWallet.changeSession(undefined);

    expect(tabB.state.status).toBe('disconnected');
  });

  it('decodes personal_sign hex payloads before passing them to OMS', async () => {
    const omsWallet = createOmsWallet({
      walletAddress: '0x9999999999999999999999999999999999999999'
    });
    const connector = omsWalletConnector({ omsWallet, networks });
    const config = createConfig({
      chains: [polygon],
      connectors: [connector],
      transports: { [polygon.id]: http() }
    });
    const [configuredConnector] = config.connectors;

    await connect(config, { connector: configuredConnector });
    const provider = await configuredConnector.getProvider();
    await provider.request({
      method: 'personal_sign',
      params: [stringToPersonalSignHex('hello'), omsWallet.wallet.activeWallet?.address]
    });

    expect(omsWallet.wallet.signMessage).toHaveBeenCalledWith({
      network: networks[0],
      message: 'hello'
    });
  });

  it('rejects raw byte personal_sign payloads that OMS cannot sign as text', async () => {
    const omsWallet = createOmsWallet({
      walletAddress: '0x9999999999999999999999999999999999999999'
    });
    const config = createWagmiConfig(omsWallet);
    const connector = config.connectors[0];

    await connect(config, { connector });
    const provider = await connector.getProvider();
    await expect(
      provider.request({
        method: 'personal_sign',
        params: ['0xff', omsWallet.wallet.activeWallet?.address]
      })
    ).rejects.toThrow('Signing raw byte messages is not supported');
    expect(omsWallet.wallet.signMessage).not.toHaveBeenCalled();
  });

  it.each([
    { method: 'eth_sign', params: '0x68656c6c6f', signer: 'signMessage' },
    { method: 'eth_signTypedData', params: '{}', signer: 'signTypedData' }
  ] as const)(
    'rejects legacy $method instead of signing through OMS Wallet',
    async ({ method, params, signer }) => {
      const omsWallet = createOmsWallet({
        walletAddress: '0x9999999999999999999999999999999999999999'
      });
      const config = createWagmiConfig(omsWallet);
      const connector = config.connectors[0];

      await connect(config, { connector });
      const provider = await connector.getProvider();
      await expect(
        provider.request({
          method,
          params: [omsWallet.wallet.activeWallet?.address, params]
        })
      ).rejects.toMatchObject({ code: 4200 });
      expect(omsWallet.wallet[signer]).not.toHaveBeenCalled();
    }
  );
});

function createWagmiConfig(
  omsWallet: OMSWalletLike,
  options: Partial<Parameters<typeof omsWalletConnector>[0]> = {},
  storage?: Storage | null
) {
  return createConfig({
    chains: [polygon, mainnet],
    connectors: [omsWalletConnector({ omsWallet, networks, ...options })],
    storage,
    transports: {
      [polygon.id]: http(),
      [mainnet.id]: http()
    }
  });
}

function findCause(error: unknown, matches: (cause: { name?: unknown }) => boolean): unknown {
  for (let current = error; current; current = (current as { cause?: unknown }).cause) {
    if (typeof current === 'object' && matches(current as { name?: unknown })) return current;
  }
  return undefined;
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return createStorage({
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      }
    }
  });
}

function createTransactionExecutionError(): OMSWalletTransactionError {
  return new OMSWalletTransactionError({
    code: 'OMS_TRANSACTION_EXECUTION_UNCONFIRMED',
    operation: 'wallet.execute',
    txnId: 'txn-execute',
    retryable: false,
    upstreamError: {
      service: 'waas',
      name: 'WebrpcRequestFailed',
      code: '-1',
      message: 'request failed'
    },
    message: 'Transaction execution failed before status could be confirmed'
  });
}

function activeWallet(
  address: string | undefined,
  type: 'ethereum' | 'solana' | 'tron' = 'ethereum'
): OMSWalletLike['wallet']['activeWallet'] {
  return address ? { type, address } : undefined;
}

interface TestOMSWallet extends OMSWalletLike {
  wallet: OMSWalletLike['wallet'] & {
    signOut: ReturnType<typeof vi.fn>;
    signMessage: ReturnType<typeof vi.fn>;
    signTypedData: ReturnType<typeof vi.fn>;
    sendTransaction: ReturnType<typeof vi.fn>;
  };
  /** Makes `nextWallet` the active wallet and reports the change to session listeners. */
  changeSession(nextWallet: OMSWalletLike['wallet']['activeWallet']): void;
  sessionListenerCount(): number;
}

type SessionListener = Parameters<OMSWalletLike['wallet']['onSessionChange']>[0];

function createOmsWallet(
  params: { walletAddress?: string; walletType?: 'ethereum' | 'solana' | 'tron' } = {}
): TestOMSWallet {
  const sessionListeners = new Set<SessionListener>();
  const wallet = {
    activeWallet: activeWallet(params.walletAddress, params.walletType),
    signOut: vi.fn(async () => {
      wallet.activeWallet = undefined;
    }),
    signMessage: vi.fn(async () => '0xsigned-message'),
    signTypedData: vi.fn(async () => '0xsigned-typed-data'),
    sendTransaction: vi.fn(async () => ({
      txnId: 'txn-1',
      status: 'executed',
      txnHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hex
    })),
    onSessionChange(listener: SessionListener) {
      sessionListeners.add(listener);
      return () => {
        sessionListeners.delete(listener);
      };
    }
  };

  return {
    wallet,
    changeSession(nextWallet) {
      wallet.activeWallet = nextWallet;
      for (const listener of Array.from(sessionListeners)) {
        void listener({ activeWallet: nextWallet });
      }
    },
    sessionListenerCount() {
      return sessionListeners.size;
    }
  };
}
