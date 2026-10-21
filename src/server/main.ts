// Repo entry (`node --import tsx src/server/main.ts`, used by scripts/launchd/run.sh): start the server.
import { installCrashHandlers } from './crash';
import { startErrorLine } from './cli/app';
import { startServer } from './server';

installCrashHandlers(process, { log: (line) => console.error(line), exit: (code) => process.exit(code) });

startServer().catch((err: unknown) => {
  // Known failures (accounts.json, port, lock) are one line; anything else keeps its stack.
  const line = startErrorLine(err);
  if (line.startsWith('deck: 시작 실패')) console.error('deck: 시작 실패', err);
  else console.error(line);
  process.exit(1);
});
