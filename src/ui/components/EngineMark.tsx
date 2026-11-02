import { isGeminiAccount, isGrokAccount, type Seat } from '../../shared/accounts';
import type { EngineKind } from '../../shared/models';

/** OpenAI blossom, drawn in currentColor (CSP: inline only, no external assets). */
export function OpenAIMark({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.911 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.182a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .511 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.041l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.169a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
    </svg>
  );
}

/** Published LobeHub Claude identifier, embedded locally; https://github.com/lobehub/lobe-icons (MIT); see docs/usage-brand-assets-LICENSE.txt. */
export function ClaudeMark({ className }: { className: string }) {
  return <svg className={`claude-mark ${className}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path fill="#D97757" fillRule="evenodd" d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" />
  </svg>;
}

/** Gemini's four-point spark, drawn in currentColor (the usage card colours it Gemini blue). Same 24-unit box as the others. */
export function GeminiMark({ className }: { className: string }) {
  return (
    <svg className={`gemini-mark ${className}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M12 1.5c.4 5.7 4.8 10.1 10.5 10.5-5.7.4-10.1 4.8-10.5 10.5C11.6 16.8 7.2 12.4 1.5 12 7.2 11.6 11.6 7.2 12 1.5z" />
    </svg>
  );
}

/** Published LobeHub Grok identifier, embedded locally; https://github.com/lobehub/lobe-icons (MIT); see docs/usage-brand-assets-LICENSE.txt. */
export function GrokMark({ className }: { className: string }) {
  return <svg className={`grok-mark ${className}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path fill="currentColor" fillRule="evenodd" d="M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815" />
  </svg>;
}

/** Hermes wing: a compact directional mark distinct from provider logos. */
export function HermesMark({ className }: { className: string }) {
  return <svg className={`hermes-mark ${className}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M3 5h15l-4 4H6l-3-4Zm3 7h10l-4 4H8l-2-4Zm4 7h4l7-14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
  </svg>;
}

/** Which engine a session runs on: its own field, else what its seat implies. */
export function engineOf(s: { engine?: EngineKind | null; account?: Seat }): EngineKind {
  return s.engine ?? (s.account === 'hermes' ? 'hermes' : s.account === 'gpt' ? 'codex' : isGeminiAccount(s.account) ? 'gemini' : isGrokAccount(s.account) ? 'grok' : 'claude');
}

/**
 * The engine mark before a session's title (the usage cards' marks): the Claude star, the OpenAI blossom for Codex, the
 * Grok slash, Gemini spark and Hermes wing. Inline SVG preserves title truncation. `decorative`: dense lists whose row already says what it is — hidden from assistive tech, tooltip kept.
 */
export function EngineMark({ engine, decorative = false }: { engine: EngineKind; decorative?: boolean }) {
  const label = engine === 'codex' ? 'Codex (GPT)' : engine === 'grok' ? 'Grok' : engine === 'hermes' ? 'Hermes' : engine === 'gemini' ? 'Gemini' : 'Claude';
  const a11y = decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label };
  return (
    <span className={`engine-mark ${engine}`} title={label} {...a11y}>
      {engine === 'codex' ? <OpenAIMark className="engine-mark-svg" /> : engine === 'grok' ? <GrokMark className="engine-mark-svg" /> : engine === 'hermes' ? <HermesMark className="engine-mark-svg" /> : engine === 'gemini' ? <GeminiMark className="engine-mark-svg" /> : <ClaudeMark className="engine-mark-svg" />}
    </span>
  );
}
