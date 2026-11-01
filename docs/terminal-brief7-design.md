# Terminal Hermes + polish design

The terminal is a working conversation, with engine identity visible at the points where the user chooses or resumes work. Keep BRIEF6's shared reading lane and existing Korean system/Pretendard type stack. Base tokens: canvas #13131b, rail #101018, composer #22222e, text #efeff6, quiet #9898aa, focus #a78bfa. Engine marks carry differentiated coral (Claude), teal (Codex), gold (Hermes), blue (Gemini), and lilac (Grok); do not recolor whole paragraphs.

Layout: left-aligned conversation and composer, compact engine mark beside session/model controls, one understated empty-state invitation, and code headers that clearly expose copy. All align to the existing reading lane.

```
Session rail | title and current engine
             | user request
             | › work steps
             | answer / code header [copy]
             | model & permissions
             | next message              send
```

References: The Seeker AI split panel https://ref.theseeker.io/r/5649 for quiet hierarchy; Linear precision at https://styles.refero.design/style/90ce5883-bb24-4466-93f7-801cd617b0d1; https://glass.samasante.com for restrained surface separation; https://www.scrolltide.co for motion that responds to actions. Review: preserve the hub's type and tokens; avoid generic gradient cards, ambient movement and additional decorative headers. A small geometric Hermes wing is an engine identifier, not a new logo system. Opening a work group and explicitly returning to the latest message are the motion moments. Streaming has one subdued caret; reduced-motion users get a steady mark and instant movement.

BRIEF7b header and approval/status fixes intentionally follow BRIEF7 acceptance as a separate change.

Implementation decisions:
- Hermes remains an explicit engine. Its model id is also a valid Codex Astra model, so engine identity is not inferred from that slug. Session settings show `gpt-6-astra`, hide unsupported ACP effort/sandbox choices, retain approval modes, and preserve Hermes in saved panes. The built-in `hermes` seat is never classified as an unknown Claude account.
- Each engine has an inline accessible identity and a small accent on its selected session, composer focus and streaming caret. Existing highlighted markdown stays lazy-loaded; code copy gains a visible icon and confirmation. Empty state keeps the existing greeting but follows it with a useful folder/engine instruction.
- Work disclosures animate only on expansion. Returning to latest uses smooth scrolling, preserving instant streaming-follow and user-detach behavior; a bounded fallback supports browsers without scrollend, and upward intent cancels animation. Reduced motion disables animation and uses an immediate jump.

Validation: `npx vitest run src/ui/components/EngineMark.test.tsx src/ui/components/SessionChip.test.tsx src/ui/components/TerminalPresentation.test.tsx src/ui/stickToBottom.test.tsx src/ui/state.test.ts src/ui/persist.test.ts src/ui/layouts.test.ts src/ui/accounts.test.ts --maxWorkers=2` passed 239 tests in 8 files. Extra Hermes-seat regression test in Pane verifies resumed send stays writable and omits unsupported effort. Parent owns final integrated typecheck, build, screenshots and commit. An early typecheck captured in-flight shared-type changes; its stale errors are not a final validation result.
Extra validation: `npx vitest run src/ui/components/Pane.test.tsx src/ui/accounts.test.ts --maxWorkers=2` passed 45 tests in 2 files, including the Hermes resume/account regression. `git diff --check` passed. Inspected desktop fixture screenshot `shots-terminal-v2/hermes-preview-desktop-turn.png`: reading lane, code contrast and engine identity are clear; the unknown-seat warning shown in that earlier build is covered by the subsequent fix/test. Header double identity, alarm approval and SUCCESS-with-errors remain intentionally reserved for BRIEF7b.

Integration review: hide unsupported Hermes working-folder changes in both sidebar and session-title menus. Keep duplication, which the server explicitly implements for Hermes. Confirmed desktop opening, fork, handoff, commander, fast mode and Claude account controls remain excluded; delete stays visibly disabled. Added menu regressions covering these supported/unsupported boundaries.
Targeted integration validation: `npx vitest run src/ui/components/SessionOps.test.tsx src/ui/components/Pane.test.tsx --maxWorkers=2` passed 35 tests across 2 files; `git diff --check` passed.
Final-suite compatibility review: engine color values now live with the stylesheet's leading theme tokens; downstream component rules retain the existing no-literal-colors invariant. Updated the obsolete search-hit expectation that Gemini lacked an icon; regression now asserts Claude, Codex, Gemini, Hermes and Grok identities.
Targeted suite follow-up: `npx vitest run src/ui/App.commander.test.tsx src/ui/components/Sidebar.test.tsx --maxWorkers=2` passed 70 tests in 2 files; `git diff --check` passed.
Canonical-token follow-up: merged engine colors into the existing first `:root`, explicit-light and system-light blocks, avoiding a separate root block that would break existing font-scale/status-bar token readers. All existing theme and font assertions remain unchanged.
Validation: `npx vitest run src/ui/fontScale.test.ts src/ui/themeColor.test.ts src/ui/App.commander.test.tsx src/ui/components/Sidebar.test.tsx --maxWorkers=2` passed 79 tests in 4 files; `git diff --check` passed.

# BRIEF7b header and status refinement

Plan after reviewing the owner's crop: one 22px identity, a title with aligned caret, then a small engine/model chip; custom icons replace the engine symbol. Remove the repeated folder line; retain a full-path tooltip only when the normalized folder differs from the title and keep folder actions in the menu. Keep automatic approval visible in a compact amber policy chip with its actual engine-specific explanation. Use existing theme/type tokens, no new palette or motion.

Status belongs to a completed turn, across its commentary and model/group boundaries. A tool error downgrades its final report to PARTIAL while retaining BLOCKED and leaving clean reports unchanged. User messages separate historical null-ID turns; explicit ID transitions also separate runs. Streaming runs do not receive an inferred final status. Original transcript objects/text stay intact.

Implementation/validation: menu and double-click rename remain intact; chosen session avatars replace engine marks, and their picker remains available. Mobile shows the short engine chip with full model in its tooltip and uses the existing bottom mode navigation to free session-title width. Approval text stays visible at phone width; composer permission text uses the same amber tone.

Focused BRIEF7b suite passed 101 tests in 5 files (`terminalPresentation`, `TerminalPresentation`, `SessionChipHead`, `Chat`, `Pane`). Follow-up status tests passed 28 tests in 2 files after accounting for steering user bubbles within the same explicit turn ID. Busy/active-turn information prevents inferred final status during tool-to-answer gaps; prior completed turns retain their status. `git diff --check` passed.

390px visual review found that the collapsed quota summary still squeezed the session title. The phone terminal now puts quota limits beside history in the existing drawer account menu; the command-palette action remains. Engine name, automatic-approval text, the session switcher and global activity/search control all stay visible. Tightened chip gaps without shrinking the shared font scale. The phone drawer is the sheet return-focus target, so closing usage never focuses the hidden quota control.
Targeted mobile-menu validation: `npx vitest run src/ui/App.test.tsx --maxWorkers=2 -t "avatar menu ends|아바타 메뉴|account menu opens quota"` passed 3 tests (80 skipped), including phone drawer → limits → close/focus restoration. Parent owns final 390px width check and screenshots.
