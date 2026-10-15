// src/server/engine/claudeCli/permissionTypes.ts
// Local copy of the permission-update shape the CLI's prompt-tool contract uses (formerly imported from the SDK).
export type PermissionRuleValue = { toolName: string; ruleContent?: string };
export type PermissionDestination = 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg';
export type PermissionUpdate =
  | { type: 'addRules' | 'replaceRules' | 'removeRules'; rules: PermissionRuleValue[]; behavior: 'allow' | 'deny' | 'ask'; destination: PermissionDestination }
  | { type: 'setMode'; mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'; destination: PermissionDestination }
  | { type: 'addDirectories' | 'removeDirectories'; directories: string[]; destination: PermissionDestination };

/** `permission_suggestions` as the CLI sent them, keeping only well-formed entries; undefined when none. */
export function asPermissionUpdates(v: unknown): PermissionUpdate[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((u): u is PermissionUpdate => {
    if (!u || typeof u !== 'object') return false;
    const r = u as Record<string, unknown>;
    if (r.type === 'addRules' || r.type === 'replaceRules' || r.type === 'removeRules') return Array.isArray(r.rules) && (r.rules as unknown[]).every((x) => !!x && typeof (x as Record<string, unknown>).toolName === 'string');
    if (r.type === 'addDirectories' || r.type === 'removeDirectories') return Array.isArray(r.directories) && (r.directories as unknown[]).every((d) => typeof d === 'string');
    return r.type === 'setMode' && typeof r.mode === 'string';
  });
  return out.length ? out : undefined;
}
