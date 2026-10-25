-- Task 9: Paddle subscriptions, processed webhook events, refunds/chargebacks, operator alerts. Times are ms integers.
CREATE TABLE subscriptions (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), customer_id TEXT, status TEXT NOT NULL, price_id TEXT, period_end INTEGER, canceled_at INTEGER, past_due_since INTEGER, scheduled_cancel INTEGER NOT NULL DEFAULT 0, last_event_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE paddle_events (event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, occurred_at INTEGER NOT NULL, received_at INTEGER NOT NULL, outcome TEXT NOT NULL);
CREATE TABLE refunds (adjustment_id TEXT PRIMARY KEY, transaction_id TEXT, subscription_id TEXT, action TEXT NOT NULL, status TEXT NOT NULL, full INTEGER NOT NULL DEFAULT 0, cancel_done_at INTEGER, last_event_at INTEGER NOT NULL);
CREATE TABLE ops_alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref TEXT, detail TEXT, created_at INTEGER NOT NULL, resolved_at INTEGER);
-- Task 10 uses this (no second subscription while a checkout is open).
CREATE TABLE checkout_intents (user_id TEXT PRIMARY KEY REFERENCES users(id), plan TEXT NOT NULL, completed_at INTEGER, expires_at INTEGER NOT NULL);
CREATE INDEX subscriptions_user ON subscriptions(user_id, status);

-- Task 9 (security review): a customer id is linked to an account only when Paddle's customer email matches the
-- account email. No address is stored, only emailKey (HMAC with EMAIL_HASH_SECRET). Times are ms integers.
CREATE TABLE paddle_customers (id TEXT PRIMARY KEY, email_key TEXT NOT NULL, last_event_at INTEGER NOT NULL);
-- A link that passed the signed ref and the checkout intent but waits for the customer.* event (its email).
CREATE TABLE paddle_link_pending (customer_id TEXT NOT NULL, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (customer_id, user_id));
