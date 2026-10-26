/**
 * Every feature and security line on the landing page → what backs it (Review Focus 7). `shipped`: code or tests in
 * this repo (the paths are checked to exist). `plan4`: the Pro next release — shown only under Pro (coming soon). Before
 * Pro goes on sale, check each plan4 row against what really shipped, or drop the line and rebuild.
 */
export type ClaimId =
  | 'oneInbox' | 'splitView' | 'carriesOn' | 'autoRouting' | 'usageBars' | 'approvals' | 'phoneWeb' | 'pushNotifications' | 'reminders' | 'commander' | 'handoffNote'
  | 'proRelay' | 'proRelayPush'
  | 'localFirst' | 'noCredentialReads' | 'engineApprovals' | 'rotationOffByDefault' | 'publicHygiene' | 'relayCiphertext' | 'relayMacOnly';

export type Claim = { text: string; evidence: string; owner: 'shipped' | 'plan4' };

/** How each engine asks (checked in code): the approvals feature and the security point both cite these. */
const ENGINE_APPROVALS = 'src/server/engine/claudeCli/permissions.ts (Claude Code: permission cards per mode); src/server/engine/GrokEngine.ts session/request_permission (Grok: a card per request); src/server/engine/CodexEngine.ts codexArgs (Codex: approval_policy="never", sandbox_mode workspace-write with network or read-only, default src/shared/models.ts DEFAULT_SANDBOX); src/server/engine/GeminiEngine.ts geminiArgs (Gemini: plan = read-only, accept-edits --sandbox, shell refused headless); src/server/turn/TurnRunner.ts crossOver (a carried-on turn never gets more than the old session allowed)';

export const CLAIMS: Record<ClaimId, Claim> = {
  oneInbox: { text: 'Claude Code, Codex, Gemini and Grok sessions in one list, including conversations started in those CLIs', evidence: 'src/server/sessions/SessionIndex.ts; src/server/sessions/CodexImports.ts; src/server/sessions/GeminiImports.ts; src/server/sessions/GrokImports.ts', owner: 'shipped' },
  splitView: { text: 'Split view (2–4 panes) and saved layouts', evidence: 'src/ui/components/Pane.tsx; src/ui/components/LayoutsDialog.tsx', owner: 'shipped' },
  carriesOn: { text: 'On a limit the turn continues on another AI (on by default) and resumes when the limit resets', evidence: 'src/server/turn/TurnRunner.ts crossEngineFailover/autoResume; src/server/settings.ts DEFAULT_SETTINGS', owner: 'shipped' },
  autoRouting: { text: 'Auto picks engine and model from the first message and the limits left', evidence: 'src/server/routing/AutoRoute.ts; src/server/routing/AutoRoute.test.ts', owner: 'shipped' },
  usageBars: { text: 'Usage left and reset time for every account', evidence: 'src/ui/components/UsageStrip.tsx; src/ui/components/usageSeats.tsx', owner: 'shipped' },
  approvals: { text: 'Claude Code and Grok show approval / question cards; Codex runs with no approval cards inside its sandbox; Gemini is read-only or edits-only with shell refused', evidence: `src/ui/components/PermissionCard.tsx; src/ui/components/QuestionCard.tsx; ${ENGINE_APPROVALS}`, owner: 'shipped' },
  phoneWeb: { text: 'Same UI on a phone over Tailscale (the server binds 127.0.0.1 and the Tailscale address only)', evidence: 'src/server/bind.ts; README.md#remote-access', owner: 'shipped' },
  pushNotifications: { text: 'Web Push to up to 20 subscribed browsers and phones when a turn finishes or needs you (HTTPS, e.g. tailscale serve)', evidence: 'src/server/push/SubscriptionStore.ts MAX_SUBSCRIPTIONS; src/server/push/PushNotifier.ts; README.md#remote-access', owner: 'shipped' },
  reminders: { text: 'An unanswered approval is pushed again after 10 minutes; a failed turn after 10, 30 and 60 minutes', evidence: 'src/server/push/BottleneckWatch.ts ASK_NUDGE_MS/TURN_NUDGE_GAPS_MS', owner: 'shipped' },
  commander: { text: 'Commander: optional goal-driven follow-up turns with a turn cap', evidence: 'src/server/commander/Commander.ts; src/server/settings.ts commanderEnabled', owner: 'shipped' },
  handoffNote: { text: 'Continue in a new session with a handoff note', evidence: 'src/shared/handoff.ts; src/shared/handoff.test.ts', owner: 'shipped' },
  proRelay: { text: 'From your phone anywhere, without Tailscale or HTTPS setup: follow sessions and approve through an end-to-end encrypted relay', evidence: 'plan ④ relay Task + phone app (Pro 5a–5c)', owner: 'plan4' },
  proRelayPush: { text: 'Push and reminders delivered through the relay, no tailnet or HTTPS needed', evidence: 'plan ④ relay push', owner: 'plan4' },
  localFirst: { text: 'Runs on your machine; listens on 127.0.0.1 and your Tailscale address only', evidence: 'src/server/bind.ts; src/server/bind.test.ts', owner: 'shipped' },
  noCredentialReads: { text: 'Uses the official CLI logins; never reads, stores or forwards their tokens', evidence: 'src/server/setup/noCredentialReads.test.ts', owner: 'shipped' },
  engineApprovals: { text: 'Per engine: Claude Code and Grok ask; Codex has no approval cards and runs in its sandbox; Gemini read-only or edits-only; answered cards are audit-logged', evidence: `${ENGINE_APPROVALS}; src/server/audit.ts; src/server/audit.test.ts`, owner: 'shipped' },
  rotationOffByDefault: { text: 'Same-vendor account rotation is off by default and needs consent', evidence: 'src/server/settings.ts DEFAULT_SETTINGS.sameVendorRotation', owner: 'shipped' },
  publicHygiene: { text: 'The public repository is checked for keys and personal paths', evidence: 'src/hygiene.test.ts; scripts/export-public.sh', owner: 'shipped' },
  relayCiphertext: { text: 'The relay passes only ciphertext between your Mac and paired phone', evidence: 'plan ④ relay Task; docs/security-model.md', owner: 'plan4' },
  relayMacOnly: { text: 'Over the relay, new sessions use the Mac defaults; raising permissions, widening settings, safety switches, external-transfer consent and global instructions stay on the Mac', evidence: 'plan ④ D19; docs/security-model.md', owner: 'plan4' },
};
