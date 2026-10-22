// `ai-msg doctor`: one line per engine, then one per Claude profile. Exit code is always 0.
import type { ClaudeProfileProbe, EngineProbe } from '../../shared/setup-types';
import { shared } from '../../shared/messages';
import { probeTexts, loginHint } from '../setup/texts';

const NAME: Record<EngineProbe['engine'], string> = { claude: 'claude', codex: 'codex', gemini: 'gemini (agy)', grok: 'grok' };

export function formatDoctor(r: { engines: EngineProbe[]; claudeProfiles: ClaudeProfileProbe[] }): string {
  const lines: string[] = [];
  for (const e of r.engines) {
    const parts = [NAME[e.engine]];
    if (!e.bin) {
      parts.push(probeTexts().missing);
    } else {
      parts.push(`${e.version ?? probeTexts().noVersion} (${e.bin})`);
      parts.push(shared().loginState[e.login] + (e.login === 'yes' ? '' : ` — ${loginHint(e.engine, e.loginCommand)}`));
    }
    if (e.note) parts.push(e.note);
    lines.push(parts.join(' · '));
  }
  for (const p of r.claudeProfiles) {
    const tags = [p.home ? probeTexts().homeProfile : null, p.active ? null : probeTexts().retired].filter(Boolean);
    const head = `  ${probeTexts().profile} ${p.label}(${p.id}) ${p.dir}${tags.length ? ` (${tags.join(', ')})` : ''}`;
    lines.push(`${head} · ${shared().loginState[p.login]}${p.login === 'yes' ? '' : ` — ${loginHint('claude', p.loginCommand)}`}`);
  }
  return lines.join('\n');
}
