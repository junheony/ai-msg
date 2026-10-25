-- Task 3: one-time relay tickets (60 s). Only the sha256 of the ticket is stored; used_at makes it single use.
CREATE TABLE relay_tickets (ticket_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL, host_id TEXT NOT NULL, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE INDEX relay_tickets_expires ON relay_tickets(expires_at);
