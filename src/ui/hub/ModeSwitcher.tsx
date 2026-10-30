import { useEffect, useId, useRef, useState } from 'react';
import type { HubStatus } from '../../shared/hub-types';
import { CheckMarkIcon, ChevronDownIcon, HubIcon } from './HubIcons';
import { HUB_MODES, modeDef, modeDigit, type HubModeKey } from './modes';
import { hhmmss } from './time';

/** The top-left mode title: a button showing the current mode, a dropdown listing all ten with ⌘1–9·0 hints (the rail is the other way). */
export function ModeSwitcher({ mode, onChange, mac, phone, onOpenChange }: { mode: HubModeKey; onChange: (m: HubModeKey) => void; mac: boolean; phone: boolean; onOpenChange?: (open: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const current = modeDef(mode);
  const kbd = (n: number) => (mac ? `⌘${n}` : `Ctrl+${n}`);
  const show = (o: boolean) => { setOpen(o); onOpenChange?.(o); if (o) setCursor(Math.max(0, HUB_MODES.findIndex((m) => m.id === mode))); };
  const pick = (m: HubModeKey) => { show(false); onChange(m); btn.current?.focus(); };
  // A mode picked elsewhere while the menu is open (⌘n, the rail) closes it too.
  const shownFor = useRef(mode);
  useEffect(() => {
    if (open && shownFor.current !== mode) { show(false); btn.current?.focus(); }
    shownFor.current = mode;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) show(false); };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (!open) return;
    (wrap.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]')[cursor])?.focus();
  }, [open, cursor]);
  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); show(false); btn.current?.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => (c + 1) % HUB_MODES.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => (c - 1 + HUB_MODES.length) % HUB_MODES.length); }
    else if (e.key === 'Home') { e.preventDefault(); setCursor(0); }
    else if (e.key === 'End') { e.preventDefault(); setCursor(HUB_MODES.length - 1); }
    else if (e.key === 'Tab') show(false);
  };
  return (
    <div ref={wrap} className="hub-switch-wrap">
      <button ref={btn} type="button" className={`hub-switch${mode !== 'msg' ? ' hub-on' : ''}`} aria-haspopup="menu" aria-expanded={open} aria-controls={menuId} aria-label={`모드: ${current.label}`} title="모드 전환"
        onClick={() => show(!open)} onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); show(true); } }}>
        <span className="hub-switch-icon"><HubIcon name={current.icon} /></span>
        {!phone && <span className="hub-switch-label">{current.label}</span>}
        <ChevronDownIcon />
      </button>
      {open && (
        <div id={menuId} className="hub-menu" role="menu" aria-label="모드" onKeyDown={onMenuKey}>
          <div className="hub-menu-head">모드</div>
          {HUB_MODES.map((m, i) => (
            <button key={m.id} type="button" role="menuitemradio" aria-checked={m.id === mode} className={`hub-mi${m.id === mode ? ' on' : ''}`} tabIndex={i === cursor ? 0 : -1}
              onClick={() => pick(m.id)} onMouseEnter={() => setCursor(i)}>
              <span className="hub-mi-icon"><HubIcon name={m.icon} /></span>
              <span className="hub-mi-label">{m.label}</span>
              <kbd className="hub-kbd">{kbd(modeDigit(i))}</kbd>
              <span className="hub-mi-check"><CheckMarkIcon /></span>
            </button>
          ))}
          <div className="hub-menu-foot">{mac ? '⌘1–9·0' : 'Ctrl+1–9·0'} 로 전환 (메뉴가 열린 동안, 터미널 밖에서) · 왼쪽 레일로도 이동 · 읽기 전용</div>
        </div>
      )}
    </div>
  );
}

/** 정상 / 주의 / 장애 counts and the last sync time, for the header (desktop) while the hub is showing. */
export function HubSummary({ status, fetchedAt, error, pushOn }: { status: HubStatus | null; fetchedAt: number | null; error: string | null; pushOn?: boolean }) {
  const n = { ok: 0, warn: 0, down: 0 };
  for (const m of status?.modes ?? []) { if (m.state === 'ok') n.ok++; else if (m.state === 'warn') n.warn++; else if (m.state === 'down') n.down++; }
  return (
    <div className="hub-sum" role="status" aria-label="상태 요약">
      <span className="hub-chip ok"><i />정상 {n.ok}</span>
      <span className="hub-chip warn"><i />주의 {n.warn}</span>
      <span className="hub-chip bad"><i />장애 {n.down}</span>
      <span className="hub-sync">{error ? `갱신 실패 · ${error}` : fetchedAt ? `${pushOn ? '푸시' : '동기화'} ${hhmmss(fetchedAt)}` : '불러오는 중…'}</span>
    </div>
  );
}
