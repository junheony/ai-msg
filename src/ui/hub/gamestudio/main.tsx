import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../styles.css';
import '../hub-sections.css';
import { HubPage } from '../HubPage';
import { useHubStatus } from '../useHubStatus';

/**
 * The 게임 스튜디오 page alone (scripts/studio-preview.ts serves it at /): the same HubPage the shell shows for the 게임
 * mode, inside the same hub frame, polling `/api/hub/status` — which the preview server answers with the game mode only.
 */
function StudioPreview() {
  const feed = useHubStatus(true, null, false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => { setNow(Date.now()); }, [feed.fetchedAt]);
  return (
    <div className="hub-overlay gs-standalone">
      <div className="hub-main" data-mode="game">
        <HubPage modeKey="game" mode={feed.status?.modes.find((m) => m.id === 'game')} now={now} error={feed.error} loading={feed.loading} onRefresh={feed.refresh} generatedAt={feed.status?.generated_at ?? null} />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><StudioPreview /></StrictMode>);
