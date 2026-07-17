import type {
  WalletType as GeneratedWalletType,
  FeeOption as GeneratedFeeOption,
  FeeOptionSelection as GeneratedFeeOptionSelection,
  TransactionStatusResponse as GeneratedTransactionStatusResponse
} from '../generated/waas.gen.js';
import type {
  FeeOption,
  FeeOptionSelection,
  OidcAuthMode,
  TransactionStatusResponse,
  WalletType as PublicWalletType
} from '../types/waas.js';

import {
  AuthMode as GeneratedAuthMode,
  TransactionMode as GeneratedTransactionMode,
  TransactionStatus as GeneratedTransactionStatus
} from '../generated/waas.gen.js';
import { AuthMode, TransactionMode, TransactionStatus } from '../types/waas.js';

export function toGeneratedAuthMode(authMode: OidcAuthMode): GeneratedAuthMode {
  switch (authMode) {
    case AuthMode.AuthCode:
      return GeneratedAuthMode.AuthCode;
    case AuthMode.AuthCodePKCE:
      return GeneratedAuthMode.AuthCodePKCE;
  }
}

export function toGeneratedWalletType(walletType: PublicWalletType): GeneratedWalletType {
  return walletType as GeneratedWalletType;
}

export function fromGeneratedWalletType(walletType: GeneratedWalletType): PublicWalletType {
  return walletType as PublicWalletType;
}

export function toGeneratedTransactionMode(mode: TransactionMode): GeneratedTransactionMode {
  switch (mode) {
    case TransactionMode.Native:
      return GeneratedTransactionMode.Native;
    case TransactionMode.Relayer:
      return GeneratedTransactionMode.Relayer;
  }
}

export function fromGeneratedTransactionStatus(
  status: GeneratedTransactionStatus
): TransactionStatus {
  switch (status) {
    case GeneratedTransactionStatus.Quoted:
      return 'quoted';
    case GeneratedTransactionStatus.Pending:
      return 'pending';
    case GeneratedTransactionStatus.Executed:
      return 'executed';
    case GeneratedTransactionStatus.Failed:
      return 'failed';
    default:
      return TransactionStatus.Unknown;
  }
}

export function fromGeneratedTransactionStatusResponse(
  response: GeneratedTransactionStatusResponse
): TransactionStatusResponse {
  return {
    status: fromGeneratedTransactionStatus(response.status),
    txnHash: response.txnHash
  };
}

export function fromGeneratedFeeOption(feeOption: GeneratedFeeOption): FeeOption {
  return {
    token: { ...feeOption.token },
    value: feeOption.value,
    displayValue: feeOption.displayValue
  };
}

export function toGeneratedFeeOptionSelection(
  selection: FeeOptionSelection
): GeneratedFeeOptionSelection {
  return { token: selection.token };
}
