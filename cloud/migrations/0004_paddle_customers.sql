-- Task 9 (security review): a customer id is linked to an account only when Paddle's customer email matches the
-- account email. No address is stored, only emailKey (HMAC with EMAIL_HASH_SECRET). Times are ms integers.
CREATE TABLE paddle_customers (id TEXT PRIMARY KEY, email_key TEXT NOT NULL, last_event_at INTEGER NOT NULL);
-- A link that passed the signed ref and the checkout intent but waits for the customer.* event (its email).
CREATE TABLE paddle_link_pending (customer_id TEXT NOT NULL, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (customer_id, user_id));
