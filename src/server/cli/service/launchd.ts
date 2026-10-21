import { MARKER_LINE, stopTimeoutSec, type ServiceRecord } from './record';

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const str = (s: string) => `<string>${xml(s)}</string>`;

/**
 * The LaunchAgent. KeepAlive (S6) restarts it after any exit; AbandonProcessGroup=false (S4, explicit) lets launchd
 * clean the job's process group; ExitTimeOut (S3) is the drain cap + 2 min.
 */
export function launchAgentPlist(r: ServiceRecord, o: { label: string; logFile: string }): string {
  const env = { ...r.env, DECK_SUPERVISOR: 'launchd' };
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<!-- ${xml(MARKER_LINE)} -->`,
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>${str(o.label)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...[r.node, r.bin, 'start'].map((a) => `    ${str(a)}`),
    '  </array>',
    `  <key>WorkingDirectory</key>${str(r.env.HOME ?? '/')}`,
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    '  <key>ThrottleInterval</key><integer>10</integer>',
    '  <key>AbandonProcessGroup</key><false/>',
    `  <key>ExitTimeOut</key><integer>${stopTimeoutSec(r)}</integer>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key>${str(v)}`),
    '  </dict>',
    `  <key>StandardOutPath</key>${str(o.logFile)}`,
    `  <key>StandardErrorPath</key>${str(o.logFile)}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** The `pid = N` line of `launchctl print gui/<uid>/<label>`; null when the job is loaded but not running. */
export function parseLaunchctlPid(out: string): number | null {
  const m = /^\s*pid = (\d+)\s*$/m.exec(out);
  return m ? Number(m[1]) : null;
}
