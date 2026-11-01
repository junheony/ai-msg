import { useEffect, useMemo, useRef, useState } from 'react';
import type { GameStudio, StudioAgent, StudioArtifact, StudioEvent, StudioGame, StudioStage } from '../../../shared/hub-types';
import { ExternalIcon } from '../HubIcons';
import { relTime } from '../time';
import { AGENT_STATE_LABEL, AgentAvatar, agentName } from './AgentAvatar';
import './game-studio.css';

/**
 * 게임 스튜디오 as a game lobby (read-only): the party of agents at work, one cartridge per game with its quest track
 * and the single next move, the loot the agents produced, the quest log, and how a new game is made from a reference.
 * Nothing here runs anything: the only controls are links (play/preview open in a new tab), a gallery filter and a
 * viewer for a thumbnail.
 */

const KST = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
/** `10. 31. 20:28` → `10-31 20:28` (Seoul time). */
export function kst(iso: string | null): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return '기록 없음';
  const p = Object.fromEntries(KST.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.month}-${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}

const STATUS_LABEL: Record<StudioGame['status'], string> = { live: '출시', candidate: '출시 후보', building: '제작 중', concept: '콘셉트', paused: '보류', unknown: '상태 미상' };
const ROLE_OF: Record<StudioStage['id'], string> = { concept: '기획', assets: '아트', build: '빌드', test: 'QA', preview: 'QA', approval: '오너', release: '릴리스' };

/* ───────── lobby head ───────── */

function LobbyBar({ s }: { s: GameStudio['summary'] }) {
  const items: { k: string; n: number; cls: string }[] = [
    { k: '작업 중 에이전트', n: s.working, cls: 'work' },
    { k: '오너 확인 필요', n: s.owner, cls: 'owner' },
    { k: '막힘', n: s.blocked, cls: 'blocked' },
    { k: '출시', n: s.released, cls: 'live' },
  ];
  return (
    <div className="gs-lobby" data-testid="gs-lobby">
      <p className="gs-lobby-line" aria-label="한눈에 보기">
        {items.map((it) => <span key={it.k} className={`gs-count ${it.cls}${it.n ? '' : ' zero'}`}><b>{it.n}</b>{it.k}</span>)}
        <span className="gs-count games"><b>{s.games}</b>게임</span>
      </p>
    </div>
  );
}

/* ───────── party ───────── */

/** The BRIEF title without the game name the tag above already shows ("BBAI Brawl — 웹 3차 QA" → "웹 3차 QA"). */
const taskOf = (a: StudioAgent): string => {
  const t = a.title ?? a.job;
  const g = a.gameTitle?.replace(/\s*v?\d[\d.]*$/, '');
  const cut = g && t.toLowerCase().startsWith(g.toLowerCase()) ? t.slice(g.length).replace(/^[\s:·—–-]+/, '') : t;
  return cut || t;
};

function AgentCard({ a, now }: { a: StudioAgent; now: number }) {
  return (
    <li className={`gs-agent st-${a.state} acc-${a.account}`} data-testid="gs-agent">
      <AgentAvatar account={a.account} state={a.state} />
      <div className="gs-agent-body">
        <p className="gs-agent-head">
          <b>{agentName(a)}</b>
          {a.model && <span className="gs-agent-model">{a.model}</span>}
          <span className={`gs-agent-state st-${a.state}`}>{AGENT_STATE_LABEL[a.state]}</span>
        </p>
        {a.gameTitle && <span className="gs-agent-game">{a.gameTitle}</span>}
        <p className="gs-agent-task" title={a.title ?? a.job}>{taskOf(a)}</p>
        <p className="gs-agent-line">{a.state === 'blocked' && a.reason ? a.reason : a.line ?? '로그 기록 없음'}</p>
        <p className="gs-agent-meta"><span>{a.job}</span><span>{a.lineAt ? `마지막 로그 ${relTime(a.lineAt, now)}` : '로그 없음'}</span></p>
      </div>
    </li>
  );
}

function Party({ agents, others, now }: { agents: StudioAgent[]; others: GameStudio['others']; now: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? agents : agents.slice(0, 6);
  return (
    <section className="gs-sec gs-party" aria-labelledby="gs-party-h">
      <header className="gs-sh">
        <h2 id="gs-party-h">파티</h2>
        <span className="gs-sh-note">게임에 연결된 에이전트 {agents.length}명 · 작업 중 {agents.filter((a) => a.state === 'working').length}</span>
      </header>
      {agents.length === 0 ? <p className="gs-empty">연결된 에이전트 기록 없음 — 매니페스트의 jobs에 ~/jobs 이름을 적으면 여기 나타납니다.</p> : (
        <ul className="gs-agents">{shown.map((a) => <AgentCard key={a.job} a={a} now={now} />)}</ul>
      )}
      <div className="gs-party-foot">
        {agents.length > 6 && <button type="button" className="gs-link-btn" onClick={() => setAll((v) => !v)}>{all ? '접기' : `나머지 ${agents.length - 6}명 보기`}</button>}
        {others.count > 0 && (
          <details className="gs-others">
            <summary>다른 프로젝트 에이전트 {others.count}{others.working ? ` · 작업 중 ${others.working}` : ''}</summary>
            <p>{others.names.join(', ')}</p>
          </details>
        )}
      </div>
    </section>
  );
}

/* ───────── cartridge ───────── */

function QuestTrack({ stages }: { stages: StudioStage[] }) {
  const done = stages.filter((s) => s.state === 'done').length;
  const current = stages.find((s) => s.state === 'active' || s.state === 'blocked');
  return (
    <div className="gs-quest">
      <ol className="gs-track" aria-label={`퀘스트 ${done}/${stages.length}${current ? ` · 지금 ${current.label}` : ''}`}>
        {stages.map((s, i) => (
          <li key={s.id} className={`gs-node ${s.state}`} title={`${s.label} · ${s.state === 'done' ? '완료' : s.state === 'active' ? '진행 중' : s.state === 'blocked' ? '막힘' : '대기'}${s.note ? ` · ${s.note}` : ''}${s.at ? ` · ${kst(s.at)}` : ''}`}>
            <span className="gs-pip" aria-hidden="true">{s.state === 'done' ? '✓' : s.state === 'blocked' ? '!' : i + 1}</span>
            <span className="gs-node-label">{s.label}</span>
          </li>
        ))}
      </ol>
      <p className="gs-quest-now">{current ? <><b>{current.label}</b> {current.state === 'blocked' ? '막힘' : '진행 중'} · {done}/{stages.length} 단계 완료</> : done === stages.length ? '모든 단계 완료' : `${done}/${stages.length} 단계 완료`}</p>
    </div>
  );
}

function Cartridge({ g, now, onOpen }: { g: StudioGame; now: number; onOpen: (a: StudioArtifact) => void }) {
  const blocked = g.stages.some((s) => s.state === 'blocked');
  const ownerCall = g.nextAction?.owner || g.approvals.some((a) => a.state === 'pending');
  return (
    <article className={`gs-cart status-${g.status}${blocked ? ' is-blocked' : ''}`} data-testid="gs-cart">
      <div className="gs-cart-art">
        {g.cover ? (
          <button type="button" className="gs-cover" onClick={() => onOpen(g.cover!)} aria-label={`${g.title} 표지 크게 보기`}>
            <img src={g.cover.src} alt="" loading="lazy" decoding="async" />
          </button>
        ) : <div className="gs-cover none" aria-hidden="true"><span>{g.title.slice(0, 1)}</span></div>}
        <span className={`gs-badge status-${g.status}`}>{STATUS_LABEL[g.status]}</span>
        <div className="gs-cart-title">
          <h3>{g.title}{g.version && !g.title.includes(g.version) ? <span className="gs-ver">v{g.version}</span> : null}</h3>
          {g.titleKo && <p>{g.titleKo}</p>}
        </div>
      </div>
      <div className="gs-cart-body">
        <p className="gs-cart-meta">
          {g.genre && <span>{g.genre}</span>}
          {g.engine && <span>{g.engine}</span>}
          <span>마지막 활동 {relTime(g.lastAt, now)}</span>
        </p>
        {g.reference && <p className="gs-lineage">레퍼런스 <b>{g.referenceTitle ?? g.reference}</b> 에서 파생</p>}
        <QuestTrack stages={g.stages} />
        {g.nextAction && (
          <div className={`gs-next${ownerCall ? ' owner' : blocked ? ' blocked' : ''}`} data-testid="gs-next">
            <span className="gs-next-k">{ownerCall ? '오너 OK 필요' : blocked ? '막힘 해결' : '다음 행동'}</span>
            <p>{g.nextAction.text}</p>
          </div>
        )}
        <div className="gs-cart-actions">
          {g.play && <a className="gs-btn play" href={g.play.href} target="_blank" rel="noopener noreferrer"><span aria-hidden="true">▶</span> 플레이</a>}
          {g.previews.map((p) => <a key={p.href} className="gs-btn" href={p.href} target="_blank" rel="noopener noreferrer" title={p.label}>{p.label.length > 18 ? '미리보기' : p.label} <ExternalIcon /></a>)}
          {!g.play && g.previews.length === 0 && <span className="gs-muted">플레이 가능한 빌드 기록 없음</span>}
        </div>
        <details className="gs-cart-more">
          <summary>기록 · 저장소 {g.repos.length} · 테스트 {g.tests.length} · 에이전트 {g.jobs.length}</summary>
          <dl>
            {g.facts && <><dt>검증</dt><dd>{g.facts.verifiedAt ? `${kst(g.facts.verifiedAt)}${g.facts.tests ? ` · ${g.facts.tests}` : ''}` : '기록 없음'}</dd></>}
            {g.repos.map((r, i) => <div key={i} className="gs-dl-row"><dt>{r.label}</dt><dd>{[r.branch, r.remote, r.readonly ? '읽기 전용' : null].filter(Boolean).join(' · ') || '로컬'}</dd></div>)}
            {g.tests.map((t, i) => <div key={`t${i}`} className="gs-dl-row"><dt>{t.label}</dt><dd className={t.found ? 'ok' : 'miss'}>{t.found ? kst(t.at) : '파일 없음'}</dd></div>)}
            {g.stages.filter((s) => s.note).map((s) => <div key={s.id} className="gs-dl-row"><dt>{s.label}</dt><dd>{s.note}</dd></div>)}
          </dl>
        </details>
      </div>
    </article>
  );
}

/* ───────── loot ───────── */

const GROUP_LABEL: Record<StudioArtifact['group'], string> = { screenshots: '스크린샷', concept: '콘셉트 아트', builds: '빌드', video: '영상', cover: '표지' };

function Loot({ loot, games, onOpen }: { loot: StudioArtifact[]; games: StudioGame[]; onOpen: (a: StudioArtifact) => void }) {
  const [game, setGame] = useState<string | null>(null);
  const withLoot = games.filter((g) => loot.some((a) => a.game === g.id));
  const shown = (game ? loot.filter((a) => a.game === game) : loot).slice(0, 12);
  return (
    <section className="gs-sec gs-loot" aria-labelledby="gs-loot-h">
      <header className="gs-sh">
        <h2 id="gs-loot-h">획득한 결과물</h2>
        <span className="gs-sh-note">게임별 최신순 · 누르면 크게</span>
      </header>
      {withLoot.length > 1 && (
        <div className="gs-chips" role="group" aria-label="게임별 보기">
          <button type="button" className={`gs-chip${game === null ? ' on' : ''}`} aria-pressed={game === null} onClick={() => setGame(null)}>전체</button>
          {withLoot.map((g) => <button key={g.id} type="button" className={`gs-chip${game === g.id ? ' on' : ''}`} aria-pressed={game === g.id} onClick={() => setGame(g.id)}>{g.title}</button>)}
        </div>
      )}
      {shown.length === 0 ? <p className="gs-empty">결과물 기록 없음</p> : (
        <ul className="gs-loot-grid">
          {shown.map((a) => (
            <li key={a.src}>
              <button type="button" className="gs-thumb" onClick={() => onOpen(a)} aria-label={`${a.gameTitle} ${a.name} 크게 보기`}>
                {a.kind === 'video' ? <video src={`${a.src}#t=0.5`} preload="metadata" muted playsInline /> : <img src={a.src} alt="" loading="lazy" decoding="async" />}
                {a.kind === 'video' && <span className="gs-thumb-play" aria-hidden="true">▶</span>}
              </button>
              <p className="gs-thumb-cap"><b>{a.gameTitle}</b><span>{GROUP_LABEL[a.group]}{a.job ? ` · ${a.job}` : ''}</span><span>{kst(a.at)}</span></p>
            </li>
          ))}
        </ul>
      )}
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

const KIND_GLYPH: Record<StudioEvent['kind'], string> = { stage: '◆', loot: '✦', agent: '●', report: '■', approval: '★' };

function QuestLog({ feed, now }: { feed: StudioEvent[]; now: number }) {
  const [more, setMore] = useState(false);
  const shown = more ? feed : feed.slice(0, 8);
  return (
    <section className="gs-sec gs-log" aria-labelledby="gs-log-h">
      <header className="gs-sh"><h2 id="gs-log-h">퀘스트 로그</h2><span className="gs-sh-note">게임·에이전트 소식</span></header>
      {feed.length === 0 ? <p className="gs-empty">기록 없음</p> : (
        <ol className="gs-feed">
          {shown.map((e, i) => (
            <li key={i} className={`k-${e.kind} ${e.level ?? ''}`}>
              <span className="gs-feed-g" aria-hidden="true">{KIND_GLYPH[e.kind]}</span>
              <span className="gs-feed-t">{e.text}</span>
              <time dateTime={e.at} title={`${kst(e.at)} KST`}>{relTime(e.at, now)}</time>
            </li>
          ))}
        </ol>
      )}
      {feed.length > 8 && <button type="button" className="gs-link-btn" onClick={() => setMore((v) => !v)}>{more ? '접기' : `이전 소식 ${feed.length - 8}개 더`}</button>}
    </section>
  );
}

/* ───────── pipeline ───────── */

function Pipeline({ studio }: { studio: GameStudio }) {
  const roots = studio.games.filter((g) => !g.reference || !studio.games.some((x) => x.id === g.reference));
  const kids = (id: string) => studio.games.filter((g) => g.reference === id);
  const STEPS: { id: StudioStage['id']; text: string }[] = [
    { id: 'concept', text: 'CONCEPT.md에 한 줄 콘셉트·핵심 재미·화면 스케치' },
    { id: 'assets', text: 'CC0 또는 직접 만든 에셋만, assets/LICENSES.md에 출처 기록' },
    { id: 'build', text: '레퍼런스 구조를 그대로 빌드, dist/에 플레이 가능한 HTML' },
    { id: 'test', text: '자동 테스트 + 390·1280 화면 캡처 (playwright)' },
    { id: 'preview', text: '로컬·tailnet 미리보기만, 공개 배포 없음' },
    { id: 'approval', text: '오너가 명시적으로 OK — 매니페스트 approvals에 기록' },
    { id: 'release', text: '오너 OK 뒤에만 배포, DEPLOYMENT.md 갱신' },
  ];
  return (
    <section className="gs-sec gs-pipe" aria-labelledby="gs-pipe-h">
      <div className="gs-pipe-intro">
        <h2 id="gs-pipe-h">새 게임 만들기</h2>
        <p>지금 있는 게임 하나를 레퍼런스로 골라 템플릿을 복제하고, 아래 7단계를 같은 순서로 밟습니다. 각 단계는 증거 파일이 생기면 카트리지의 퀘스트 트랙에 자동으로 표시됩니다.</p>
        <p className="gs-pipe-cmd"><code>templates/game/scripts/new-game-from-reference.sh --reference &lt;레퍼런스-id&gt; --source ~/games/&lt;레퍼런스&gt; --id &lt;새-id&gt; --dry-run</code></p>
        <p className="gs-pipe-note">이 화면은 읽기 전용입니다. 실행은 터미널에서, 출시는 언제나 오너 OK 뒤에.{studio.pipeline.template ? '' : ' (템플릿 폴더 기록 없음)'}</p>
        {studio.pipeline.doc && <a className="gs-btn" href={studio.pipeline.doc} target="_blank" rel="noopener noreferrer">파이프라인 문서 보기 <ExternalIcon /></a>}
      </div>
      <ol className="gs-pipe-steps">
        {STEPS.map((s, i) => <li key={s.id}><span className="gs-pipe-n">{i + 1}</span><div><b>{STEP_LABEL[s.id]}</b><span className="gs-pipe-role">{ROLE_OF[s.id]}</span><p>{s.text}</p></div></li>)}
      </ol>
      <div className="gs-tree" aria-label="레퍼런스 계보">
        <h3>계보</h3>
        <ul>
          {roots.map((g) => (
            <li key={g.id}><span className={`gs-tree-dot status-${g.status}`} />{g.title}
              {kids(g.id).length > 0 && <ul>{kids(g.id).map((k) => <li key={k.id}><span className={`gs-tree-dot status-${k.status}`} />{k.title}</li>)}</ul>}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
const STEP_LABEL: Record<StudioStage['id'], string> = { concept: '콘셉트', assets: '에셋', build: '빌드', test: '테스트·검증', preview: '미리보기', approval: '오너 승인', release: '출시' };

/* ───────── the view ───────── */

export function GameStudioHome({ studio, now }: { studio: GameStudio; now: number }) {
  const [open, setOpen] = useState<StudioArtifact | null>(null);
  const games = useMemo(() => studio.games, [studio.games]);
  return (
    <div className="gs" data-testid="game-studio">
      <LobbyBar s={studio.summary} />
      {studio.error && <div className="hub-notice" role="status">{studio.error}</div>}
      <Party agents={studio.agents} others={studio.others} now={now} />
      <section className="gs-sec gs-carts" aria-labelledby="gs-carts-h">
        <header className="gs-sh"><h2 id="gs-carts-h">게임</h2><span className="gs-sh-note">카트리지마다 퀘스트 트랙과 다음 행동 하나</span></header>
        <div className="gs-cart-grid">{games.map((g) => <Cartridge key={g.id} g={g} now={now} onOpen={setOpen} />)}</div>
      </section>
      <div className="gs-split">
        <Loot loot={studio.loot} games={games} onOpen={setOpen} />
        <QuestLog feed={studio.feed} now={now} />
      </div>
      <Pipeline studio={studio} />
      {open && <Viewer a={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
