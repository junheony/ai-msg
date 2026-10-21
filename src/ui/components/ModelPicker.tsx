import { AUTO_MODEL_INFO, EFFORTS, EFFORT_LABEL, MODEL_EFFORTS, MODEL_INFO, isCodexModel, isGeminiModel, isGrokModel, type Effort, type ModelChoice } from '../../shared/models';

const infoOf = (m: ModelChoice) => (m === 'auto' ? AUTO_MODEL_INFO : MODEL_INFO[m]);

/** "Opus 5.5" and its effort ("높음"; null while the effort is 자동 or the model has no such level). */
export function modelLabel(model: ModelChoice, effort: Effort | null): { name: string; effort: string | null } {
  const efforts = model === 'auto' ? EFFORTS : MODEL_EFFORTS[model];
  return { name: infoOf(model).name, effort: effort !== null && efforts.includes(effort) ? EFFORT_LABEL[effort] : null };
}

/**
 * Claude Desktop-style model list, shown inline in the session chip's sheet: exact model versions (grouped Claude / GPT /
 * Gemini / Grok when more than one is offered) and a reasoning-effort segment limited to what the model supports.
 */
/** Effort levels shown as a segment row up to this many; more become a select. */
const EFFORT_SEG_MAX = 3;

export function ModelMenu({ models, model, effort, onModel, onEffort }: {
  models: readonly ModelChoice[];
  model: ModelChoice;
  /** null = 자동 (only offered while the model is 자동). */
  effort: Effort | null;
  onModel: (m: ModelChoice) => void;
  onEffort: (e: Effort | null) => void;
}) {
  const auto = model === 'auto';
  const efforts = auto ? EFFORTS : MODEL_EFFORTS[model];
  const claude = models.filter((m) => !isCodexModel(m) && !isGeminiModel(m) && !isGrokModel(m));
  const gpt = models.filter((m) => isCodexModel(m));
  const gemini = models.filter((m) => isGeminiModel(m));
  const grok = models.filter((m) => isGrokModel(m));
  const groups = [{ title: 'Claude', items: claude }, { title: 'GPT', items: gpt }, { title: 'Gemini', items: gemini }, { title: 'Grok', items: grok }].filter((g) => g.items.length);

  // 자동 (model 자동 only) plus the model's levels. Over three they do not fit a segment row: a select instead,
  // after the menu (a select is not a menu item) — the same rule as the settings' segments (SettingsView SEG_MAX).
  const effortOptions: [Effort | null, string][] = [...(auto ? [[null, '자동'] as [null, string]] : []), ...efforts.map((e): [Effort, string] => [e, EFFORT_LABEL[e]])];
  const effortSelect = effortOptions.length > EFFORT_SEG_MAX;

  return (
    <>
    <div className="mp-list" role="menu" aria-label="모델" data-testid="model-menu">
      {groups.map((g) => (
        <div key={g.title} className="mp-section" role="group" aria-label={g.title}>
          {groups.length > 1 && <div className="mp-head">{g.title}</div>}
          {g.items.map((m) => (
            <button
              key={m}
              type="button"
              role="menuitemradio"
              aria-checked={m === model}
              className={`mp-item ${m === model ? 'on' : ''}`}
              onClick={() => onModel(m)}
            >
              <span className="mp-text">
                <span className="mp-name">{infoOf(m).name}</span>
                <span className="mp-desc">{infoOf(m).description}</span>
              </span>
              <span className="mp-check" aria-hidden="true">{m === model ? '✓' : ''}</span>
            </button>
          ))}
        </div>
      ))}
      {efforts.length > 0 && !effortSelect && (
        <div className="mp-section" role="group" aria-label="추론 수준">
          <div className="mp-head">추론 수준</div>
          <div className="mp-effort">
            {auto && (
              <button type="button" role="menuitemradio" aria-checked={effort === null} className={effort === null ? 'on' : ''} title="Sonnet 중간 · Opus/Fable 높음" onClick={() => onEffort(null)}>
                자동
              </button>
            )}
            {efforts.map((e) => (
              <button
                key={e}
                type="button"
                role="menuitemradio"
                aria-checked={e === effort}
                className={e === effort ? 'on' : ''}
                onClick={() => onEffort(e)}
              >
                {EFFORT_LABEL[e]}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
    {effortSelect && (
      <label className="mp-effort-row">
        <span className="mp-head">추론 수준</span>
        <select className="mp-effort-select" aria-label="추론 수준" value={effort ?? ''} title={auto ? '자동: Sonnet 중간 · Opus/Fable 높음' : undefined}
          onChange={(e) => onEffort(e.target.value ? e.target.value as Effort : null)}>
          {effort === null && !auto && <option value="" disabled>기본</option>}
          {effortOptions.map(([v, text]) => <option key={v ?? 'auto'} value={v ?? ''}>{text}</option>)}
        </select>
      </label>
    )}
    </>
  );
}
