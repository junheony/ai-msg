import { useEffect } from 'react';
import { usePrefs } from '../usePrefs';
import type { ChatWidth, FontSize, Prefs, SendKey, Theme } from '../prefs';
import { NotifyMenu } from './NotifyMenu';

/** Injected by vite.config.ts (package.json version); absent under vitest. */
declare const __DECK_VERSION__: string | undefined;

function Seg<T extends string>({ label, value, options, onPick }: { label: string; value: T; options: [T, string][]; onPick: (v: T) => void }) {
  return (
    <div className="settings-row">
      <span id={`seg-${label}`}>{label}</span>
      <div className="seg" role="group" aria-labelledby={`seg-${label}`}>
        {options.map(([v, text]) => <button type="button" key={v} aria-pressed={value === v} onClick={() => onPick(v)}>{text}</button>)}
      </div>
    </div>
  );
}

export function SettingsView({ build, onOpenUsage, onClose }: { build: string | null; onOpenUsage: () => void; onClose: () => void }) {
  const [prefs, dispatch] = usePrefs();
  const set = <K extends keyof Prefs>(key: K, value: Prefs[K]) => dispatch({ type: 'set', key, value });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="settings-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="settings" role="dialog" aria-modal="true" aria-label="설정">
        <div className="settings-head">
          <h2>설정</h2>
          <button type="button" className="btn ghost" onClick={onClose}>닫기</button>
        </div>
        <section aria-label="일반">
          <h3>일반</h3>
          <Seg<Theme> label="테마" value={prefs.theme} onPick={(v) => set('theme', v)} options={[['system', '시스템'], ['light', '라이트'], ['dark', '다크']]} />
          <Seg<FontSize> label="글자 크기" value={prefs.fontSize} onPick={(v) => set('fontSize', v)} options={[['small', '작게'], ['normal', '보통'], ['large', '크게'], ['xlarge', '아주 크게']]} />
          <Seg<ChatWidth> label="채팅 폭" value={prefs.chatWidth} onPick={(v) => set('chatWidth', v)} options={[['narrow', '좁게'], ['wide', '넓게']]} />
          <Seg<SendKey> label="Enter 동작" value={prefs.sendKey} onPick={(v) => set('sendKey', v)} options={[['enter', 'Enter 전송'], ['mod-enter', '⌘Enter 전송']]} />
          <p className="muted">이 기기에만 저장됩니다 (폰과 맥이 따로).</p>
        </section>
        <section aria-label="권한">
          <h3>권한</h3>
          {/* PERM-MODE SLOT: the perm-mode branch adds the default permission mode control here. */}
        </section>
        <section aria-label="알림">
          <h3>알림</h3>
          <div className="settings-row"><span>이 기기 푸시 알림</span><NotifyMenu /></div>
        </section>
        <section aria-label="계정·사용량">
          <h3>계정 · 사용량</h3>
          <div className="settings-row"><span>토큰 사용량 기록 (주별·일별)</span><button type="button" className="btn ghost" onClick={() => { onClose(); onOpenUsage(); }}>사용량 보기</button></div>
          <p className="muted">계정별 5시간·주간 한도는 화면 상단 사용량 표시에서 확인합니다 (읽기 전용).</p>
        </section>
        <section aria-label="정보">
          <h3>정보</h3>
          <dl className="settings-info">
            <dt>빌드</dt><dd>{build ?? '개발 모드'}</dd>
            <dt>서버 버전</dt><dd>deck {typeof __DECK_VERSION__ === 'string' ? __DECK_VERSION__ : '—'}</dd>
          </dl>
        </section>
      </div>
    </div>
  );
}
