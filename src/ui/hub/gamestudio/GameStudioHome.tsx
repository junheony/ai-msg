import { useEffect, useRef, useState } from 'react';
import type { GameStudio, StudioAgent, StudioArtifact, StudioEvent, StudioGame, StudioStage } from '../../../shared/hub-types';
import { ExternalIcon } from '../HubIcons';
import { relTime } from '../time';
import { AgentAvatar, agentName, agentStateText } from './AgentAvatar';
import './game-studio.css';

/**
 * 게임 스튜디오 as a calm game lobby (read-only). One summary line and the party of agents; then one cartridge per game
 * that says only what matters at a glance — cover, title, where it is on the quest track, and the one next move — with
 * everything else behind 자세히; then the latest loot, the quest log and how a new game is made. The only controls are
 * links, "더 보기" toggles and a viewer for a thumbnail.
 */

const KST = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
/** `10. 31. 20:28` → `10-31 20:28` (Seoul time). */
export function kst(iso: string | null): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return '기록 없음';
  const p = Object.fromEntries(KST.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.month}-${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}

const STATUS_LABEL: Record<StudioGame['status'], string> = { live: '출시', candidate: '출시 후보', building: '제작 중', concept: '콘셉트', paused: '보류', unknown: '상태 미상' };
const STAGE_STATE: Record<StudioStage['state'], string> = { done: '완료', active: '진행 중', blocked: '막힘', todo: '대기' };

/** Phones get a shorter page: fewer loot tiles before "더 보기". */
function useNarrow(): boolean {
  const q = '(max-width: 640px)';
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(q).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const m = window.matchMedia(q);
    const on = () => setNarrow(m.matches);
    m.addEventListener?.('change', on);
    return () => m.removeEventListener?.('change', on);
  }, []);
  return narrow;
}

/* ───────── summary + party ───────── */

function Summary({ s }: { s: GameStudio['summary'] }) {
  return (
    <p className="gs-summary" data-testid="gs-lobby">
      <span className={s.working ? 'on' : ''}>작업 중 <b>{s.working}</b></span>
      <span className={s.owner ? 'owner' : ''}>오너 확인 <b>{s.owner}</b></span>
      <span className={s.blocked ? 'warn' : ''}>막힘 <b>{s.blocked}</b></span>
      <span>출시 <b>{s.released}</b></span>
      <span>게임 <b>{s.games}</b></span>
    </p>
  );
}

/** The BRIEF title without the game name ("BBAI Brawl — 웹 3차 QA" → "웹 3차 QA"). */
const taskOf = (a: StudioAgent): string => {
  const t = a.title ?? a.job;
  const g = a.gameTitle?.replace(/\s*v?\d[\d.]*$/, '');
  const cut = g && t.toLowerCase().startsWith(g.toLowerCase()) ? t.slice(g.length).replace(/^[\s:·—–-]+/, '') : t;
  return cut || t;
};

/** One party member: the face, the job, its state and game; the rest (who, task, last line, time) shows on hover/focus. */
function Member({ a, now }: { a: StudioAgent; now: number }) {
  const tip = `gs-tip-${a.job}`;
  return (
    <li className={`gs-member st-${a.state}`} data-testid="gs-agent">
      <button type="button" className="gs-member-btn" aria-describedby={tip}>
        <AgentAvatar account={a.account} state={a.state} size={48} />
        <span className="gs-member-name">{a.job}</span>
        <span className="gs-member-state"><b>{agentStateText(a)}</b>{a.gameTitle ? <span className="gs-member-game"> · {a.gameTitle}</span> : null}</span>
      </button>
      <div className="gs-tip" role="tooltip" id={tip}>
        <p className="gs-tip-game">{agentName(a)}{a.gameTitle ? ` · ${a.gameTitle}` : ''}</p>
        <p className="gs-tip-task">{taskOf(a)}</p>
        <p className="gs-tip-line">{(a.state === 'blocked' || a.state === 'stopped' || a.state === 'needs-owner') && a.reason ? a.reason : a.line ?? '로그 기록 없음'}</p>
        <p className="gs-tip-meta">{a.job} · {a.lineAt ? `마지막 로그 ${relTime(a.lineAt, now)}` : '로그 없음'}</p>
      </div>
    </li>
  );
}

/** Finished work folds under 지난 작업; so does an idle job with no sign of life for hours. Live, asking and blocked stay out. */
const IDLE_PAST_MS = 3 * 60 * 60_000;
const isPast = (a: StudioAgent, now: number): boolean => a.state === 'done' || a.state === 'superseded' || a.state === 'stopped' || (a.state === 'idle' && !!a.lineAt && now - Date.parse(a.lineAt) > IDLE_PAST_MS);

function Party({ agents, others, now }: { agents: StudioAgent[]; others: GameStudio['others']; now: number }) {
  const [showPast, setShowPast] = useState(false);
  const current = agents.filter((a) => !isPast(a, now));
  const past = agents.filter((a) => isPast(a, now));
  return (
    <section className="gs-party" aria-label="파티">
      {current.length > 0 ? <ul className="gs-members">{current.map((a) => <Member key={a.job} a={a} now={now} />)}</ul>
        : <p className="gs-muted">{agents.length === 0 ? '연결된 에이전트 없음' : '지금 작업 중인 에이전트 없음'}</p>}
      {past.length > 0 && <button type="button" className="gs-link-btn gs-past-btn" aria-expanded={showPast} onClick={() => setShowPast((v) => !v)}>지난 작업 ({past.length})</button>}
      {others.count > 0 && <p className="gs-others" title={others.names.join(', ')}>다른 프로젝트 에이전트 {others.count}</p>}
      {showPast && <ul className="gs-members gs-members-past" data-testid="gs-past">{past.map((a) => <Member key={a.job} a={a} now={now} />)}</ul>}
    </section>
  );
}

/* ───────── cartridge ───────── */

/** Where the game is, in plain Korean: "오너 승인 기다리는 중", "빌드에서 막힘", "출시 완료". */
function statusLine(stages: StudioStage[], ownerCall: boolean): string {
  const cur = stages.find((s) => s.state === 'active' || s.state === 'blocked');
  if (!cur) return stages.every((s) => s.state === 'done') ? '모든 단계 완료' : '기록 없음';
  if (cur.state === 'blocked') return `${cur.label}에서 막힘`;
  if (cur.id === 'approval') return ownerCall ? '오너 승인 기다리는 중' : '승인 요청 전';
  return `${cur.label} 진행 중`;
}

function QuestTrack({ stages, ownerCall }: { stages: StudioStage[]; ownerCall: boolean }) {
  const done = stages.filter((s) => s.state === 'done').length;
  const cur = stages.find((s) => s.state === 'active' || s.state === 'blocked');
  return (
    <div className={`gs-quest${cur?.state === 'blocked' ? ' warn' : ''}`}>
      <ol className="gs-track" aria-label={`퀘스트 ${done}/${stages.length}${cur ? ` · 지금 ${cur.label}` : ''}`}>
        {stages.map((s) => (
          <li key={s.id} className={`gs-dot ${s.state}`} title={`${s.label} · ${STAGE_STATE[s.state]}`} aria-label={`${s.label} ${STAGE_STATE[s.state]}`} />
        ))}
      </ol>
      <p className="gs-quest-now"><b>{statusLine(stages, ownerCall)}</b> <span>{done}/{stages.length}</span></p>
    </div>
  );
}

function Cartridge({ g, now, onOpen }: { g: StudioGame; now: number; onOpen: (a: StudioArtifact) => void }) {
  const blocked = g.stages.some((s) => s.state === 'blocked');
  const ownerCall = !!g.nextAction?.owner;
  return (
    <article className={`gs-cart${blocked ? ' is-blocked' : ''}`} data-testid="gs-cart">
      <div className={`gs-cart-art${g.cover ? '' : ' empty'}`}>
        {g.cover ? (
          <button type="button" className="gs-cover" onClick={() => onOpen(g.cover!)} aria-label={`${g.title} 표지 크게 보기`}>
            <img src={g.cover.src} alt="" loading="lazy" decoding="async" />
          </button>
        ) : <div className="gs-cover none" aria-hidden="true"><span>{g.title.slice(0, 1)}</span></div>}
        <span className="gs-badge">{STATUS_LABEL[g.status]}</span>
      </div>
      <div className="gs-cart-body">
        <div className="gs-cart-head">
          <h3>{g.title}{g.version && !g.title.includes(g.version) ? <span className="gs-ver">v{g.version}</span> : null}</h3>
          {g.play && <a className="gs-btn play" href={g.play.href} target="_blank" rel="noopener noreferrer"><span aria-hidden="true">▶</span> 플레이</a>}
        </div>
        <QuestTrack stages={g.stages} ownerCall={ownerCall} />
        {g.nextAction && (
          <p className={`gs-next${ownerCall ? ' owner' : ''}`} data-testid="gs-next">
            <span className="gs-next-k">{ownerCall ? '오너 OK 필요' : blocked ? '막힘 해결' : '다음 행동'}</span>
            <span className="gs-next-t">{g.nextAction.text}</span>
          </p>
        )}
        <details className="gs-more">
          <summary>자세히</summary>
          <dl>
            {g.titleKo && <div><dt>이름</dt><dd>{g.titleKo}</dd></div>}
            {(g.genre || g.engine) && <div><dt>장르</dt><dd>{[g.genre, g.engine].filter(Boolean).join(' · ')}</dd></div>}
            {g.reference && <div><dt>레퍼런스</dt><dd>{g.referenceTitle ?? g.reference}</dd></div>}
            <div><dt>마지막 활동</dt><dd>{relTime(g.lastAt, now)}</dd></div>
            {g.facts && <div><dt>검증</dt><dd>{g.facts.verifiedAt ? `${kst(g.facts.verifiedAt)}${g.facts.tests ? ` · ${g.facts.tests}` : ''}` : '기록 없음'}</dd></div>}
            {g.repos.map((r, i) => <div key={`r${i}`}><dt>{r.label}</dt><dd>{[r.branch, r.remote, r.readonly ? '읽기 전용' : null].filter(Boolean).join(' · ') || '로컬'}</dd></div>)}
            {g.tests.map((t, i) => <div key={`t${i}`}><dt>{t.label}</dt><dd className={t.found ? '' : 'miss'}>{t.found ? kst(t.at) : '파일 없음'}</dd></div>)}
            {g.stages.filter((s) => s.note).map((s) => <div key={s.id}><dt>{s.label}</dt><dd>{s.note}</dd></div>)}
            {g.jobs.length > 0 && <div><dt>에이전트</dt><dd>{g.jobs.join(', ')}</dd></div>}
          </dl>
          {g.previews.length > 0 && (
            <p className="gs-more-links">{g.previews.map((p) => <a key={p.href} href={p.href} target="_blank" rel="noopener noreferrer">{p.label} <ExternalIcon /></a>)}</p>
          )}
        </details>
      </div>
    </article>
  );
}

/* ───────── loot ───────── */

const GROUP_LABEL: Record<StudioArtifact['group'], string> = { screenshots: '스크린샷', concept: '콘셉트 아트', builds: '빌드', video: '영상', cover: '표지' };

function Loot({ loot, onOpen }: { loot: StudioArtifact[]; onOpen: (a: StudioArtifact) => void }) {
  const narrow = useNarrow();
  const [more, setMore] = useState(false);
  const cap = narrow ? 4 : 6;
  const shown = more ? loot : loot.slice(0, cap);
  return (
    <section className="gs-sec gs-loot" aria-labelledby="gs-loot-h">
      <h2 id="gs-loot-h">결과물</h2>
      {shown.length === 0 ? <p className="gs-muted">결과물 기록 없음</p> : (
        <ul className="gs-loot-grid">
          {shown.map((a) => (
            <li key={a.src}>
              <button type="button" className="gs-thumb" onClick={() => onOpen(a)} aria-label={`${a.gameTitle} ${a.name} 크게 보기`}>
                {a.kind === 'video' ? <video src={`${a.src}#t=0.5`} preload="metadata" muted playsInline /> : <img src={a.src} alt="" loading="lazy" decoding="async" />}
                {a.kind === 'video' && <span className="gs-thumb-play" aria-hidden="true">▶</span>}
              </button>
              <p className="gs-thumb-cap">{a.gameTitle}</p>
            </li>
          ))}
        </ul>
      )}
      {loot.length > cap && <button type="button" className="gs-link-btn" onClick={() => setMore((v) => !v)}>{more ? '접기' : `더 보기 (${loot.length - cap})`}</button>}
    </section>
  );
}

function Viewer({ a, onClose }: { a: StudioArtifact; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && typeof d.showModal === 'function' && !d.open) d.showModal();
  }, []);
  return (
    <dialog ref={ref} className="gs-viewer" onClose={onClose} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} aria-label={`${a.gameTitle} ${a.name}`}>
      <div className="gs-viewer-in">
        {a.kind === 'video' ? <video src={a.src} controls autoPlay muted playsInline /> : <img src={a.src} alt={`${a.gameTitle} ${a.name}`} />}
        <p className="gs-viewer-cap"><b>{a.gameTitle}</b><span>{a.name}</span><span>{GROUP_LABEL[a.group]}{a.job ? ` · ${a.job}` : ''}</span><span>{kst(a.at)} KST</span>
          <a href={a.src} target="_blank" rel="noopener noreferrer">원본 열기 <ExternalIcon /></a>
          <button type="button" className="gs-link-btn" onClick={onClose} autoFocus>닫기</button>
        </p>
      </div>
    </dialog>
  );
}

/* ───────── quest log ───────── */

function QuestLog({ feed, now }: { feed: StudioEvent[]; now: number }) {
  const [more, setMore] = useState(false);
  const shown = more ? feed : feed.slice(0, 5);
  return (
    <section className="gs-sec gs-log" aria-labelledby="gs-log-h">
      <h2 id="gs-log-h">퀘스트 로그</h2>
      {feed.length === 0 ? <p className="gs-muted">기록 없음</p> : (
        <ol className="gs-feed">
          {shown.map((e, i) => (
            <li key={i} className={e.level === 'bad' || e.level === 'warn' ? e.level : ''}>
              <span className="gs-feed-t" title={e.text}>{e.text}</span>
              <time dateTime={e.at} title={`${kst(e.at)} KST`}>{relTime(e.at, now)}</time>
            </li>
          ))}
        </ol>
      )}
      {feed.length > 5 && <button type="button" className="gs-link-btn" onClick={() => setMore((v) => !v)}>{more ? '접기' : `더 보기 (${feed.length - 5})`}</button>}
    </section>
  );
}

/* ───────── new game ───────── */

function NewGame({ studio }: { studio: GameStudio }) {
  return (
    <section className="gs-new" aria-labelledby="gs-new-h">
      <h2 id="gs-new-h">새 게임 만들기</h2>
      <p>있는 게임 하나를 레퍼런스로 골라 템플릿을 복제합니다.</p>
      <p>콘셉트부터 출시까지 7단계, 증거 파일이 생기면 트랙에 자동 표시됩니다.</p>
      <p>실행은 터미널에서, 출시는 언제나 오너 OK 뒤에.</p>
      {studio.pipeline.doc && <a className="gs-new-link" href={studio.pipeline.doc} target="_blank" rel="noopener noreferrer">파이프라인 문서 <ExternalIcon /></a>}
    </section>
  );
}

/* ───────── the view ───────── */

export function GameStudioHome({ studio, now }: { studio: GameStudio; now: number }) {
  const [open, setOpen] = useState<StudioArtifact | null>(null);
  return (
    <div className="gs" data-testid="game-studio">
      <div className="gs-top">
        <Summary s={studio.summary} />
        <Party agents={studio.agents} others={studio.others} now={now} />
      </div>
      {studio.error && <div className="hub-notice" role="status">{studio.error}</div>}
      <section className="gs-sec" aria-labelledby="gs-carts-h">
        <h2 id="gs-carts-h">게임</h2>
        <div className="gs-cart-grid">{studio.games.map((g) => <Cartridge key={g.id} g={g} now={now} onOpen={setOpen} />)}</div>
      </section>
      <div className="gs-split">
        <Loot loot={studio.loot} onOpen={setOpen} />
        <div className="gs-side">
          <QuestLog feed={studio.feed} now={now} />
          <NewGame studio={studio} />
        </div>
      </div>
      {open && <Viewer a={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
