const RAISED = new Set(['acceptEdits', 'bypassPermissions']);

/** What the policy needs to know of the Mac's current settings (absent = unknown: treated as the strictest). */
export type RelayWsContext = { autoConsent?: readonly string[] };

/**
 * Socket messages from a phone over the relay that only the Mac itself may send. Principle: a phone may use sessions
 * at the defaults the Mac has set (it can already answer Claude's tool prompts itself, so blocking per-turn defaults
 * gains nothing); it needs the Mac to raise an existing session's permissions or to change persistent settings, safety
 * switches or instructions every session keeps.
 *
 * Looks at `type` and the few fields below only (no `ClientMsg` parse): anything else, unparseable text included, is
 * `allow` and the server refuses it as before. Lowering (default, plan, read-only, false, fewer consents) is allowed.
 */
export function relayWsPolicy(msg: unknown, ctx: RelayWsContext = {}): 'allow' | 'mac_confirm_required' {
  let m = msg;
  if (typeof m === 'string') {
    try { m = JSON.parse(m); } catch { return 'allow'; }
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'allow';
  const o = m as Record<string, unknown>;
  const raised = (v: unknown) => typeof v === 'string' && RAISED.has(v);
  const verdict = (block: boolean) => (block ? 'mac_confirm_required' : 'allow');
  switch (o.type) {
    case 'set_permission_mode':
      return verdict(raised(o.mode));
    case 'set_settings':
      return verdict(o.autoApprove === true || raised(o.defaultPermissionMode) || o.commanderEnabled === true
        || turnsOnExperimental(o.experimental) || widensConsent(o.autoConsent, ctx.autoConsent ?? []));
    case 'send':
      // A new session (sessionId null) at workspace-write is the Mac's default sandbox; an existing one is a raise.
      return verdict(raised(o.permissionMode) || (o.sandbox === 'workspace-write' && o.sessionId !== null));
    case 'set_sandbox':
      return verdict(o.sandbox === 'workspace-write');
    case 'grok_unlock':
      return 'mac_confirm_required';
    default:
      return 'allow';
  }
}

function turnsOnExperimental(v: unknown): boolean {
  return !!v && typeof v === 'object' && Object.values(v).some((x) => x === true);
}

/** An engine consented to that is not consented to now (the list replaces the current one). */
function widensConsent(next: unknown, current: readonly string[]): boolean {
  return Array.isArray(next) && next.some((e) => !current.includes(e as string));
}
