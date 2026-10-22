import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HANGUL, hangulLiterals, scanTargets } from './i18nScan';
import { en as uiEn } from './ui/i18n/en';
import { en as serverEn } from './server/i18n/en';
import { en as sharedEn } from './shared/messages/en';

/**
 * The i18n leak ratchet (i18n plan ③): Korean string literals / JSX text outside the ko dictionaries.
 * BASELINE = how many each file may still have; a file not listed may have none. Translating a screen lowers its count
 * and the "tight" test makes you lower BASELINE with it. A file someone else rewrites (e.g. QuestionCard.tsx) only needs
 * its one number updated: `DECK_I18N_BASELINE=1 npx vitest run src/i18n.leak.test.ts -t prints` prints the current counts.
 * ALLOW = literals that are not UI text (parsing CLI output, a language's own name): "<file>::<literal>" → why.
 */
const ALLOW: Record<string, string> = {
  'src/ui/components/SettingsView.tsx::한국어': "LANGUAGE_NAMES: each language's name is written in that language",
  'src/server/turn/language.ts::한국어': "the reply-language note names the language in that language too",
  'src/server/usage/GeminiUsagePoller.ts::사용': 'parses the Korean output of agy /usage (not shown to the user)',
};

const BASELINE: Record<string, number> = {
  'src/server/accounts.ts': 7,
  'src/server/attachments/AttachmentStore.ts': 3,
  'src/server/childRegistry.ts': 3,
  'src/server/cli/args.ts': 15,
  'src/server/cli/bin.ts': 1,
  'src/server/cli/service/record.ts': 5,
  'src/server/commander/Commander.ts': 49,
  'src/server/commander/Judge.ts': 37,
  'src/server/commander/digest.ts': 1,
  'src/server/commander/rules.ts': 4,
  'src/server/config.ts': 7,
  'src/server/crash.ts': 2,
  'src/server/dirs.ts': 5,
  'src/server/engine/ClaudeEngine.ts': 2,
  'src/server/engine/CodexEngine.ts': 5,
  'src/server/engine/Engine.ts': 4,
  'src/server/engine/GeminiEngine.ts': 15,
  'src/server/engine/GrokEngine.ts': 43,
  'src/server/engine/claudeCli/childScripts.ts': 3,
  'src/server/engine/claudeCli/hookRelay.ts': 1,
  'src/server/engine/claudeCli/permissionMcp.ts': 1,
  'src/server/engine/claudeCli/process.ts': 3,
  'src/server/engine/claudeCli/stream.ts': 1,
  'src/server/engine/claudeCli/texts.ts': 27,
  'src/server/engine/codexRollout.ts': 2,
  'src/server/engine/grokBilling.ts': 12,
  'src/server/engine/grokInspect.ts': 21,
  'src/server/engine/grokLock.ts': 1,
  'src/server/engine/grokProjectGuard.ts': 1,
  'src/server/engine/limitDetect.ts': 3,
  'src/server/engine/shadowHome.ts': 8,
  'src/server/engine/slashCommands.ts': 4,
  'src/server/files.ts': 15,
  'src/server/highlights.ts': 7,
  'src/server/http.ts': 29,
  'src/server/lifecycle.ts': 11,
  'src/server/main.ts': 2,
  'src/server/memory/MemoryStore.ts': 2,
  'src/server/push/BottleneckWatch.ts': 12,
  'src/server/push/PushNotifier.ts': 9,
  'src/server/routing/AccountRouter.ts': 98,
  'src/server/routing/AutoModel.ts': 16,
  'src/server/routing/AutoRoute.ts': 93,
  'src/server/routing/EngineChoice.ts': 15,
  'src/server/routing/ModelPolicy.ts': 2,
  'src/server/server.ts': 27,
  'src/server/serverUpdate.ts': 1,
  'src/server/sessions/AcceptedRefs.ts': 1,
  'src/server/sessions/CodexImports.ts': 3,
  'src/server/sessions/GeminiImports.ts': 2,
  'src/server/sessions/GrokBotImports.ts': 11,
  'src/server/sessions/GrokImports.ts': 2,
  'src/server/sessions/PinStore.ts': 2,
  'src/server/sessions/SessionFork.ts': 18,
  'src/server/sessions/SessionIndex.ts': 1,
  'src/server/sessions/SessionMetaStore.ts': 2,
  'src/server/sessions/SessionMover.ts': 9,
  'src/server/sessions/SessionTrash.ts': 7,
  'src/server/sessions/backupPrune.ts': 2,
  'src/server/sessions/codexFixtures.ts': 3,
  'src/server/sessions/elsewhereNotice.ts': 13,
  'src/server/sessions/transcript.ts': 18,
  'src/server/tasks/TaskRegistry.ts': 3,
  'src/server/tccDenial.ts': 2,
  'src/server/turn/SessionState.ts': 5,
  'src/server/turn/TurnRunner.ts': 172,
  'src/server/usage/ClaudeUsagePoller.ts': 13,
  'src/server/usage/GeminiUsagePoller.ts': 11,
  'src/server/usage/GrokBillingPoller.ts': 2,
  'src/server/usage/GrokUsageTracker.ts': 5,
  'src/server/usage/UsageIndex.ts': 30,
  'src/server/usage/UsageService.ts': 5,
  'src/server/ws.ts': 64,
  'src/shared/accounts.ts': 23,
  'src/shared/choices.ts': 5,
  'src/shared/concise.ts': 26,
  'src/shared/handoff.ts': 28,
  'src/shared/memory.ts': 1,
  'src/shared/models.ts': 23,
  'src/shared/permission.ts': 12,
  'src/shared/protocol.ts': 1,
  'src/shared/tasks.ts': 2,
  'src/shared/token-usage.ts': 2,
  'src/ui/App.tsx': 109,
  'src/ui/accounts.ts': 2,
  'src/ui/components/AccountPicker.tsx': 15,
  'src/ui/components/Activity.tsx': 54,
  'src/ui/components/ActivityButton.tsx': 9,
  'src/ui/components/ActivitySheet.tsx': 67,
  'src/ui/components/AttachmentBar.tsx': 17,
  'src/ui/components/Chat.tsx': 58,
  'src/ui/components/CommandPalette.tsx': 13,
  'src/ui/components/CommanderChip.tsx': 40,
  'src/ui/components/CommanderSheet.tsx': 20,
  'src/ui/components/ComposerSuggest.tsx': 4,
  'src/ui/components/ContextGauge.tsx': 2,
  'src/ui/components/CopyButton.tsx': 4,
  'src/ui/components/Dialogs.tsx': 14,
  'src/ui/components/DictationButton.tsx': 4,
  'src/ui/components/DiffView.tsx': 7,
  'src/ui/components/FastConsentSheet.tsx': 12,
  'src/ui/components/FileMenu.tsx': 17,
  'src/ui/components/FindBar.tsx': 8,
  'src/ui/components/FolderPicker.tsx': 6,
  'src/ui/components/ForkMenu.tsx': 8,
  'src/ui/components/Highlights.tsx': 45,
  'src/ui/components/ImageEditor.tsx': 26,
  'src/ui/components/LayoutsDialog.tsx': 17,
  'src/ui/components/Lightbox.tsx': 1,
  'src/ui/components/MemoryEditor.tsx': 9,
  'src/ui/components/MessageView.tsx': 70,
  'src/ui/components/ModelPicker.tsx': 10,
  'src/ui/components/NewChat.tsx': 20,
  'src/ui/components/NotifyMenu.tsx': 15,
  'src/ui/components/OpenInDesktop.tsx': 3,
  'src/ui/components/Pane.tsx': 51,
  'src/ui/components/PermissionCard.tsx': 22,
  'src/ui/components/QuestionCard.tsx': 13,
  'src/ui/components/QueueChips.tsx': 25,
  'src/ui/components/SessionChip.tsx': 46,
  'src/ui/components/SessionChipHead.tsx': 3,
  'src/ui/components/SessionCwdDialog.tsx': 5,
  'src/ui/components/SessionMenu.tsx': 9,
  'src/ui/components/SettingsView.tsx': 98,
  'src/ui/components/ShareMenu.tsx': 10,
  'src/ui/components/SidePanel.tsx': 62,
  'src/ui/components/Sidebar.tsx': 93,
  'src/ui/components/TaskCards.tsx': 11,
  'src/ui/components/Toasts.tsx': 1,
  'src/ui/components/TodoPanel.tsx': 4,
  'src/ui/components/ToolCallView.tsx': 8,
  'src/ui/components/TurnBadge.tsx': 14,
  'src/ui/components/UsageSheet.tsx': 13,
  'src/ui/components/UsageStrip.tsx': 20,
  'src/ui/components/UsageView.tsx': 39,
  'src/ui/components/highlightSections.ts': 11,
  'src/ui/components/usageSeats.tsx': 114,
  'src/ui/context.ts': 10,
  'src/ui/dateGroups.ts': 16,
  'src/ui/diff.ts': 4,
  'src/ui/exportMarkdown.ts': 6,
  'src/ui/injected.ts': 11,
  'src/ui/openRequest.ts': 1,
  'src/ui/persist.ts': 1,
  'src/ui/pinOrder.ts': 2,
  'src/ui/pins.ts': 4,
  'src/ui/push.ts': 6,
  'src/ui/sessionApi.ts': 21,
  'src/ui/shellFit.ts': 5,
  'src/ui/shortcuts.ts': 16,
  'src/ui/state.ts': 12,
  'src/ui/toolLabel.ts': 27,
  'src/ui/upload.ts': 8,
};

const ROOT = process.cwd();

function scan() {
  const counts: Record<string, number> = {};
  const allowHits = new Set<string>();
  for (const file of scanTargets(ROOT)) {
    const found = hangulLiterals(file, fs.readFileSync(path.join(ROOT, file), 'utf8')).filter((l) => {
      const key = `${file}::${l.text}`;
      if (key in ALLOW) { allowHits.add(key); return false; }
      return true;
    });
    if (found.length) counts[file] = found.length;
  }
  return { counts, allowHits };
}

const { counts, allowHits } = scan();

/** Every leaf string of a dictionary; functions are called with placeholder arguments. */
function leaves(o: unknown, at = ''): [string, string][] {
  if (typeof o === 'string') return [[at, o]];
  if (typeof o === 'function') return [[at, String((o as (...a: unknown[]) => unknown)(...Array.from({ length: o.length }, () => '1')))]];
  return Object.entries(o as object).flatMap(([k, v]) => leaves(v, at ? `${at}.${k}` : k));
}

describe('i18n leak ratchet', () => {
  it('no file has more Hangul literals than its baseline, and no new file has any', () => {
    const over = Object.entries(counts).filter(([f, n]) => n > (BASELINE[f] ?? 0)).map(([f, n]) => `${f}: ${n} > ${BASELINE[f] ?? 0}`);
    expect(over).toEqual([]);
  });

  it('the baseline is tight (lower it when you translate)', () => {
    const loose = Object.entries(BASELINE).filter(([f, n]) => (counts[f] ?? 0) !== n).map(([f, n]) => `${f}: baseline ${n}, now ${counts[f] ?? 0}`);
    expect(loose).toEqual([]);
  });

  it('every ALLOW entry still matches a literal', () => {
    expect(Object.keys(ALLOW).filter((k) => !allowHits.has(k))).toEqual([]);
  });

  it('en dictionaries carry no Hangul and no banned marketing words', () => {
    const BANNED = /\bunlimited\b|\bbypass|\bcircumvent|100%\s*quota|무제한|한도\s*우회|할당량\s*100%/i;
    const all = [...leaves(uiEn, 'ui'), ...leaves(serverEn, 'server'), ...leaves(sharedEn, 'shared')];
    expect(all.length).toBeGreaterThan(0);
    expect(all.filter(([, s]) => HANGUL.test(s) || BANNED.test(s)).map(([k]) => k)).toEqual([]);
  });

  it('the scanner counts strings, templates and JSX text, not comments or regexes', () => {
    const src = "// 주석\nconst a = '하나'; const b = `둘 ${a} 셋`; const r = /넷/; const j = <p>다섯</p>;";
    expect(hangulLiterals('x.tsx', src).map((l) => l.text)).toEqual(['하나', '둘 ', ' 셋', '다섯']);
  });

  it.skipIf(!process.env.DECK_I18N_BASELINE)('prints the current counts', () => {
    console.log(JSON.stringify(counts, null, 2));
  });
});
