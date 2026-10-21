import { answerFastConsent, usePendingFast } from '../fastMode';
import { Sheet, SheetHead } from './Dialogs';

/**
 * ⚡ 빠르게, the first time only: what fast mode costs before it is turned on. Mounted once in the app; shows while a
 * switch waits for the answer (fastMode.requestFast). Agreeing is remembered per browser and turns that session on.
 */
export function FastConsentSheet() {
  const pending = usePendingFast();
  if (!pending) return null;
  const cancel = () => answerFastConsent(false);
  return (
    <Sheet className="fast-consent" label="빠르게 모드 켜기" onClose={cancel}>
      {/* A paid switch: Enter right after opening cancels, never agrees. */}
      <SheetHead title="빠르게 모드 (Opus fast)" onClose={cancel} autoFocus={false} />
      <div className="fast-consent-body">
        <p>이 세션의 Claude 답을 더 빠르게 받습니다. 켜기 전에 확인해 주세요.</p>
        <ul>
          <li><strong>사용 크레딧으로 과금됩니다</strong> — 100만 토큰당 입력 $8 · 출력 $40 (Opus 5.5 기준).</li>
          <li>플랜 한도가 남아 있어도 한도가 아니라 사용 크레딧에서 나갑니다.</li>
          <li>긴 대화 중간에 켜면 그때까지의 대화 전체를 캐시 없이 한 번 더 보냅니다.</li>
          <li>Claude 계정에 사용 크레딧이 켜져 있어야 합니다. 꺼져 있으면 거부되고 그 이유가 대화에 표시됩니다.</li>
          <li>Opus 로만 돕니다 — 켜 둔 동안 이 세션의 턴은 Opus 5.5 입니다.</li>
        </ul>
        <p className="muted">이 안내는 처음 한 번만 나옵니다. 끄려면 입력창의 ↯ 를 누르거나 세션 메뉴에서 끄세요.</p>
        <div className="modal-actions">
          <button type="button" className="btn ghost" data-testid="fast-consent-cancel" onClick={cancel} autoFocus>취소</button>
          <button type="button" className="btn primary" data-testid="fast-consent-agree" onClick={() => answerFastConsent(true)}>동의하고 켜기</button>
        </div>
      </div>
    </Sheet>
  );
}
