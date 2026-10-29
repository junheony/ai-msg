// `ai-msg doctor`: one line per engine, then one per Claude profile. Exit code is always 0.
import type { ClaudeProfileProbe, EngineProbe, GeminiSeatProbe } from '../../shared/setup-types';
import { PROBE_TEXTS, loginHint } from '../setup/texts';

const NAME: Record<EngineProbe['engine'], string> = { claude: 'claude', codex: 'codex', gemini: 'gemini (agy)', grok: 'grok' };

export function formatDoctor(r: { engines: EngineProbe[]; claudeProfiles: ClaudeProfileProbe[]; geminiSeats?: GeminiSeatProbe[] }): string {
  const lines: string[] = [];
  for (const e of r.engines) {
    const parts = [NAME[e.engine]];
    if (!e.bin) {
      parts.push(PROBE_TEXTS.missing);
    } else {
      parts.push(`${e.version ?? PROBE_TEXTS.noVersion} (${e.bin})`);
      parts.push(PROBE_TEXTS.login[e.login] + (e.login === 'yes' ? '' : ` — ${loginHint(e.engine, e.loginCommand)}`));
    }
    if (e.note) parts.push(e.note);
    lines.push(parts.join(' · '));
  }
  for (const s of r.geminiSeats ?? []) {
    lines.push(`  ${s.label} ${s.dir} · ${PROBE_TEXTS.login[s.login]}${s.login === 'yes' ? '' : ` — ${s.loginCommand}`}`);
  }
  for (const p of r.claudeProfiles) {
    const tags = [p.home ? PROBE_TEXTS.homeProfile : null, p.active ? null : PROBE_TEXTS.retired].filter(Boolean);
    const head = `  ${PROBE_TEXTS.profile} ${p.label}(${p.id}) ${p.dir}${tags.length ? ` (${tags.join(', ')})` : ''}`;
    lines.push(`${head} · ${PROBE_TEXTS.login[p.login]}${p.login === 'yes' ? '' : ` — ${loginHint('claude', p.loginCommand)}`}`);
  }
  return lines.join('\n');
}
