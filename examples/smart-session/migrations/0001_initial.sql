CREATE TABLE backend_racs (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  private_key TEXT,
  signer_id TEXT,
  credential_id TEXT,
  registered_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY,
  rac_id TEXT NOT NULL,
  token TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  credential_id TEXT NOT NULL,
  network_id TEXT NOT NULL CHECK (network_id IN ('polygon-amoy', 'polygon')),
  asset_id TEXT NOT NULL CHECK (asset_id IN ('pol', 'usdc', 'usdt')),
  recipient_mode TEXT NOT NULL CHECK (recipient_mode IN ('specific', 'any')),
  recipients TEXT NOT NULL,
  allowance TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved')),
  wallet_id TEXT,
  wallet_address TEXT,
  session_id TEXT,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  rejected_at TEXT,
  CHECK (network_id = 'polygon' OR asset_id = 'pol'),
  FOREIGN KEY (rac_id) REFERENCES backend_racs(id)
);

CREATE INDEX approval_requests_rac_created_at
  ON approval_requests (rac_id, created_at DESC);

CREATE TABLE smart_sessions (
  id TEXT PRIMARY KEY,
  rac_id TEXT NOT NULL,
  approval_id TEXT NOT NULL UNIQUE,
  wallet_id TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  session_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  network_id TEXT NOT NULL CHECK (network_id IN ('polygon-amoy', 'polygon')),
  asset_id TEXT NOT NULL CHECK (asset_id IN ('pol', 'usdc', 'usdt')),
  recipient_mode TEXT NOT NULL CHECK (recipient_mode IN ('specific', 'any')),
  recipients TEXT NOT NULL,
  allowance TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  revoked_at TEXT,
  CHECK (network_id = 'polygon' OR asset_id = 'pol'),
  FOREIGN KEY (rac_id) REFERENCES backend_racs(id),
  FOREIGN KEY (approval_id) REFERENCES approval_requests(id)
);

CREATE UNIQUE INDEX smart_sessions_wallet_session
  ON smart_sessions (wallet_id, session_id);

CREATE INDEX smart_sessions_rac_created_at
  ON smart_sessions (rac_id, created_at DESC);

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  smart_session_id TEXT NOT NULL,
  txn_id TEXT NOT NULL UNIQUE,
  recipient TEXT NOT NULL,
  amount TEXT NOT NULL,
  status TEXT NOT NULL,
  txn_hash TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (smart_session_id) REFERENCES smart_sessions(id)
);

CREATE INDEX transactions_smart_session_created_at
  ON transactions (smart_session_id, created_at DESC);

CREATE TABLE rac_nonces (
  signer_id TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
