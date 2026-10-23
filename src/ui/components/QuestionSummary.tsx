import { ui } from '../i18n';
import type { ToolCallItem } from '../state';
import { splitRecommended } from './QuestionCard';

type Asked = { question: string; header: string };

export function askedOf(input: unknown): Asked[] {
  const qs = input && typeof input === 'object' ? (input as { questions?: unknown }).questions : null;
  if (!Array.isArray(qs)) return [];
  return qs.flatMap((q) => {
    const question = q && typeof q === 'object' ? (q as { question?: unknown }).question : null;
    const header = q && typeof q === 'object' ? (q as { header?: unknown }).header : null;
    return typeof question === 'string' && question ? [{ question, header: typeof header === 'string' ? header : '' }] : [];
  });
}

/**
 * The answers of an answered AskUserQuestion call, by question text. The tool's input carries them when the transcript kept
 * the updated input (`answers`); otherwise they are read back from Claude Code's result line,
 * `User has answered your questions: "Q1"="A1", "Q2"="A2". You can now continue …`, using the known question texts as anchors
 * (so quotes or commas inside an answer do not split it).
 */
export function questionAnswers(call: Pick<ToolCallItem, 'input' | 'result'>): Record<string, string> {
  const asked = askedOf(call.input);
  const given = call.input && typeof call.input === 'object' ? (call.input as { answers?: unknown }).answers : null;
  if (given && typeof given === 'object') {
    const out: Record<string, string> = {};
    for (const { question } of asked) { const a = (given as Record<string, unknown>)[question]; if (typeof a === 'string' && a) out[question] = a; }
    if (Object.keys(out).length) return out;
  }
  const text = call.result ?? '';
  const marks = asked
    .map(({ question }) => { const m = `"${question}"="`; const at = text.indexOf(m); return { question, at, start: at + m.length }; })
    .filter((m) => m.at >= 0)
    .sort((a, b) => a.at - b.at);
  const out: Record<string, string> = {};
  marks.forEach((m, i) => {
    const next = marks[i + 1];
    let end: number;
    if (next) end = text.lastIndexOf('"', next.at - 1);
    else {
      // The closing sentence, not the first `". ` (a typed answer may contain one).
      const tail = text.lastIndexOf('". ');
      end = tail >= 0 ? tail : text.lastIndexOf('"');
    }
    const a = end > m.start ? text.slice(m.start, end) : '';
    if (a) out[m.question] = a;
  });
  return out;
}

/** An answered AskUserQuestion stays in the reply as `question → answer` rows (one per question), not folded into the tool calls. */
export function QuestionSummary({ call }: { call: ToolCallItem }) {
  const T = ui().cards.summary;
  const asked = askedOf(call.input);
  if (call.result === null || asked.length === 0) return null;
  const answers = call.isError ? {} : questionAnswers(call);
  // Answered, but in a shape this reader does not know: the result as Claude Code wrote it beats a row of 답하지 않음.
  if (!call.isError && Object.keys(answers).length === 0 && call.result.trim()) {
    const raw = call.result.trim();
    return (
      <div className="question-summary" role="group" aria-label={T.label} data-testid="question-summary">
        <div className="question-summary-raw" data-testid="question-summary-raw">{raw.length > 600 ? raw.slice(0, 600) + '…' : raw}</div>
      </div>
    );
  }
  return (
    <div className="question-summary" role="group" aria-label={T.label} data-testid="question-summary">
      {asked.map(({ question, header }) => {
        // "Postgres (Recommended)" reads as "Postgres", like on the card: only each pick's tail, never text in the middle.
        const a = answers[question]?.split(', ').map((s) => splitRecommended(s).text).join(', ');
        return (
          <div key={question} className="question-summary-row">
            <span className="question-summary-q" title={question}>{header || question}</span>
            <span className="question-summary-arrow" aria-hidden="true">→</span>
            {a ? <span className="question-summary-a">{a}</span> : <span className="question-summary-a none">{T.none}</span>}
          </div>
        );
      })}
    </div>
  );
}
