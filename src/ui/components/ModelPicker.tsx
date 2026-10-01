import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { AUTO_MODEL_INFO, EFFORTS, EFFORT_LABEL, MODEL_EFFORTS, MODEL_INFO, isCodexModel, type Effort, type ModelChoice } from '../../shared/models';

const MARGIN = 8;

const infoOf = (m: ModelChoice) => (m === 'auto' ? AUTO_MODEL_INFO : MODEL_INFO[m]);
const GAP = 6;

/**
 * Claude Desktop-style model menu: the button reads "Opus 5.5 · 높음"; the popover lists exact model versions
 * (grouped Claude / GPT when both are offered) and a reasoning-effort segment limited to what the model supports.
 * The popover is `position: fixed` and clamped to the viewport, so narrow split panes and phones never clip it.
 */
export function ModelPicker({ models, model, effort, onModel, onEffort }: {
  models: readonly ModelChoice[];
  model: ModelChoice;
  /** null = 자동 (only offered while the model is 자동). */
  effort: Effort | null;
  onModel: (m: ModelChoice) => void;
  onEffort: (e: Effort | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({});
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const auto = model === 'auto';
  const efforts = auto ? EFFORTS : MODEL_EFFORTS[model];

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const b = btnRef.current?.getBoundingClientRect();
      const pop = popRef.current;
      if (!b || !pop) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const width = Math.min(pop.offsetWidth || 300, vw - 2 * MARGIN);
      // Right-aligned to the button like Desktop, then pushed back inside the viewport.
      const left = Math.max(MARGIN, Math.min(b.right - width, vw - width - MARGIN));
      // Opens upward (the composer sits at the bottom); downward only if there is clearly more room below.
      const above = b.top - GAP - MARGIN;
      const below = vh - b.bottom - GAP - MARGIN;
      setPos(below > above
        ? { left, top: b.bottom + GAP, maxHeight: below }
        : { left, bottom: vh - b.top + GAP, maxHeight: above });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!popRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btnRef.current?.focus(); } };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const claude = models.filter((m) => !isCodexModel(m));
  const gpt = models.filter((m) => isCodexModel(m));
  const groups = [{ title: 'Claude', items: claude }, { title: 'GPT', items: gpt }].filter((g) => g.items.length);
  const effortShown = effort !== null && efforts.includes(effort);
  const label = effortShown ? `${infoOf(model).name} · ${EFFORT_LABEL[effort]}` : infoOf(model).name;

  return (
    <span className="model-picker">
      <button
        ref={btnRef}
        type="button"
        className={`mp-button ${open ? 'open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`모델: ${label}`}
        title="모델과 추론 수준"
        data-testid="model-picker"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="mp-label">{label}</span>
        <span className="mp-caret" aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div ref={popRef} className="mp-pop" role="menu" aria-label="모델" style={pos} data-testid="model-menu">
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
          {efforts.length > 0 && (
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
      )}
    </span>
  );
}
