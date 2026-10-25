-- Task 2: accounts, host links, pairing, devices, trials. Times are ms integers; tokens are stored as sha256 base64url only.
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, paddle_customer_id TEXT UNIQUE);
CREATE TABLE magic_links (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, next TEXT, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE TABLE web_sessions (id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
CREATE TABLE host_links (device_code_hash TEXT PRIMARY KEY, user_code TEXT NOT NULL UNIQUE, host_name TEXT NOT NULL, host_pub TEXT NOT NULL, ui_version TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending','approved','denied','consumed')), user_id TEXT, last_poll INTEGER, expires_at INTEGER NOT NULL);
CREATE TABLE hosts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, host_pub TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, ui_version TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE TABLE pairings (id TEXT PRIMARY KEY, host_id TEXT NOT NULL REFERENCES hosts(id), claim_hash TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('open','claimed','confirmed','rejected','burned','expired')), device_id TEXT, mac TEXT, bad_claims INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL);
CREATE TABLE devices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), host_id TEXT NOT NULL REFERENCES hosts(id), pairing_id TEXT NOT NULL REFERENCES pairings(id), name TEXT NOT NULL, pub TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK (state IN ('claimed','active','revoked')), created_at INTEGER NOT NULL, last_seen INTEGER);
CREATE TABLE trials (user_id TEXT PRIMARY KEY REFERENCES users(id), started_at INTEGER NOT NULL, ends_at INTEGER NOT NULL);
-- Survives account deletion (Task 12). user_id becomes NULL on delete.
CREATE TABLE trial_claims (email_key TEXT PRIMARY KEY, user_id TEXT, claimed_at INTEGER NOT NULL);
CREATE TABLE grants (user_id TEXT PRIMARY KEY REFERENCES users(id), plan TEXT NOT NULL CHECK (plan IN ('comp')), until INTEGER NOT NULL, note TEXT);
CREATE TABLE rate (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);
CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, to_addr TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX devices_user ON devices(user_id, state);
CREATE INDEX devices_pairing ON devices(pairing_id);
CREATE INDEX hosts_user ON hosts(user_id);
