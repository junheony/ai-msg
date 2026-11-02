# BRIEF7b independent review

Reviewed the header and status changes against the actual pane/reducer lifecycle. This was a source review; test execution and desktop/mobile screenshot validation belong to the implementation and root verification runs.

## Status correctness

- `terminalPresentation.ts` aggregates tool errors across the finished turn, including separate commentary groups and model changes. Final answer labels and earlier explicit `SUCCESS` labels become `PARTIAL`; source message text is unchanged.
- Historical messages with null turn IDs reset at user boundaries. Explicit turn IDs reset only when the ID changes, so an in-turn steering message does not discard an earlier tool error.
- `Chat.tsx` passes both `busy` and `activeTurnId`. `Pane.tsx` defines busy from a running turn or an awaiting start, which avoids treating a temporary non-streaming segment as a completed turn. A different, already completed turn remains eligible for its partial label.
- `BLOCKED` remains authoritative in both the presenter and answer renderer. Clean successful turns are unaffected.
- The first review found unconditional user-boundary resets incorrectly split a steered turn: `state.ts` inserts steering bubbles between assistant records with the same explicit ID. The implementation was corrected, and the regression cases now cover an error before steering, active versus completed rendering, and a later independent turn.

## Header behavior

- One identity is rendered: the engine mark by default, or the chosen custom avatar. The avatar picker remains reachable without opening the session menu.
- The title stays in the same row as the engine/model chip and caret. Normalized equivalent folder slugs are not repeated in the tooltip; distinct paths remain available there, and the folder action remains in the menu.
- The auto-approval mode remains visibly labeled `자동 승인`, with its explanatory title and accessible name retained. Amber styling replaces the alarm presentation, including the mobile text override.
- Existing rename, drag, focus, desktop menu, and phone sheet handlers remain intact. Responsive CSS hides the model text at narrow widths while retaining engine identity.

## Verification boundary

Reviewed the new presentation and header regression cases without running tests or changing implementation files. No unresolved substantive source finding remained after the steering fix. Visual spacing and overflow must be judged from the final 1440/390 screenshots, and the root run owns final test/typecheck/build results.
