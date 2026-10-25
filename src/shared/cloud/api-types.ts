/** Cloud HTTP API request/response shapes, shared by the Worker and the local client. Types only. */

export type ApiError = { error: string; code?: string };

// app: POST /v1/host/link/start · /v1/host/link/poll
export type LinkStartReq = { hostName: string; hostPub: string; uiVersion: string };
export type LinkStartRes = { deviceCode: string; userCode: string; verifyUrl: string; interval: number; expiresIn: number };
export type LinkApproveRes = { trial: 'granted' | 'already_used' | 'unavailable' };
export type LinkPollRes =
  | { state: 'pending' }
  | { state: 'linked'; hostId: string; hostToken: string; email: string };

// app: POST /v1/pair/start · GET /v1/pair/:id
export type PairStartReq = { claimHash: string };
export type PairStartRes = { pairingId: string; expiresAt: number };
export type PairState = 'open' | 'claimed' | 'confirmed' | 'rejected' | 'burned' | 'expired';
export type PairStatusRes = { state: PairState; deviceId?: string; devicePub?: string; deviceName?: string; mac?: string };

// relay: POST /v1/pair/claim
export type PairClaimReq = { pairingId: string; claim: string; devicePub: string; deviceName: string; mac: string };
export type PairClaimRes = { deviceId: string; deviceToken: string; hostId: string };

// relay: POST /v1/relay/ticket
export type TicketRes = { ticket: string; hostId: string; expiresIn: number };

// app: GET /v1/devices — the host's active (confirmed, not revoked) devices. `pub` is the X25519 key (base64url),
// `addedAt` the claim time, `lastSeen` the last ticket (null until the first one). Times are ms.
export type DeviceInfo = { id: string; name: string; pub: string; addedAt: number; lastSeen: number | null };

// app: GET /v1/entitlement (display only, unsigned)
export type EntitlementRes = {
  plan: 'pro' | 'trial' | 'comp' | 'none';
  st: 'active' | 'trialing' | 'past_due' | 'canceled' | 'none';
  untilMs: number;
  checkedAt: number;
};

// app: POST /v1/account/delete
export type DeleteAccountReq = { confirm: 'DELETE' };
