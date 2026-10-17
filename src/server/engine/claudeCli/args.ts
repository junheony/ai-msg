import path from 'node:path';
import type { ClaudeModel, Effort } from '../../../shared/models';
import { MODEL_ARG } from '../../routing/ModelPolicy';

export const BRIDGE_SERVER = 'deck_bridge';
export const PERMISSION_TOOL = `mcp__${BRIDGE_SERVER}__permission`;
/** Tools whose auto-approval depends on the permission mode (acceptEdits) — gated by the PreToolUse relay. */
export const EDIT_TOOL_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';
/** 총사령탑 자동 턴(`commander`)의 PreToolUse 매처: 모든 도구가 훅을 거친다 — 읽기 전용만 통과, 나머지는 판정(hooks.ts). */
export const COMMANDER_TOOL_MATCHER = '.*';
/** The CLI's limit for one command hook (seconds). Above the fail-closed bridge cap and relay deadline (bridge.ts, hookRelay.ts). */
export const HOOK_TIMEOUT_S = 30;
/** Allow rules the commander hook gates itself: never handed to `permissions.allow` on an automatic turn. */
const COMMANDER_GATED_RULE = /^(?:Bash(?:\(|$)|mcp__)/;

export type CliPermissionMode = 'default' | 'acceptEdits' | 'plan';

export interface ArgsInput {
  model: ClaudeModel;
  effort?: Effort;
  permissionMode: CliPermissionMode;
  settingsPath: string;
  mcpConfigPath: string;
  addDirs?: string[];
  /** Session id, or an absolute path to a `.jsonl` transcript (fork-at-message source, Task 6). */
  resume?: string;
  forkSession?: boolean;
  /** Only for brand-new sessions: lets deck know the id before the init frame arrives. */
  sessionId?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validResume(v: string): boolean {
  return UUID_RE.test(v) || (path.isAbsolute(v) && v.endsWith('.jsonl'));
}

/**
 * argv for one deck turn process. Value flags use `--flag=value` where the CLI declares them
 * variadic (`--add-dir`, `--mcp-config`) so a value can never swallow the next flag.
 * Never: --bare (breaks subscription login), --strict-mcp-config (drops the user's MCP servers).
 */
export function claudeArgs(a: ArgsInput): string[] {
  const out = [
    '-p',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--replay-user-messages',
    '--model', MODEL_ARG[a.model],
  ];
  if (a.effort) out.push('--effort', a.effort);
  out.push(
    '--permission-mode', a.permissionMode,
    '--permission-prompts', 'host',
    '--permission-prompt-tool', PERMISSION_TOOL,
    '--setting-sources', 'user,project,local',
    `--settings=${a.settingsPath}`,
    `--mcp-config=${a.mcpConfigPath}`,
  );
  for (const d of a.addDirs ?? []) if (path.isAbsolute(d)) out.push(`--add-dir=${d}`);
  if (a.resume !== undefined) {
    if (!validResume(a.resume)) throw new Error(`invalid resume target: ${a.resume}`);
    out.push(`--resume=${a.resume}`);
    if (a.forkSession) out.push('--fork-session');
  } else if (a.sessionId && UUID_RE.test(a.sessionId)) {
    out.push(`--session-id=${a.sessionId}`);
  }
  return out;
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface RelaySpec { node: string; script: string; socketPath: string; token: string }

/**
 * Hook command line. The registration token goes in as a `DECK_BRIDGE_TOKEN=` env assignment in
 * front of node (same channel as the MCP server's `env`), so it never appears in node's argv / `ps`.
 */
export function relayCommand(r: RelaySpec, fail: 'open' | 'deny' | 'closed'): string {
  return `DECK_BRIDGE_TOKEN=${shellQuote(r.token)} ` + [r.node, '--disable-warning=ExperimentalWarning', r.script, '--sock', r.socketPath, '--fail', fail]
    .map(shellQuote).join(' ');
}

/**
 * `commander`: a 총사령탑 automatic turn — every tool call goes to the hook (matcher `.*`), relayed fail-closed (`--fail
 * closed`: a relay error / timeout / crash denies with exit 2), and Bash / `mcp__*` allow rules stay out of
 * `permissions.allow` so the CLI cannot approve them on its own.
 */
export interface SettingsInput { allowRules?: string[]; noTools?: boolean; systemNote?: string; commander?: boolean; relay: RelaySpec }

/**
 * Contents of the per-process `--settings` file (0600, inside a 0700 temp dir). Merged by the CLI
 * on top of user/project/local settings, exactly like the SDK's `settings` option was.
 */
export function buildSettings(s: SettingsInput): Record<string, unknown> {
  const hook = (fail: 'open' | 'deny' | 'closed') => ({ type: 'command', command: relayCommand(s.relay, fail), timeout: HOOK_TIMEOUT_S });
  const commander = !!s.commander && !s.noTools;
  const hooks: Record<string, unknown> = {
    PreToolUse: commander
      ? [{ matcher: COMMANDER_TOOL_MATCHER, hooks: [hook('closed')] }]
      : [{ matcher: s.noTools ? '*' : EDIT_TOOL_MATCHER, hooks: [hook(s.noTools ? 'deny' : 'open')] }],
  };
  if (s.systemNote) hooks.UserPromptSubmit = [{ hooks: [hook('open')] }];
  const out: Record<string, unknown> = { hooks };
  const allow = commander ? (s.allowRules ?? []).filter((r) => !COMMANDER_GATED_RULE.test(r)) : s.allowRules ?? [];
  if (allow.length) out.permissions = { allow: [...allow] };
  return out;
}

export function buildMcpConfig(m: { node: string; script: string; socketPath: string; token: string }): Record<string, unknown> {
  return {
    mcpServers: {
      [BRIDGE_SERVER]: {
        type: 'stdio',
        command: m.node,
        args: ['--disable-warning=ExperimentalWarning', m.script],
        env: { DECK_BRIDGE_SOCK: m.socketPath, DECK_BRIDGE_TOKEN: m.token },
      },
    },
  };
}

/**
 * Env for the claude child: the account env (`AccountRegistry.env`, already stripped of token and
 * routing vars, CLAUDE_CONFIG_DIR set) plus the MCP tool timeout so a permission card can wait for
 * the user. deck never sets CLAUDE_CODE_ENTRYPOINT / CLAUDE_AGENT_SDK_VERSION.
 */
export function claudeEnv(base: NodeJS.ProcessEnv, toolTimeoutMs: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, MCP_TOOL_TIMEOUT: String(toolTimeoutMs) };
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_AGENT_SDK_VERSION;
  return env;
}
