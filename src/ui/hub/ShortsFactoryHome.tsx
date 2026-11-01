/**
 * 영상 › Shorts 공장: the second project tab of the 영상 mode (src/server/hub/shorts.ts ships `mode.shorts`).
 * Read-only: no control anywhere below the tab bar. Every unknown is a word (미공개 · 미수집 · 측정 불가), never a 0 or a bar.
 */
import { useState } from 'react';
import type { HubState, SfAccountState, SfCalendar, SfCalendarDay, SfChannel, SfDistribution, SfFile, SfUploadState, SfLedger, SfLedgerItem, SfLedgerStatus, SfLedgerType, SfPlatformId, ShortsFactoryView } from '../../shared/hub-types';
import { SF_LEDGER_STATUSES, SF_PLATFORMS } from '../../shared/hub-types';
import { Attention, Kpi, Lead } from './HubPage';
import { Spark } from './HubSections';
import { relTime } from './time';
import './shorts.css';

export type VideoProject = 'studio' | 'factory';
export const VIDEO_PROJECT_KEY = 'deck.hubVideoProject';
export const VIDEO_PROJECTS: { id: VideoProject; label: string }[] = [{ id: 'studio', label: 'engineering-shorts' }, { id: 'factory', label: 'Shorts 공장' }];
export function readVideoProject(): VideoProject {
  try { return localStorage.getItem(VIDEO_PROJECT_KEY) === 'factory' ? 'factory' : 'studio'; } catch { return 'studio'; }
}
export function writeVideoProject(p: VideoProject): void {
  try { localStorage.setItem(VIDEO_PROJECT_KEY, p); } catch { /* storage unavailable: not kept */ }
}

const int = (v: number | null | undefined): string => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US'));
const KST_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
/** `11-01 19:54` in Seoul time; '—' when unknown. */
export const kst = (iso: string | null | undefined): string => {
  if (!iso || !Number.isFinite(Date.parse(iso))) return '—';
  const p: Record<string, string> = {};
  for (const x of KST_FMT.formatToParts(new Date(iso))) p[x.type] = x.value;
  return `${p.month}-${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
};
const PLATFORM_KO: Record<SfPlatformId, string> = { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram', x: 'X', other: '기타' };
const FILE_KO: Record<SfFile['state'], string> = { fresh: '최신', stale: '오래됨', placeholder: '자리표시자', missing: '없음', malformed: '형식 오류' };
const ROUTINE_KO: Record<ShortsFactoryView['pipeline']['routine']['status'], string> = { ok: '정상', failed: '실패', running: '실행 중', unknown: '미보고', invalid: '형식 오류' };

const Sec = ({ title, note, right, children, testid, className }: { title: string; note?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode; testid: string; className?: string }) => (
  <section className={`sec open-static sf-sec ${className ?? ''}`} data-testid={testid} aria-label={title}>
    <div className="sh"><span className="sec-title">{title}</span>{note !== undefined && <span className="n">{note}</span>}{right !== undefined && <span className="sf-right">{right}</span>}</div>
    <div className="b">{children}</div>
  </section>
);

/** One line per file that is not fresh: what it is and what to do, in the tone of the data (info for 없음/자리표시자, warn for 오래됨/형식 오류). */
function FileBands({ files, now }: { files: ShortsFactoryView['files']; now: number }) {
  const bands: { file: SfFile; tone: string; what: string }[] = [];
  const say = (f: SfFile, missing: string, placeholder: string) => {
    if (f.state === 'fresh') return;
    const tone = f.state === 'stale' || f.state === 'malformed' ? 'warn' : 'info';
    bands.push({ file: f, tone, what: f.state === 'missing' ? missing : f.state === 'placeholder' ? placeholder : f.note ?? '' });
  };
  say(files.status, '루틴이 아직 status.json 을 쓰지 않았다 · SCHEMA.md 의 routine 블록부터.', '루틴이 아직 status.json 을 쓰지 않았다 · 수집 전 자리표시자.');
  say(files.channels, '채널 데이터 없음 · collect_youtube.py 를 한 번 실행하면 채워진다.', '');
  if (files.history.state === 'missing') bands.push({ file: files.history, tone: 'info', what: '이력 없음 · 수집이 쌓이면 추이가 그려진다.' });
  if (!bands.length) return <div className="sf-band ok" data-testid="sf-band"><b>파일 최신</b> status.json {kst(files.status.at)} · channels.json {kst(files.channels.at)} · history {files.history.rows}줄{files.history.skipped ? ` (깨진 줄 ${files.history.skipped})` : ''}</div>;
  return (
    <div className="sf-bands" data-testid="sf-band">
      {bands.map((b) => <div key={b.file.name} className={`sf-band ${b.tone}`}><b>{b.file.name} {FILE_KO[b.file.state]}</b> {b.what}{b.file.state === 'stale' ? ` · 기록 ${relTime(b.file.at, now)}` : ''}</div>)}
    </div>
  );
}

const NA = ({ text = '미공개' }: { text?: string }) => <span className="sf-na">{text}</span>;

function Channels({ sf }: { sf: ShortsFactoryView }) {
  const rows = [...sf.channels].sort((a, b) => (b.latestViews ?? -1) - (a.latestViews ?? -1) || a.name.localeCompare(b.name));
  const max = Math.max(0, ...rows.map((c) => c.latestViews ?? 0));
  const collected = (c: SfChannel): { text: string; cls: string } => {
    if (c.collection.error) return { text: `실패 · 이전 값 유지 ${kst(c.collection.lastSuccessAt)}`, cls: 'warn' };
    if (!c.collection.lastSuccessAt) return { text: '미수집', cls: 'warn' };
    return { text: `${c.collection.stale ? '오래됨 ' : ''}${kst(c.collection.lastSuccessAt)}`, cls: c.collection.stale ? 'warn' : 'ok' };
  };
  return (
    <Sec title="채널 비교" note={sf.channels.length ? `최신 영상 조회 내림차순 · 개설 ${sf.liveCount}/${sf.plannedTotal}` : undefined} testid="sf-channels">
      {!rows.length ? <div className="sec-empty">채널 데이터 없음 · collect_youtube.py 를 한 번 실행하면 채워진다.</div> : (
        <div className="twrap">
          <table className="t sf-t">
            <thead><tr><th>채널</th><th>업로드 KST</th><th className="n">구독자</th><th className="n">총 조회</th><th className="n">최신 영상 조회</th><th className="w">추이</th><th>수집</th></tr></thead>
            <tbody>
              {rows.map((c, i) => {
                const col = collected(c);
                return (
                  <tr key={c.id} className={i === 0 && c.latestViews !== null ? 'sf-top' : ''} data-testid={`sf-ch-${c.id}`}>
                    <td className="sf-name"><b>{c.name}</b>{c.videos[0]?.title && <span className="sf-dim">{c.videos[0].title}</span>}</td>
                    <td>{c.publishKst ?? <NA text="미정" />}</td>
                    <td className="n">{c.subscribers === null ? <NA /> : int(c.subscribers)}</td>
                    <td className="n">{c.totalViews === null ? <NA /> : int(c.totalViews)}</td>
                    <td className="n sf-latest">{c.latestViews === null ? <NA text="미수집" /> : <><span>{int(c.latestViews)}</span><i className="sf-bar" style={{ width: `${max ? Math.max(2, Math.round((c.latestViews / max) * 100)) : 0}%` }} /></>}</td>
                    <td className="w sf-spark">{c.spark ? <Spark values={c.spark.values} label={c.spark.label} /> : <NA text="이력 없음" />}</td>
                    <td className={`sf-col ${col.cls}`} title={c.collection.error ?? undefined}>{col.text}{c.collection.error && <span className="sf-dim">{c.collection.error}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {sf.channels.length > 0 && <p className="sf-rule">구독자·총 조회는 공개 수집 응답(yt-dlp)에 있을 때만 숫자, 없으면 미공개. 영상 몇 편의 합으로 총 조회를 만들지 않는다. 공개 조회수는 반올림될 수 있어 소폭 감소는 오차일 수 있다. 추이는 history.jsonl 의 최신 영상 조회(2점 이상) 또는 회차별 합.</p>}
    </Sec>
  );
}

function Calendar({ cal, channels: known }: { cal: SfCalendar; channels: SfChannel[] }) {
  const channels = known.length; const ids = new Set(known.map((c) => c.id));
  // Coverage counts distinct known channels with a booking, so two videos on one channel never hide a channel with none.
  const booked = (d: SfCalendarDay | undefined) => (d ? new Set(d.items.filter((i) => i.kind === 'scheduled' && ids.has(i.channelId)).map((i) => i.channelId)).size : 0);
  const scheduledTomorrow = booked(cal.days.find((d) => d.tomorrow));
  const note = cal.unavailable ? `${cal.unavailable} · 예정·게시를 그릴 수 없다` : `${cal.days[0]?.date.slice(5)} – ${cal.days.at(-1)?.date.slice(5)} · 내일 예정 ${scheduledTomorrow}/${channels}`;
  return (
    <Sec title="캘린더 KST" note={note} testid="sf-calendar" className={cal.unavailable ? 'sf-cal-off' : ''}>
      <div className="sf-cal-head" aria-hidden="true">{['월', '화', '수', '목', '금', '토', '일'].map((d) => <span key={d}>{d}</span>)}</div>
      <ol className="sf-cal" aria-label="2주 캘린더">
        {cal.days.map((d) => {
          const sched = booked(d);
          const gap = d.tomorrow && !cal.unavailable && channels > 0 && sched < channels;
          return (
            <li key={d.date} className={`sf-day${d.today ? ' today' : ''}${d.tomorrow ? ' tomorrow' : ''}${gap ? ' gap' : ''}`} data-testid={`sf-day-${d.date}`}>
              <span className="sf-dn"><b>{d.date.slice(5)}</b> <span className="sf-dow">{d.dow}</span>{d.today && <em>오늘</em>}{d.tomorrow && <em>내일</em>}</span>
              {d.items.length ? (
                <ul>{d.items.map((it, k) => <li key={k} className={`sf-it ${it.kind}`} title={it.title ?? undefined}><i className={`hub-dot ${it.kind === 'published' ? 'ok' : 'info'}`} /><span className="sf-tm">{it.time}</span><span className="sf-ch">{it.channelName}</span></li>)}</ul>
              ) : <span className="sf-none">{cal.unavailable ? '' : '—'}</span>}
              {gap && <span className="sf-gap">예정 {sched}/{channels}</span>}
            </li>
          );
        })}
      </ol>
      <p className="sf-rule"><i className="hub-dot info" /> 예정 (status.json scheduled) · <i className="hub-dot ok" /> 게시 (published) · 채널의 계획 시각은 예정으로 치지 않는다.</p>
    </Sec>
  );
}

function Platforms({ channels }: { channels: SfChannel[] }) {
  const KO: Record<string, { text: string; cls: string }> = { live: { text: '개설', cls: 'ok' }, none: { text: '미개설', cls: 'na' }, unknown: { text: '미확인', cls: 'warn' } };
  return (
    <Sec title="플랫폼" note="실제 계정이 생기기 전까지 미개설" testid="sf-platforms">
      {!channels.length ? <div className="sec-empty">채널 데이터 없음</div> : (
        <div className="twrap">
          <table className="t sf-t sf-pt">
            <thead><tr><th>채널</th>{SF_PLATFORMS.map((p) => <th key={p}>{PLATFORM_KO[p]}</th>)}</tr></thead>
            <tbody>{channels.map((c) => <tr key={c.id}><td className="sf-name"><b>{c.name}</b></td>{SF_PLATFORMS.map((p) => { const s = KO[c.platforms[p]] ?? KO.unknown!; return <td key={p} className={`sf-pf ${s.cls}`}>{s.text}</td>; })}</tr>)}</tbody>
          </table>
        </div>
      )}
    </Sec>
  );
}

/* ───────── 플랫폼 배포 (status.json distribution) ───────── */

export const ACCOUNT_KO: Record<SfAccountState, { text: string; cls: string }> = {
  ready: { text: '준비됨', cls: 'ok' }, name_pending: { text: '이름 대기', cls: 'warn' }, created: { text: '개설됨', cls: 'info' }, none: { text: '계정 없음', cls: 'na' },
};
export const UPLOAD_KO: Record<SfUploadState, { text: string; cls: string }> = {
  queued: { text: '대기', cls: 'muted' }, scheduled: { text: '예약', cls: 'info' }, posted: { text: '게시', cls: 'ok' }, failed: { text: '실패', cls: 'bad' },
};
const COUNT_ORDER: SfUploadState[] = ['queued', 'scheduled', 'posted', 'failed'];

function DistMatrix({ d }: { d: SfDistribution }) {
  const [focus, setFocus] = useState<string>('all');
  const nameOf = new Map(d.channels.map((c) => [c.id, c.name]));
  const shorts = (focus === 'all' ? d.shorts : d.shorts.filter((s) => s.channel === focus)).slice(0, 40);
  const ready = (pid: string) => d.channels.filter((c) => c.cells[pid]?.accountState === 'ready').length;
  return (
    <Sec title="플랫폼" note={`채널 ${d.channels.length} × 플랫폼 ${d.platforms.length} · 숏츠 ${d.shortsTotal}편${d.updatedAt ? ` · 원장 ${kst(d.updatedAt)}` : ''}`} testid="sf-dist">
      <div className="twrap">
        <table className="t sf-t sf-dm">
          <thead>
            <tr><th>채널</th>{d.platforms.map((p) => <th key={p.id} title={p.note ?? undefined} className={p.status === 'planned' ? 'sf-dim-h' : ''}>{p.name}<span className="sf-dim">{p.status === 'planned' ? '계획' : `준비 ${ready(p.id)}/${d.channels.length}`}</span></th>)}</tr>
          </thead>
          <tbody>
            {d.channels.map((c) => (
              <tr key={c.id} data-testid={`sf-dist-${c.id}`}>
                <td className="sf-name"><button type="button" className={`sf-link${focus === c.id ? ' on' : ''}`} onClick={() => setFocus(focus === c.id ? 'all' : c.id)}><b>{c.name}</b></button><span className="sf-dim">{[c.lang, c.publishKst].filter(Boolean).join(' · ')}</span></td>
                {d.platforms.map((p) => {
                  const cell = c.cells[p.id]; if (!cell) return <td key={p.id}><NA text="—" /></td>;
                  const a = ACCOUNT_KO[cell.accountState];
                  return (
                    <td key={p.id} className={`sf-dc ${a.cls}`} data-testid={`sf-dc-${c.id}-${p.id}`} data-state={cell.accountState}>
                      <span className={`sf-badge ${a.cls}`}>{a.text}</span>
                      {cell.handle && (cell.url ? <a href={cell.url} target="_blank" rel="noopener noreferrer" className="sf-handle">{cell.handle}</a> : <span className="sf-handle">{cell.handle}</span>)}
                      {COUNT_ORDER.some((k) => cell.counts[k]) && <span className="sf-cnts">{COUNT_ORDER.filter((k) => cell.counts[k]).map((k) => <span key={k} className={`sf-cnt ${UPLOAD_KO[k].cls}`} title={UPLOAD_KO[k].text}>{UPLOAD_KO[k].text} {cell.counts[k]}</span>)}</span>}
                      {cell.views !== null && <span className="sf-dim">조회 {int(cell.views)}</span>}
                      {cell.blockers.length > 0 && <span className="sf-blk" title={cell.blockers.join('\n')}>막힘 {cell.blockers.length}</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot><tr><td>합계</td>{d.platforms.map((p) => { const t = d.totals[p.id]; return <td key={p.id} className="sf-cnts">{t && COUNT_ORDER.some((k) => t[k]) ? COUNT_ORDER.filter((k) => t[k]).map((k) => <span key={k} className={`sf-cnt ${UPLOAD_KO[k].cls}`}>{UPLOAD_KO[k].text} {t[k]}</span>) : <NA text="—" />}</td>; })}</tr></tfoot>
        </table>
      </div>
      {d.blockers.length > 0 && (
        <ul className="sf-list warn" data-testid="sf-dist-blockers">
          {d.blockers.filter((b) => !b.text.endsWith('계정 없음')).map((b, i) => <li key={i}><b>{b.channel}</b> · {d.platforms.find((p) => p.id === b.platform)?.name ?? b.platform} · {b.text}</li>)}
        </ul>
      )}
      <details className="sf-dist-shorts" data-testid="sf-dist-shorts">
        <summary>숏츠별 업로드 {focus === 'all' ? '전체' : nameOf.get(focus)} · 최근 {shorts.length}편</summary>
        <div className="twrap">
          <table className="t sf-t sf-ds">
            <thead><tr><th>숏츠</th><th>채널</th>{d.platforms.map((p) => <th key={p.id}>{p.name}</th>)}</tr></thead>
            <tbody>
              {shorts.map((s) => (
                <tr key={`${s.channel}-${s.id}`} data-testid={`sf-ds-${s.id}`}>
                  <td className="sf-name"><b title={s.title ?? s.id}>{s.title ?? s.id}</b>{s.batch && <span className="sf-dim">{s.batch}</span>}</td>
                  <td>{nameOf.get(s.channel) ?? s.channel}</td>
                  {d.platforms.map((p) => {
                    const u = s.platforms[p.id]; if (!u) return <td key={p.id} className="sf-na">—</td>;
                    const k = UPLOAD_KO[u.state];
                    const label = <span className={`sf-badge ${k.cls}`} title={u.error ?? (u.derived ? '예약 시각 경과 · 게시로 간주' : undefined)}>{k.text}{u.derived ? '*' : ''}</span>;
                    return <td key={p.id}>{u.url ? <a href={u.url} target="_blank" rel="noopener noreferrer">{label}</a> : label}{u.at && <span className="sf-dim">{kst(u.at)}</span>}{u.views !== null && <span className="sf-dim">조회 {int(u.views)}</span>}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <p className="sf-rule">계정: 준비됨 · 이름 대기 · 개설됨 · 계정 없음. 업로드: 대기 · 예약 · 게시 · 실패 (* = 예약 시각이 지나 게시로 간주). 원장은 golf-shorts data/distribution_ledger.json, 바꾸려면 scripts/dist.py mark / account. 채널명을 누르면 아래 목록이 그 채널만 보인다.</p>
    </Sec>
  );
}

function Pipeline({ sf, now }: { sf: ShortsFactoryView; now: number }) {
  const p = sf.pipeline; const r = p.routine;
  const rs = r.status === 'ok' ? 'ok' : r.status === 'failed' ? 'bad' : 'warn';
  const disk = p.disk.usedPct;
  return (
    <Sec title="파이프라인" note={`루틴 ${ROUTINE_KO[r.status]}`} testid="sf-pipeline">
      <dl className="hs-rows sf-rows">
        <div><dt>루틴 상태</dt><dd className={rs}>{ROUTINE_KO[r.status]}</dd></div>
        <div><dt>루틴 마지막 실행</dt><dd>{r.lastRunAt ? `${kst(r.lastRunAt)} · ${relTime(r.lastRunAt, now)}` : <NA text="기록 없음" />}</dd></div>
        <div><dt>마지막 렌더</dt><dd>{p.lastRender.file ? `${p.lastRender.file} · ${relTime(p.lastRender.at, now)}` : <NA text="기록 없음" />}</dd></div>
        <div><dt>게이트 실패</dt><dd className={p.gateFailures === null || p.gateFailures.length ? 'warn' : ''}>{p.gateFailures === null ? '미보고' : p.gateFailures.length ? `${p.gateFailures.length}건` : '없음'}</dd></div>
        <div><dt>대기열</dt><dd className={p.queueDepth === null ? 'warn' : ''}>{p.queueDepth === null ? '미보고' : int(p.queueDepth)}</dd></div>
        <div><dt>디스크 /</dt><dd className={disk === null ? 'warn' : disk > 95 ? 'bad' : disk > 90 ? 'warn' : 'ok'}>{disk === null ? (p.disk.note ?? '측정 불가') : `${disk}%`}</dd></div>
        <div><dt>Claude</dt><dd className={p.claude.state === 'ok' ? 'ok' : 'warn'}>{p.claude.summary}</dd></div>
        <div><dt>Codex</dt><dd className={p.codex.available ? 'ok' : 'warn'}>{p.codex.available ? (p.codex.version ?? '있음') : p.codex.available === false ? '실행 불가' : '확인 불가'}{p.codex.note && <span className="sf-dim"> · {p.codex.note}</span>}</dd></div>
      </dl>
      {p.gateFailures !== null && p.gateFailures.length > 0 && <ul className="sf-list warn" data-testid="sf-gates">{p.gateFailures.map((g, i) => <li key={i}>{g}</li>)}</ul>}
      {p.claude.accounts.length > 0 && (
        <ul className="sf-list" data-testid="sf-claude">
          {p.claude.accounts.map((a) => <li key={a.id} className={a.verdict === 'candidate' ? 'ok' : ''}><b>{a.id}</b> {a.verdict === 'candidate' ? '후보' : '제외'} · {a.detail}</li>)}
        </ul>
      )}
    </Sec>
  );
}

/* ───────── 적용 현황 (reference_ledger.json) ───────── */

export const LEDGER_STATUS_KO: Record<SfLedgerStatus, { text: string; cls: string }> = {
  applied: { text: '적용됨 – 운영 중', cls: 'ok' }, built_off: { text: '구현됨 – 꺼짐', cls: 'warn' }, docs_only: { text: '문서만', cls: 'muted' },
  rejected: { text: '검토 후 제외', cls: 'na' }, todo: { text: '미착수', cls: 'info' }, unknown: { text: '미분류', cls: 'bad' },
};
const LEDGER_TYPE_KO: Record<SfLedgerType, string> = { video: '영상', tool: '도구', post: '게시물', tip: '팁', other: '기타' };
type LedgerFilter = SfLedgerStatus | 'all';

/** A clipped cell: the full text sits in the tooltip, '—' when the field is empty. */
const Clip = ({ text, cls }: { text: string | null; cls?: string }) => (text ? <span className={`sf-clip ${cls ?? ''}`} title={text}>{text}</span> : <NA text="—" />);

function LedgerRow({ it }: { it: SfLedgerItem }) {
  const st = LEDGER_STATUS_KO[it.status];
  const reason = it.status === 'rejected' || it.status === 'unknown' ? (it.statusReason ?? it.statusText) : null;
  return (
    <tr data-testid={`sf-ledger-${it.id}`} data-status={it.status}>
      <td className="sf-ld-date">{it.addedAt ? <><span>{it.addedAt}</span>{it.updatedAt && it.updatedAt !== it.addedAt && <span className="sf-dim">갱신 {it.updatedAt}</span>}</> : <NA text="—" />}</td>
      <td className="sf-name sf-ld-title">{it.url ? <a href={it.url} target="_blank" rel="noopener noreferrer" title={it.url}>{it.title}</a> : <b title={it.title}>{it.title}</b>}</td>
      <td className="sf-ld-type">{LEDGER_TYPE_KO[it.type]}</td>
      <td className="sf-ld-status" title={it.statusReason ?? it.statusText ?? undefined}><span className={`sf-badge ${st.cls}`}>{st.text}</span>{reason && <span className="sf-dim sf-ld-reason">{reason}</span>}</td>
      <td className="sf-ld-text"><Clip text={it.whatWeTook} /></td>
      <td className="sf-ld-text"><Clip text={it.evidence} cls="sf-ev" /></td>
      <td className="sf-ld-text"><Clip text={it.nextAction} /></td>
    </tr>
  );
}

function Ledger({ ledger, now }: { ledger: SfLedger; now: number }) {
  const [filter, setFilter] = useState<LedgerFilter>('all');
  const f = ledger.file;
  const note = f.state === 'missing' ? '파일 없음' : f.state === 'malformed' ? `형식 오류 · ${f.note ?? ''}` : `${ledger.total}건 · ${f.at ? `${relTime(f.at, now)} 갱신` : 'generated_at 없음'}`;
  const shown = filter === 'all' ? ledger.items : ledger.items.filter((it) => it.status === filter);
  const chips: { id: LedgerFilter; text: string; n: number; cls: string }[] = [
    { id: 'all', text: '전체', n: ledger.total, cls: '' },
    ...SF_LEDGER_STATUSES.filter((k) => k !== 'unknown' || ledger.counts.unknown > 0).map((k) => ({ id: k as LedgerFilter, text: LEDGER_STATUS_KO[k].text, n: ledger.counts[k], cls: LEDGER_STATUS_KO[k].cls })),
  ];
  return (
    <Sec title="적용 현황" note={note} testid="sf-ledger">
      {f.state === 'missing' ? <div className="sec-empty">reference_ledger.json 없음 · 참고한 영상·도구·글과 그 적용 결과를 ~/shorts_status/reference_ledger.json 에 적으면 보인다.</div>
        : f.state === 'malformed' ? <div className="sec-empty">reference_ledger.json 형식 오류 · {f.note} · 파일을 고치면 보인다.</div>
        : !ledger.total ? <div className="sec-empty">항목 없음 · items 가 비어 있다.</div> : (
          <>
            <div className="sf-chips" role="group" aria-label="상태 필터" data-testid="sf-ledger-chips">
              {chips.map((c) => <button key={c.id} type="button" className={`sf-chip ${c.cls}${filter === c.id ? ' on' : ''}`} aria-pressed={filter === c.id} data-testid={`sf-ledger-chip-${c.id}`} onClick={() => setFilter(c.id)}>{c.text}<span className="sf-chip-n">{c.n}</span></button>)}
            </div>
            {!shown.length ? <div className="sec-empty">해당 상태의 항목 없음</div> : (
              <div className="twrap">
                <table className="t sf-t sf-ld">
                  <thead><tr><th>추가일</th><th>제목</th><th>유형</th><th>상태</th><th>가져온 것</th><th>근거</th><th>다음 할 일</th></tr></thead>
                  <tbody>{shown.map((it) => <LedgerRow key={it.id} it={it} />)}</tbody>
                </table>
              </div>
            )}
            <p className="sf-rule">추가일 내림차순 (같으면 갱신일). 상태는 적용됨 – 운영 중 · 구현됨 – 꺼짐 · 문서만 · 검토 후 제외 · 미착수 다섯 가지, 그 밖은 미분류. 근거는 커밋·경로·플래그 그대로.{ledger.truncated ? ` 최근 ${ledger.items.length}건만 표시 (${ledger.truncated}건 생략).` : ''}{ledger.skipped ? ` id 또는 title 없는 ${ledger.skipped}건 건너뜀.` : ''}</p>
          </>
        )}
    </Sec>
  );
}

/** What the page header shows while this project is selected: its own state, the newest file time, the three files as sources. */
export function sfHeader(sf: ShortsFactoryView): { state: HubState; lastActivity: string | null; sources: { name: string; ok: boolean; label: string }[] } {
  const files = [sf.files.status, sf.files.channels, sf.files.history];
  const at = files.map((f) => f.at).filter((a): a is string => a !== null).sort().at(-1) ?? null;
  const word: Record<SfFile['state'], string> = { fresh: '최신', stale: '오래됨', placeholder: '자리표시자', missing: '없음', malformed: '형식 오류' };
  return { state: sf.state, lastActivity: at, sources: files.map((f) => ({ name: f.name, ok: f.state === 'fresh', label: word[f.state] })) };
}

export function ShortsFactoryHome({ sf, now }: { sf: ShortsFactoryView; now: number }) {
  const warn = sf.alerts.filter((a) => a.level !== 'info').length;
  return (
    <div className="sf" data-testid="sf-root">
      <FileBands files={sf.files} now={now} />
      <Lead state={sf.state} headline={sf.headline} decision={sf.decision} />
      <div className="kpis" data-testid="sf-kpis">{sf.kpis.map((k, i) => <Kpi key={i} k={k} />)}</div>
      <section className="sec open-static" aria-label="Shorts 공장 주의" data-testid="sf-alerts">
        <div className="sh"><span className="sec-title">주의</span>{warn < sf.alerts.length && <span className="n">참고 {sf.alerts.length - warn}</span>}<span className="cnt">{sf.alerts.length}</span></div>
        <Attention alerts={sf.alerts} now={now} />
      </section>
      <Channels sf={sf} />
      <Calendar cal={sf.calendar} channels={sf.channels} />
      {sf.distribution ? <DistMatrix d={sf.distribution} /> : null}
      <div className="sf-grid">
        {!sf.distribution && <Platforms channels={sf.channels} />}
        <Pipeline sf={sf} now={now} />
      </div>
      <Ledger ledger={sf.ledger} now={now} />
      <Sec title="루틴 로그 꼬리" note={sf.pipeline.routine.logTail.length ? `${sf.pipeline.routine.logTail.length}줄` : undefined} testid="sf-log">
        {sf.pipeline.routine.logTail.length ? <pre className="sf-log">{sf.pipeline.routine.logTail.join('\n')}</pre> : <div className="sec-empty">로그 꼬리 없음 · 루틴이 status.json 의 routine.log_tail 을 채우면 보인다.</div>}
      </Sec>
      {(sf.notes.length > 0 || sf.unmappedReference.length > 0) && (
        <Sec title="메모" testid="sf-notes">
          {sf.notes.length > 0 && <ul className="sf-list">{sf.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
          {sf.unmappedReference.length > 0 && (
            <div className="sf-ref">
              <p className="sf-rule">참고 관측 · 채널 미지정 (user_reference, 매핑되면 자동으로 채널 추이에 합쳐진다)</p>
              <ul className="sf-list">{sf.unmappedReference.map((r) => <li key={`${r.videoId}-${r.at}`}><b>{r.videoId}</b> {r.views === null ? '조회 미기록' : `${int(r.views)}회`} · {kst(r.at)}</li>)}</ul>
            </div>
          )}
        </Sec>
      )}
    </div>
  );
}
