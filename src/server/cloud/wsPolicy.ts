const RAISED = new Set(['acceptEdits', 'bypassPermissions']);

/**
 * Socket messages from a phone over the relay that would raise what the agents may do without asking — only the Mac
 * itself may send those. Looks at `type` and the few fields below only (no `ClientMsg` parse): anything else,
 * unparseable text included, is `allow` and the server refuses it as before. Lowering (default, plan, read-only,
 * false) is always allowed.
 */
export function relayWsPolicy(msg: unknown): 'allow' | 'mac_confirm_required' {
  let m = msg;
  if (typeof m === 'string') {
    try { m = JSON.parse(m); } catch { return 'allow'; }
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'allow';
  const o = m as Record<string, unknown>;
  const raised = (v: unknown) => typeof v === 'string' && RAISED.has(v);
  switch (o.type) {
    case 'set_permission_mode':
      return raised(o.mode) ? 'mac_confirm_required' : 'allow';
    case 'set_settings':
      return o.autoApprove === true || raised(o.defaultPermissionMode) || o.commanderEnabled === true ? 'mac_confirm_required' : 'allow';
    case 'send':
      return raised(o.permissionMode) || o.sandbox === 'workspace-write' ? 'mac_confirm_required' : 'allow';
    case 'set_sandbox':
      return o.sandbox === 'workspace-write' ? 'mac_confirm_required' : 'allow';
    default:
      return 'allow';
  }
}
