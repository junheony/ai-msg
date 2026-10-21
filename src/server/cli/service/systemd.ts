import { MARKER_LINE, stopTimeoutSec, systemdQuote, type ServiceRecord } from './record';

export { systemdQuote };

/**
 * The user unit. KillMode=mixed: the first SIGTERM goes to the server only (it drains, S2) and whatever is left in the
 * cgroup once it exits is SIGKILLed (S4). EnvironmentFile without `-`: a missing env file fails the start visibly.
 */
export function systemdUnit(r: ServiceRecord, envFile: string): string {
  return [
    `# ${MARKER_LINE}`,
    '[Unit]',
    'Description=Quarterdeck local server',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${[r.node, r.bin, 'start'].map((a) => systemdQuote(a)).join(' ')}`,
    `WorkingDirectory=${systemdQuote(r.env.HOME ?? '~')}`,
    `EnvironmentFile=${systemdQuote(envFile)}`,
    'Environment=DECK_SUPERVISOR=systemd',
    'Restart=always',
    'RestartSec=5',
    'KillMode=mixed',
    `TimeoutStopSec=${stopTimeoutSec(r)}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}
