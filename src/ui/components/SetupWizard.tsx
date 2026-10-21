import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { ClaudeProfileProbe, EngineProbe, LoginState, SetupStatus } from '../../shared/setup-types';
import type { SessionActivity } from '../../shared/protocol';
import { addProfile, getSetup, markSetupDone, refreshSetup, restartServer } from '../setupApi';
import { ENGINE_NAME, LOGIN_LABEL, SETUP_TEXTS as T } from '../setupTexts';
import { RESTART_WAIT_WARNING, restartConfirmText } from './ActivitySheet';
import { CopyButton } from './CopyButton';
import { Sheet, SheetHead } from './Dialogs';

type Tone = 'ok' | 'warn' | 'muted';
const LOGIN_TONE: Record<LoginState, Tone> = { yes: 'ok', no: 'warn', unknown: 'muted' };
const hhmm = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** A state word after a coloured dot (the text stays in the muted colour; the dot carries the tone). */
function State({ tone, children }: { tone: Tone; children: string }) {
  return <span className={`setup-state is-${tone}`}><span className="setup-dot" aria-hidden="true" />{children}</span>;
}

/** A command to run in a terminal, with its copy button. */
function Command({ cmd }: { cmd: string }) {
  return (
    <div className="setup-cmd">
      <code>{cmd}</code>
      <CopyButton text={cmd} label={T.copy(cmd)} caption="복사" className="btn ghost setup-copy" />
    </div>
  );
}

function EngineRow({ e }: { e: EngineProbe }) {
  const installed = e.bin !== null;
  return (
    <li className="setup-row">
      <div className="setup-row-main">
        <span className="setup-name">{ENGINE_NAME[e.engine]}</span>
        {installed && <span className="setup-meta">{e.version ?? T.noVersion}</span>}
        {installed ? <State tone={LOGIN_TONE[e.login]}>{LOGIN_LABEL[e.login]}</State> : <State tone="warn">{T.notInstalled}</State>}
      </div>
      {e.note && <p className="setup-note">{e.note}</p>}
      {installed && e.login === 'no' && <Command cmd={e.loginCommand} />}
    </li>
  );
}

function ProfileRow({ p, restartNeeded }: { p: ClaudeProfileProbe; restartNeeded: boolean }) {
  return (
    <li className="setup-row">
      <div className="setup-row-main">
        <span className="setup-name">{p.label}</span>
        {p.home && <span className="setup-badge">{T.profileHome}</span>}
        <span className="setup-meta setup-dir">{p.dir}</span>
        {p.active ? <State tone={LOGIN_TONE[p.login]}>{LOGIN_LABEL[p.login]}</State> : <State tone="muted">{restartNeeded ? T.profileNext : T.profileOff}</State>}
      </div>
      {p.login === 'no' && <Command cmd={p.loginCommand} />}
    </li>
  );
}

/**
 * 설치 점검 — the first-run wizard, also opened from 설정 › 계정. One sheet, three numbered parts: ① the four engine CLIs
 * (installed · version · login, the login command to copy when logged out, 다시 확인 = fresh probes) ② Claude accounts
 * and the add form (applied at the next server start: 지금 재시작 under a supervisor, else run quarterdeck again)
 * (confirmed like the activity sheet's: what the drain waits for, from `activity`)
 * ③ the addresses to open from another device. 완료 records the wizard done (it stops opening by itself), ✕ only closes.
 * While open the status is re-read every `pollMs` (a login done in a terminal shows up by itself).
 */
export function SetupWizard({ load = getSetup, onAddProfile = addProfile, onDone, onClose, onRestart, activity = [], pollMs = 5000 }: {
  load?: () => Promise<SetupStatus>;
  activity?: SessionActivity[];
  onAddProfile?: typeof addProfile;
  onDone: () => void;
  onClose: () => void;
  onRestart?: () => void;
  pollMs?: number;
}) {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  const [restart, setRestart] = useState<'idle' | 'sent' | string>('idle');
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [sendingRestart, setSendingRestart] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [doneError, setDoneError] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;
  const alive = useRef(true);
  const uid = useId();

  const apply = (s: SetupStatus) => { if (alive.current) { setStatus(s); setLoadFailed(false); } };
  const fail = () => { if (alive.current) setLoadFailed(true); };

  useEffect(() => {
    alive.current = true;
    const run = () => { loadRef.current().then(apply, fail); };
    run();
    const t = setInterval(run, pollMs);
    return () => { alive.current = false; clearInterval(t); };
  }, [pollMs]);

  const recheck = async () => {
    setChecking(true);
    try { apply(await refreshSetup()); } catch { fail(); } finally { if (alive.current) setChecking(false); }
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const name = label.trim();
    setAdding(true);
    setAddError(null);
    const r = await onAddProfile(id.trim(), name ? name : undefined);
    if (!alive.current) return;
    setAdding(false);
    if (!r.ok) { setAddError(r.error); return; }
    setAdded(true);
    setId('');
    setLabel('');
    loadRef.current().then(apply, fail);
  };

  const restartNow = async () => {
    if (onRestart) { onRestart(); setRestart('sent'); return; }
    setSendingRestart(true);
    const r = await restartServer();
    if (!alive.current) return;
    setSendingRestart(false);
    setRestart(r.ok ? 'sent' : r.error);
  };

  const finish = async () => {
    setFinishing(true);
    setDoneError(false);
    try {
      await markSetupDone();
      onDone();
    } catch {
      if (alive.current) { setDoneError(true); setFinishing(false); }
    }
  };

  const pendingRestart = added || !!status?.restartNeeded;

  return (
    <Sheet className="setup-wizard" label={T.title} onClose={onClose}>
      <SheetHead title={T.title} onClose={onClose} />
      <p className="setup-intro">{T.intro}</p>
      {loadFailed && (
        <div className="setup-restart" role="alert">
          <p className="setup-error">{T.loadFailed}</p>
          {!status && <button type="button" className="btn ghost" onClick={() => void recheck()} disabled={checking}>{checking ? T.checking : T.recheck}</button>}
        </div>
      )}
      {!status ? (!loadFailed && <p className="setup-intro">{T.loading}</p>) : (
        <>
          <section className="setup-step" aria-labelledby={`${uid}-engines`}>
            <div className="setup-step-head">
              <h3 id={`${uid}-engines`}><span className="setup-num" aria-hidden="true">1</span>{T.enginesHead}</h3>
              <span className="setup-meta">{T.checkedAt(hhmm(status.checkedAt))}</span>
              <button type="button" className="btn ghost setup-recheck" onClick={() => void recheck()} disabled={checking}>{checking ? T.checking : T.recheck}</button>
            </div>
            <ul className="setup-list">{status.engines.map((e) => <EngineRow key={e.engine} e={e} />)}</ul>
            {status.engines.some((e) => e.bin !== null && e.login === 'no') && <p className="setup-note">{T.loginHow}</p>}
          </section>

          <section className="setup-step" aria-labelledby={`${uid}-profiles`}>
            <div className="setup-step-head"><h3 id={`${uid}-profiles`}><span className="setup-num" aria-hidden="true">2</span>{T.profilesHead}</h3></div>
            <ul className="setup-list">{status.claudeProfiles.map((p) => <ProfileRow key={p.id} p={p} restartNeeded={status.restartNeeded} />)}</ul>
            {!status.accountsFile && <p className="setup-notice">{T.fixNotice}</p>}
            <form className="setup-add" onSubmit={(ev) => void submit(ev)}>
              <label className="setup-field setup-field-id">
                <span>{T.addId}</span>
                <input value={id} onChange={(ev) => setId(ev.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={16} placeholder="d" aria-describedby={`${uid}-idhint`} />
              </label>
              <label className="setup-field">
                <span>{T.addLabel}</span>
                <input value={label} onChange={(ev) => setLabel(ev.target.value)} maxLength={40} />
              </label>
              <button type="submit" className="btn primary setup-add-btn" disabled={adding || !id.trim()}>{adding ? T.adding : T.add}</button>
            </form>
            <p className="setup-note" id={`${uid}-idhint`}>{T.addIdHint}</p>
            {addError && <p className="setup-error" role="alert">{addError}</p>}
            {pendingRestart && (
              <div className="setup-restart" role="status">
                <p>{T.restartNotice}</p>
                {status.supervised
                  ? restart === 'sent' ? <p className="setup-note">{T.restarting}</p> : (
                    <>
                      {confirmRestart && <p className="setup-note">{restartConfirmText(activity)}</p>}
                      {confirmRestart && <p className="setup-note">{RESTART_WAIT_WARNING}</p>}
                      {!confirmRestart
                        ? <button type="button" className="btn ghost" onClick={() => { setRestart('idle'); setConfirmRestart(true); }}>{T.restartNow}</button>
                        : (
                          <div className="setup-actions">
                            <button type="button" className="btn ghost" onClick={() => setConfirmRestart(false)}>{T.restartCancel}</button>
                            <button type="button" className="btn primary" disabled={sendingRestart} onClick={() => void restartNow()}>{T.restartConfirm}</button>
                          </div>
                        )}
                      {restart !== 'idle' && <p className="setup-error">{restart}</p>}
                    </>
                  )
                  : <p className="setup-note">{T.restartManual}</p>}
              </div>
            )}
          </section>

          <section className="setup-step" aria-labelledby={`${uid}-addresses`}>
            <div className="setup-step-head"><h3 id={`${uid}-addresses`}><span className="setup-num" aria-hidden="true">3</span>{T.addressesHead}</h3></div>
            <p className="setup-note">{T.addressesNote}</p>
            {status.addresses.length ? (
              <ul className="setup-addrs">{status.addresses.map((a) => <li key={a}><Command cmd={a} /></li>)}</ul>
            ) : <p className="setup-note">{T.noAddresses}</p>}
            <p className="setup-note">{T.pairingLater}</p>
          </section>
        </>
      )}
      <footer className="setup-foot">
        {doneError && <p className="setup-error" role="alert">{T.doneFailed}</p>}
        <button type="button" className="btn primary setup-done" onClick={() => void finish()} disabled={finishing || !status}>{T.done}</button>
      </footer>
    </Sheet>
  );
}
