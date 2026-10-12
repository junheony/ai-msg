/**
 * Last-resort process handlers (2026-10-11 outage: one unhandled stream 'error' took the server down for 47 minutes
 * and nothing in deck's own log said why).
 *  - unhandledRejection: a stray promise is not worth a disconnect for every phone — log one line, keep serving.
 *  - uncaughtException: state may be anything; log one line in deck's format and exit 1 so the relaunch loop restarts.
 */
export type CrashHost = { on(event: 'unhandledRejection' | 'uncaughtException', listener: (reason: unknown) => void): unknown };

export function installCrashHandlers(host: CrashHost, o: { log: (line: string) => void; exit: (code: number) => void }): void {
  host.on('unhandledRejection', (reason) => { o.log(`deck: 처리되지 않은 rejection — 서버는 계속 동작합니다: ${oneLine(reason)}`); });
  host.on('uncaughtException', (err) => { o.log(`deck: 치명 오류 — 종료합니다 (relaunch 루프가 다시 띄움): ${oneLine(err)}`); o.exit(1); });
}

/** Message plus the first stack frames, on one line, so `grep 'deck: 치명'` shows the cause. */
export function oneLine(err: unknown): string {
  let text: string;
  if (err instanceof Error) text = err.stack ?? `${err.name}: ${err.message}`;
  else if (typeof err === 'string') text = err;
  else { try { text = JSON.stringify(err) ?? String(err); } catch { text = String(err); } }
  return text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 4).join(' | ');
}
