-- Task 12: indexes for the daily cleanup cron (cleanup.ts) and account deletion (account.ts).
CREATE INDEX magic_links_exp ON magic_links(expires_at);
-- relay_tickets(expires_at) is already indexed (0002_relay.sql, relay_tickets_expires).
CREATE INDEX pairings_exp ON pairings(expires_at);
CREATE INDEX host_links_exp ON host_links(expires_at);
CREATE INDEX web_sessions_exp ON web_sessions(expires_at);
CREATE INDEX rate_window ON rate(window_start);
CREATE INDEX ops_alerts_created ON ops_alerts(created_at);
CREATE INDEX paddle_events_received ON paddle_events(received_at);
CREATE INDEX checkout_intents_exp ON checkout_intents(expires_at);
CREATE INDEX trial_claims_user ON trial_claims(user_id);
-- Not in the plan's list: the cron's outbox sweep, the pending-link sweep and deletion by user.
CREATE INDEX outbox_created ON outbox(created_at);
CREATE INDEX paddle_link_pending_created ON paddle_link_pending(created_at);
CREATE INDEX paddle_link_pending_user ON paddle_link_pending(user_id);
