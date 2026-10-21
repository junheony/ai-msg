export type ServiceAction = 'install' | 'uninstall' | 'status' | 'restart';

export type CliCommand =
  | { kind: 'start'; port?: number }
  | { kind: 'doctor'; json: boolean }
  | { kind: 'service'; action: ServiceAction; dryRun: boolean; yes: boolean; node?: string; port?: number; drainMaxMin?: number }
  | { kind: 'login-url' }
  | { kind: 'version' }
  | { kind: 'help' }
  | { kind: 'error'; message: string };

const SERVICE_ACTIONS: readonly ServiceAction[] = ['install', 'uninstall', 'status', 'restart'];

/** `--name value` / `--name=value` → [name, value | undefined]; a bare flag → [name, undefined]. */
function splitFlags(args: string[]): { flags: Array<[string, string | undefined]>; positional: string[]; error?: string } {
  const flags: Array<[string, string | undefined]> = [];
  const positional: string[] = [];
  const takesValue = new Set(['--port', '--node', '--drain-max-min']);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('-')) { positional.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > 0) { flags.push([a.slice(0, eq), a.slice(eq + 1)]); continue; }
    if (takesValue.has(a)) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('-')) return { flags, positional, error: `${a} 에 값이 필요합니다` };
      flags.push([a, v]);
      i++;
      continue;
    }
    flags.push([a, undefined]);
  }
  return { flags, positional };
}

function intIn(v: string | undefined, min: number, max: number): number | null {
  if (v === undefined || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return n >= min && n <= max ? n : null;
}

/** No arguments = `start`. */
export function parseCli(argv: string[]): CliCommand {
  const first = argv[0];
  if (first === '--version' || first === '-v' || first === 'version') return argv.length === 1 ? { kind: 'version' } : { kind: 'error', message: `알 수 없는 인자: ${argv.slice(1).join(' ')}` };
  if (first === '--help' || first === '-h' || first === 'help') return { kind: 'help' };
  const cmd = first === undefined || first.startsWith('-') ? 'start' : first;
  const rest = first === undefined || first.startsWith('-') ? argv : argv.slice(1);
  const { flags, positional, error } = splitFlags(rest);
  if (error) return { kind: 'error', message: error };
  const unknown = (allowed: string[]) => flags.find(([f]) => !allowed.includes(f));
  const portOf = (v: string | undefined) => intIn(v, 1, 65535);

  if (cmd === 'start') {
    if (positional.length) return { kind: 'error', message: `알 수 없는 인자: ${positional.join(' ')}` };
    const bad = unknown(['--port']);
    if (bad) return { kind: 'error', message: `start 에 없는 옵션: ${bad[0]}` };
    const p = flags.find(([f]) => f === '--port');
    if (!p) return { kind: 'start' };
    const port = portOf(p[1]);
    return port === null ? { kind: 'error', message: `--port 는 1~65535 사이 정수여야 합니다: ${p[1] ?? ''}` } : { kind: 'start', port };
  }
  if (cmd === 'doctor') {
    if (positional.length) return { kind: 'error', message: `알 수 없는 인자: ${positional.join(' ')}` };
    const bad = unknown(['--json']);
    if (bad) return { kind: 'error', message: `doctor 에 없는 옵션: ${bad[0]}` };
    return { kind: 'doctor', json: flags.some(([f]) => f === '--json') };
  }
  if (cmd === 'login-url') {
    if (positional.length || flags.length) return { kind: 'error', message: 'login-url 은 인자를 받지 않습니다' };
    return { kind: 'login-url' };
  }
  if (cmd === 'service') {
    const action = positional[0] as ServiceAction | undefined;
    if (!action || !SERVICE_ACTIONS.includes(action) || positional.length > 1) return { kind: 'error', message: `service 다음에 ${SERVICE_ACTIONS.join(' | ')} 중 하나를 쓰세요` };
    const bad = unknown(['--dry-run', '--yes', '-y', '--node', '--port', '--drain-max-min']);
    if (bad) return { kind: 'error', message: `service 에 없는 옵션: ${bad[0]}` };
    const out: Extract<CliCommand, { kind: 'service' }> = { kind: 'service', action, dryRun: false, yes: false };
    for (const [f, v] of flags) {
      if (f === '--dry-run') out.dryRun = true;
      else if (f === '--yes' || f === '-y') out.yes = true;
      else if (f === '--node') { if (!v) return { kind: 'error', message: '--node 에 경로가 필요합니다' }; out.node = v; }
      else if (f === '--port') { const p = portOf(v); if (p === null) return { kind: 'error', message: `--port 는 1~65535 사이 정수여야 합니다: ${v ?? ''}` }; out.port = p; }
      else if (f === '--drain-max-min') { const d = intIn(v, 1, 28); if (d === null) return { kind: 'error', message: `--drain-max-min 은 1~28 사이 정수(분)여야 합니다: ${v ?? ''}` }; out.drainMaxMin = d; }
    }
    return out;
  }
  return { kind: 'error', message: `알 수 없는 명령: ${cmd}` };
}
