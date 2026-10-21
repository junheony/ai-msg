#!/usr/bin/env node
// Package entry (`quarterdeck`). node: built-ins only: it must run on an old Node long enough to say so.
const major = Number(process.versions.node.split('.')[0]);
if (major < 24) {
  console.error(`quarterdeck 는 Node 24 이상이 필요합니다 (지금 ${process.versions.node})`);
  process.exitCode = 1;
} else {
  const app = (await import(new URL('./app.js', import.meta.url).href)) as { runCli: (argv: string[]) => Promise<number> };
  const code = await app.runCli(process.argv.slice(2));
  process.exitCode = code;
  // A failed command ends even if something it started is still holding the event loop (unref'd: never delays a clean exit).
  if (code !== 0) setTimeout(() => process.exit(code), 2000).unref();
}
export {};
