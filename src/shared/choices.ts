/**
 * deck-choices: engines without a question tool (GPT, Gemini, Grok) offer a decision as a fenced block, which the pane
 * renders as option cards; a click sends the option's text as the user's reply.
 *
 *   ```deck-choices
 *   ? 어느 쪽으로 할까요?
 *   - 지금 고치기
 *   - 이슈만 남기기
 *   ```
 */

export const DECK_CHOICES_LANG = 'deck-choices';
export const MAX_CHOICES = 6;
export const MAX_CHOICE_CHARS = 200;

export type DeckChoices = { question: string | null; options: string[] };

const FENCE = /(^|\n)[ \t]*```[ \t]*deck-choices[ \t]*\n([\s\S]*?)\n[ \t]*```[ \t]*(?=\n|$)/g;
const OPEN = /(^|\n)[ \t]*```[ \t]*deck-choices\b[\s\S]*$/;

function parseBody(body: string): DeckChoices | null {
  let question: string | null = null;
  const options: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const q = /^\?\s*(.+)$/.exec(line);
    if (q) { if (question === null) question = q[1]!.trim(); continue; }
    const o = /^(?:[-*•]|\d+[.)])\s+(.+)$/.exec(line);
    const text = (o ? o[1]! : line).trim();
    if (text && text.length <= MAX_CHOICE_CHARS && !options.includes(text)) options.push(text);
  }
  if (options.length < 2) return null;
  return { question, options: options.slice(0, MAX_CHOICES) };
}

/**
 * The reply's last deck-choices block (null when there is none or it has fewer than two options) and the text without
 * the parsed deck-choices blocks (one that does not parse is kept as written). While streaming, an unclosed block at the end is hidden too (it is still being written).
 */
export function splitDeckChoices(text: string, streaming = false): { text: string; choices: DeckChoices | null } {
  if (!text.includes('deck-choices')) return { text, choices: null };
  let choices: DeckChoices | null = null;
  // A block that does not parse (fewer than two options, …) stays as the engine wrote it: nothing it said is lost.
  let rest = text.replace(FENCE, (m: string, lead: string, body: string) => {
    const parsed = parseBody(body);
    if (!parsed) return m;
    choices = parsed;
    return lead;
  });
  if (streaming) rest = rest.replace(OPEN, '$1');
  return { text: rest.replace(/\n{3,}/g, '\n\n').trim(), choices };
}

/** What the non-Claude engines are told (with the style note and deck 메모; never in the transcript). */
export const DECK_CHOICES_PROMPT = [
  '[Crew 선택지] 이 화면은 선택지 카드를 보여 줄 수 있습니다. 사용자가 골라야 할 결정이 있으면 문장으로 길게 묻지 말고, 답의 맨 끝에 아래 형식의 블록 하나로 2–4개의 짧은 선택지를 주세요(사용자가 누르면 그 문구가 답으로 옵니다).',
  '```deck-choices',
  '? 짧은 질문',
  '- 선택지 1',
  '- 선택지 2',
  '```',
  '결정할 것이 없으면 이 블록을 쓰지 마세요.',
].join('\n');

/** Hidden context for engines that only take a prompt (Gemini, Grok): the UI and history readers drop this block. */
export function systemReminder(text: string): string {
  return `<system-reminder>\n${text}\n</system-reminder>`;
}

/** Leading `<system-reminder>` blocks removed (a title or preview built from a prompt deck prefixed). */
export function stripSystemReminders(text: string): string {
  return text.replace(/^(?:\s*<system-reminder>[\s\S]*?<\/system-reminder>)+\s*/, '');
}
