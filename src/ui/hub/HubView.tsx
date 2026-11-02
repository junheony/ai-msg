import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { HubOverview } from './HubOverview';
import { HubPage } from './HubPage';
import { ResearchPage } from './research/ResearchPanel';
import { LabEmbed } from './lab/LabEmbed';
import type { HubModeKey } from './modes';
import type { HubFeed } from './useHubStatus';
import { liveCtlApi, type CtlApi } from './controls/api';
import { Composer } from './controls/Composer';
import { CtlProvider, type CtlContext } from './controls/context';
import { useControls } from './controls/useControls';
import './controls/controls.css';

/**
 * The hub's main area (the rail lives in the shell): the 개요 or one mode's page on the common template. Memoized: App
 * re-renders on every chat delta, and the hub only needs to when its feed (a stable object between changes) or mode does.
 * The controls (승인함, 다음 작업, 실행 관리, 터미널 바로가기) ride along in a context; `controls={null}` turns them off.
 */
export const HubView = memo(function HubView({ mode, onChangeMode, feed, pushOn, controls = liveCtlApi, onOpenTerminal }: { mode: HubModeKey; onChangeMode: (m: HubModeKey) => void; feed: HubFeed; pushOn: boolean; controls?: CtlApi | null; onOpenTerminal?: (cwd: string) => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => { setNow(Date.now()); }, [feed.fetchedAt]);
  const ctlFeed = useControls(controls ?? liveCtlApi, !!controls && mode !== 'msg');
  const [composeFor, setComposeFor] = useState<string | null>(null);
  const compose = useCallback((m: string) => setComposeFor(m), []);
  const ctl = useMemo<CtlContext | null>(() => (controls ? { feed: ctlFeed, compose, ...(onOpenTerminal ? { openTerminal: onOpenTerminal } : {}) } : null), [controls, ctlFeed, compose, onOpenTerminal]);
  if (mode === 'msg') return null;
  if (mode === 'research') return <div className="hub-main" data-mode={mode}><ResearchPage /></div>;
  if (mode === 'lab') return <div className="hub-main" data-mode={mode}><LabEmbed /></div>;
  return (
    <CtlProvider value={ctl}>
      <div className="hub-main" data-mode={mode}>
        {mode === 'home'
          ? <HubOverview status={feed.status} error={feed.error} loading={feed.loading} fetchedAt={feed.fetchedAt} now={now} pushOn={pushOn} onOpenMode={onChangeMode} onRefresh={feed.refresh} />
          : <HubPage key={mode} modeKey={mode} mode={feed.status?.modes.find((m) => m.id === mode)} now={now} error={feed.error} loading={feed.loading} onRefresh={feed.refresh} generatedAt={feed.status?.generated_at ?? null} />}
        {ctl && composeFor && <Composer feed={ctlFeed} mode={composeFor} onClose={() => setComposeFor(null)} onShowRuns={() => { if (mode !== 'home') onChangeMode('home'); setTimeout(() => document.getElementById('hub-runs')?.scrollIntoView({ block: 'start' }), 80); }} />}
      </div>
    </CtlProvider>
  );
});
