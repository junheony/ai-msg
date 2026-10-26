/**
 * Every feature and security line on the landing page → what backs it (Review Focus 7). `shipped`: code or tests in
 * this repo (the paths are checked to exist). `plan4`: the Pro next release — shown only under Pro (coming soon). Before
 * Pro goes on sale, check each plan4 row against what really shipped, or drop the line and rebuild.
 */
export type ClaimId =
  | 'oneInbox' | 'splitView' | 'carriesOn' | 'autoRouting' | 'usageBars' | 'approvals' | 'phoneWeb' | 'commander' | 'handoffNote'
  | 'proAccounts' | 'proRelay' | 'proPush' | 'proReminders' | 'proOneTapHandoff'
  | 'localFirst' | 'noCredentialReads' | 'rotationOffByDefault' | 'auditLog' | 'publicHygiene' | 'relayCiphertext' | 'relayMacOnly';

export type Claim = { text: string; evidence: string; owner: 'shipped' | 'plan4' };

export const CLAIMS: Record<ClaimId, Claim> = {
  oneInbox: { text: 'Claude Code, Codex, Gemini and Grok sessions in one list, including conversations started in those CLIs', evidence: 'src/server/sessions/SessionIndex.ts; src/server/sessions/CodexImports.ts; src/server/sessions/GeminiImports.ts; src/server/sessions/GrokImports.ts', owner: 'shipped' },
  splitView: { text: 'Split view (2–4 panes) and saved layouts', evidence: 'src/ui/components/Pane.tsx; src/ui/components/LayoutsDialog.tsx', owner: 'shipped' },
  carriesOn: { text: 'On a limit the turn continues on another AI (on by default) and resumes when the limit resets', evidence: 'src/server/turn/TurnRunner.ts crossEngineFailover/autoResume; src/server/settings.ts DEFAULT_SETTINGS', owner: 'shipped' },
  autoRouting: { text: 'Auto picks engine and model from the first message and the limits left', evidence: 'src/server/routing/AutoRoute.ts; src/server/routing/AutoRoute.test.ts', owner: 'shipped' },
  usageBars: { text: 'Usage left and reset time for every account', evidence: 'src/ui/components/UsageStrip.tsx; src/ui/components/usageSeats.tsx', owner: 'shipped' },
  approvals: { text: 'Approval and question cards, permission modes', evidence: 'src/ui/components/PermissionCard.tsx; src/ui/components/QuestionCard.tsx; src/shared/permission.ts', owner: 'shipped' },
  phoneWeb: { text: 'Same UI on a phone over your own network or Tailscale', evidence: 'src/server/bind.ts; README.md#remote-access', owner: 'shipped' },
  commander: { text: 'Commander: optional goal-driven follow-up turns with a turn cap', evidence: 'src/server/commander/Commander.ts; src/server/settings.ts commanderEnabled', owner: 'shipped' },
  handoffNote: { text: 'Continue in a new session with a handoff note', evidence: 'src/shared/handoff.ts; src/shared/handoff.test.ts', owner: 'shipped' },
  proAccounts: { text: 'As many accounts per vendor as you own, with combined usage', evidence: 'spec 2026-10-15 §4 (Pro column); plan ④ entitlement Task', owner: 'plan4' },
  proRelay: { text: 'Encrypted relay to your phone, no tailnet needed', evidence: 'plan ④ relay Task + phone app (Pro 5a–5c)', owner: 'plan4' },
  proPush: { text: 'Web Push on up to three devices', evidence: 'plan ④ push Task', owner: 'plan4' },
  proReminders: { text: 'Reminders for waiting approvals and failed turns on your phone', evidence: 'src/server/push/BottleneckWatch.ts (local); plan ④ relay push', owner: 'plan4' },
  proOneTapHandoff: { text: 'One tap to hand a session to another vendor with a summary and git state', evidence: 'spec 2026-10-15 §4 (벤더 간 인계 Pro)', owner: 'plan4' },
  localFirst: { text: 'Runs on your machine; listens on 127.0.0.1 and your Tailscale address only', evidence: 'src/server/bind.ts; src/server/bind.test.ts', owner: 'shipped' },
  noCredentialReads: { text: 'Uses the official CLI logins; never reads, stores or forwards their tokens', evidence: 'src/server/setup/noCredentialReads.test.ts', owner: 'shipped' },
  rotationOffByDefault: { text: 'Same-vendor account rotation is off by default and needs consent', evidence: 'src/server/settings.ts DEFAULT_SETTINGS.sameVendorRotation', owner: 'shipped' },
  auditLog: { text: 'New sessions ask before tool calls; every decision is audit-logged', evidence: 'src/server/audit.ts; src/server/audit.test.ts', owner: 'shipped' },
  publicHygiene: { text: 'The public repository is checked for keys and personal paths', evidence: 'src/hygiene.test.ts; scripts/export-public.sh', owner: 'shipped' },
  relayCiphertext: { text: 'The relay passes only ciphertext between your Mac and paired phone', evidence: 'plan ④ relay Task; docs/security-model.md', owner: 'plan4' },
  relayMacOnly: { text: 'Over the relay, new sessions use the Mac defaults; raising permissions, widening settings, safety switches, external-transfer consent and global instructions stay on the Mac', evidence: 'plan ④ D19; docs/security-model.md', owner: 'plan4' },
};
