import { useEffect, useState } from 'react';
import { HubOverview } from './HubOverview';
import { HubPage } from './HubPage';
import type { HubModeKey } from './modes';
import type { HubFeed } from './useHubStatus';

/** The hub's main area (the rail lives in the shell): the 개요 or one mode's page on the common template. */
export function HubView({ mode, onChangeMode, feed, pushOn }: { mode: HubModeKey; onChangeMode: (m: HubModeKey) => void; feed: HubFeed; pushOn: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => { setNow(Date.now()); }, [feed.fetchedAt]);
  if (mode === 'msg') return null;
  return (
    <div className="hub-main" data-mode={mode}>
      {mode === 'home'
        ? <HubOverview status={feed.status} error={feed.error} loading={feed.loading} fetchedAt={feed.fetchedAt} now={now} pushOn={pushOn} onOpenMode={onChangeMode} onRefresh={feed.refresh} />
        : <HubPage modeKey={mode} mode={feed.status?.modes.find((m) => m.id === mode)} now={now} error={feed.error} loading={feed.loading} onRefresh={feed.refresh} generatedAt={feed.status?.generated_at ?? null} />}
    </div>
  );
}
