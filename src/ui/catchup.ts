import type { ClientMessage, ServerMessage, StreamPos } from '../shared/protocol';
import type { ProjectEntry } from '../shared/session-types';

/** A catch-up the server answered with an error is asked again after this long, doubling up to the maximum; back to the minimum on an answer, a reconnect and coming back into view. */
export const CATCHUP_RETRY_MIN_MS = 1000;
export const CATCHUP_RETRY_MAX_MS = 30_000;
/** A request with no answer at all for this long: the socket takes messages but returns none — it is given up for a new one. */
export const CATCHUP_STALL_MS = 30_000;
/** A request made when the page comes back into view: a phone's socket that died in the background answers nothing — give it this long, not the usual 30 s. */
export const CATCHUP_VISIBLE_STALL_MS = 5_000;
/** A shown session whose transcript the session lists saw grow this many lists in a row while this device heard nothing of it is opened afresh. */
export const CATCHUP_SILENT_LISTS = 2;

/**
 * Keeps each shown session's stream in order on this device ('catchup' servers number their turn events: `pos`).
 * `accept` sees every server message before it is applied: an event that does not follow the last applied one is held
 * back (false) and what is missing is asked for with `open_session.after` — the server answers with the events after
 * that position, or with the whole history when it cannot. An event already applied is dropped. Messages without a
 * position (an older server's, cards, lists) pass.
 *
 * One request per session and socket: while it is unanswered nothing is sent again, and after CATCHUP_STALL_MS the
 * socket is reported as `stalled`. An error answer is retried with a growing delay (and shown once); 'not_found' is final.
 *
 * The session lists ('index') are the check from outside: a shown session whose transcript grew over
 * CATCHUP_SILENT_LISTS lists in a row while nothing of it reached this device is opened afresh (the whole history).
 */
export function createCatchup(opts: {
  /** false = not connected, nothing sent. */
  send(m: ClientMessage): boolean;
  /** The connected server answers `open_session.after` (features 'catchup'). */
  enabled(): boolean;
  /** The sessions the panes show. Others are not kept in order and nothing is asked for them. */
  shown(): string[];
  /** A request got no answer: reconnect (the new socket's hello asks again). */
  stalled(): void;
}) {
  /** The last applied position per session. */
  const applied = new Map<string, StreamPos>();
  /** Requests on the current socket without an answer yet (their stall clock). */
  const sent = new Map<string, ReturnType<typeof setTimeout>>();
  /** Requests that failed, waiting to be asked again; the delay the next failure waits. */
  const retry = new Map<string, ReturnType<typeof setTimeout>>();
  const delays = new Map<string, number>();
  /** Sessions whose failure the user has been shown (until an answer comes). */
  const told = new Set<string>();
  /**
   * The self-heal: each shown session's newest transcript time in the last session list, whether anything of it was
   * heard since, and how many lists in a row saw it grow unheard. A tab whose stream went quiet while the transcript
   * keeps growing (the sidebar shows newer text than the pane) has lost the session's events: it reopens it.
   */
  const listed = new Map<string, number>();
  const heard = new Set<string>();
  const silent = new Map<string, number>();

  const stop = (timers: Map<string, ReturnType<typeof setTimeout>>, sid: string) => {
    const t = timers.get(sid);
    if (t !== undefined) clearTimeout(t);
    timers.delete(sid);
  };
  const settle = (sid: string) => { stop(sent, sid); stop(retry, sid); delays.delete(sid); told.delete(sid); };
  const forget = (sid: string) => { applied.delete(sid); settle(sid); };
  const cancel = () => { for (const sid of [...sent.keys(), ...retry.keys()]) { stop(sent, sid); stop(retry, sid); } };

  function indexed(projects: ProjectEntry[], reopen: boolean): void {
    const newest = new Map<string, number>();
    for (const p of projects) for (const e of p.sessions) newest.set(e.sessionId, Math.max(newest.get(e.sessionId) ?? 0, e.lastModified));
    const shown = new Set(opts.shown());
    for (const sid of [...listed.keys()]) if (!shown.has(sid)) { listed.delete(sid); silent.delete(sid); }
    for (const sid of shown) {
      const now = newest.get(sid);
      if (now === undefined) continue;
      const was = listed.get(sid);
      listed.set(sid, now);
      if (!reopen || was === undefined || now <= was || heard.has(sid) || sent.has(sid) || retry.has(sid)) { silent.delete(sid); continue; }
      const n = (silent.get(sid) ?? 0) + 1;
      if (n < CATCHUP_SILENT_LISTS || !opts.enabled()) { silent.set(sid, n); continue; }
      silent.delete(sid);
      forget(sid);
      opts.send({ type: 'open_session', sessionId: sid });
    }
    heard.clear();
  }

  /** True when a request for the session is (now, or already) out on this socket. */
  function ask(sid: string, stallMs = CATCHUP_STALL_MS): boolean {
    if (sent.has(sid)) return true;
    stop(retry, sid);
    const at = applied.get(sid);
    if (!at || !opts.enabled()) return false;
    if (!opts.shown().includes(sid)) { forget(sid); return false; }
    // Not connected: the reconnect's hello asks.
    if (!opts.send({ type: 'open_session', sessionId: sid, after: { epoch: at.epoch, seq: at.seq } })) return false;
    sent.set(sid, setTimeout(() => { cancel(); opts.stalled(); }, stallMs));
    return true;
  }

  return {
    /** False: do not apply this message (a repeat, one ahead of a gap that is being filled, or a failure already shown). */
    accept(msg: ServerMessage): boolean {
      if (msg.type === 'index' || msg.type === 'hello') { indexed(msg.projects, msg.type === 'index'); return true; }
      if (msg.type === 'history' || msg.type === 'catchup') {
        heard.add(msg.sessionId);
        if (msg.type === 'history') { if (msg.pos) applied.set(msg.sessionId, msg.pos); else applied.delete(msg.sessionId); }
        settle(msg.sessionId);
        return true;
      }
      const pos = 'pos' in msg ? msg.pos : undefined;
      if (!pos) {
        // The answer to a request of ours: the server could not open the session.
        const sid = msg.type === 'error' && msg.turnId === null && msg.clientRef === undefined ? msg.sessionId : undefined;
        if (msg.type !== 'error' || sid === undefined || !sent.has(sid)) return true;
        if (msg.code === 'not_found') { forget(sid); return true; }
        stop(sent, sid);
        const wait = delays.get(sid) ?? CATCHUP_RETRY_MIN_MS;
        delays.set(sid, Math.min(wait * 2, CATCHUP_RETRY_MAX_MS));
        retry.set(sid, setTimeout(() => { retry.delete(sid); ask(sid); }, wait));
        if (told.has(sid)) return false;
        told.add(sid);
        return true;
      }
      if (!opts.shown().includes(pos.sid)) { forget(pos.sid); return true; }
      heard.add(pos.sid);
      const at = applied.get(pos.sid);
      if (!at || pos.seq === at.seq + 1) { applied.set(pos.sid, pos); return true; }
      if (pos.epoch === at.epoch && pos.seq <= at.seq) return false;
      if (!retry.has(pos.sid)) ask(pos.sid);
      return false;
    },
    /**
     * A (re)connected socket's hello: every shown session is opened on it again, once — from this device's position
     * where one is known and the server can, plainly (the whole history) otherwise.
     */
    hello(): void {
      cancel();
      delays.clear();
      told.clear();
      if (!opts.enabled()) applied.clear();
      for (const sid of new Set(opts.shown())) if (!ask(sid)) opts.send({ type: 'open_session', sessionId: sid });
    },
    /** The page is back in view (a phone's socket may have stalled without closing): ask for what the shown sessions missed, now. */
    visible(): void {
      for (const sid of [...retry.keys()]) stop(retry, sid);
      delays.clear();
      if (!opts.enabled()) { applied.clear(); return; }
      for (const sid of new Set(opts.shown())) {
        if (sent.has(sid)) {
          // Already out, possibly for a long while on a socket that died unnoticed: it gets the short clock from now.
          stop(sent, sid);
          sent.set(sid, setTimeout(() => { cancel(); opts.stalled(); }, CATCHUP_VISIBLE_STALL_MS));
        } else ask(sid, CATCHUP_VISIBLE_STALL_MS);
      }
    },
    /** The session is opened afresh (its history is on the way) or closed. */
    forget,
    /** The socket closed, or the app is going away: nothing is waited for. */
    cancel,
  };
}

export type Catchup = ReturnType<typeof createCatchup>;
