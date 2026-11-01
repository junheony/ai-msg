# BRIEF7c — Codex quota freshness

## Cause established from code

`CodexUsagePoller` previously read only `token_count.rate_limits` from local rollout tails. A reset performed outside a MSG turn need not append a rollout event, so the old weekly 100% / November 4 reset could remain on screen. `UsageService.pollOnce()` in CLI mode only re-read those observations; opening the usage panel did not query the current provider quota.

`TurnRunner.runCodex()` also discarded a rollout event's timestamp and applied its values at the current time, allowing an old exhausted record to look freshly measured. Successful Codex turns did not clear the in-memory GPT cooldown; Hermes shares that plan but also did not clear it. A retired turn overlay could let an older rollout overwrite a newer dashboard card. These are verified code paths; they explain the reported symptom without asserting access to the owner's historical production process.

## Changes

- `codexLiveUsage.ts` performs the `initialize` → `initialized` → `account/rateLimits/read` stdio protocol using the installed Codex binary and `codexEnv(process.env)`, matching CodexEngine's credential environment and preserving `CODEX_HOME`. It never sends thread, turn, login, or reset-credit consumption requests. The CLI owns authentication. No auth file or raw stderr/response is logged. Request timeout, bounded output, SIGTERM/SIGKILL cleanup, and auth/error fallback are covered.
- Polling now prefers that live reading, falling back to rollout events with their real timestamps. Concurrent UI requests share a poll, and live attempts have a 15-second minimum interval. The existing 60-second background poll remains. Live RPC snapshots replace all quota windows: absent 5h is unknown, not an old 100% or an invented 0%. Only the Codex plan bucket is used; percentages are used percentages, not remaining percentages. Malformed present windows reject the complete reading; an older/equal/undated dashboard cannot refill an absent live window.
- Successful Codex and Hermes turns clear the shared GPT cooldown only if no newer concurrent turn has since recorded a genuine quota failure (a generation guard). Before-turn exhausted observations are invalidated as unknown and fenced against reimport from old rollouts/dashboard cards. Current-turn/newer real exhaustion and known credit-backed subscription exhaustion remain valid. The successful-turn timestamp is atomically persisted in `<configDir>/codex-usage-success.json` (0600) so an offline restart cannot restore invalidated old exhaustion.
- Codex per-turn rollout reads retain event timestamps; unknown timestamps are not promoted to fresh observations. `UsageService` rejects a rollout older than the displayed reading even after a dashboard card has retired the overlay. `engineLimits` treats expired/estimated weekly values as unknown rather than confirmed headroom or exhaustion. Real cooldown/error semantics remain in place.
- Authenticated `GET /api/usage?refresh=1` re-reads Codex live quota and returns the current snapshot. `App.tsx` supplies the refresh callback to the strip/sheet; existing usage WebSocket publications update the rendered snapshot. The UI implementation triggers on popover/sheet open and focus.

## Evidence and validation

The installed CLI protocol schema was generated into a temporary directory and checked against the [official Codex App Server documentation](https://learn.chatgpt.com/docs/app-server). A single read-only live query with the new helper succeeded at **2026-11-01T17:48:20.322Z (2026-11-02 02:48:20 KST)**: **weekly used 7%**, 5h absent. No account identifiers, credentials, raw response, inference request, reset operation, service restart, or production state edit was performed. The observation is point-in-time evidence, not a guarantee of future availability.

Targeted validation:

```
npx vitest run src/server/usage/{codexLiveUsage,CodexUsagePoller,UsageService}.test.ts src/server/turn/{TurnRunner,TurnRunner.hermes}.test.ts src/server/http-usage.test.ts src/server/routing/engineLimits.test.ts
```

Passed: 7 files, 215 tests including restart-fence, complete-overlay, malformed-window, and concurrent-failure regressions. Coverage includes real subprocess RPC handshake/no-turn behavior, auth failure and timeout, live reset over exhausted rollout, missing 5h, concurrent refresh deduplication, source-failure fallback, stale dashboard replay, fresh true exhaustion, known credits, successful Codex/Hermes cooldown clearing, and authenticated HTTP refresh. A final parameterized older/equal/undated dashboard precedence regression was also run separately. Root owns final whole-suite/typecheck/build verification.

## Boundaries

Live quota is best-effort: unsupported/unauthenticated/offline CLIs retain timestamped fallback observations rather than fabricating available quota. A successful paid-credit call does not prove that included subscription quota reset, so known-credit 100% remains 100%. A successful call similarly does not erase a real 100% measurement obtained during that call. Concurrent live reads are timestamped at request start so late responses cannot overwrite newer observations. A provider limit failure after success still sets a genuine cooldown.

## Final validation timing note

The initial whole-suite process started at 02:50:54 KST while review patches were still being applied. It later picked up the new regression test files but reused earlier transformed implementation modules: the concurrent cooldown regression and four complete-overlay regressions failed in that obsolete process. Fresh-process verification of the final code passed: the focused concurrency case (1/1), the entire `TurnRunner.test.ts` file (117/117), and the final `UsageService.test.ts` file (67/67). Independent review also ran the six new concurrency/overlay/parser cases successfully. Root stopped the obsolete mixed-revision run and owns a fresh full-suite run after the source freeze. No workaround or assertion weakening was introduced.
