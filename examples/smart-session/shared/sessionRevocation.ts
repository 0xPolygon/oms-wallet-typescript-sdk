export interface SessionRevocationMessageParams {
  origin: string;
  credentialId: string;
  sessionId: string;
  walletAddress: string;
  chainId: number;
}

export function createSessionRevocationMessage(params: SessionRevocationMessageParams): string {
  return [
    'OMS Smart Session Revocation',
    `Origin: ${new URL(params.origin).origin}`,
    `Wallet: ${params.walletAddress.toLowerCase()}`,
    `RAC credential: ${params.credentialId}`,
    `Session: ${params.sessionId}`,
    `Chain ID: ${params.chainId}`,
    'Action: record-revoked'
  ].join('\n');
}
