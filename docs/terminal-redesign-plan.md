# Terminal workbench — BRIEF6

The terminal is a Korean reading and decision surface. The visual emphasis belongs to the answer and the next message; process details sit in a quiet expandable rail.

- Palette: canvas `#13131b`, sidebar `#101018`, composer `#22222e`, text `#efeff6`, violet `#a78bfa`, amber `#d6a24a`. Use existing semantic success/error tokens and light-theme equivalents.
- Type: existing system/Pretendard Korean stack, existing larger body scale, 1.75 answer line height. Monospace remains for code only.
- Layout: a shared, left-aligned 960px reading/composer lane; restrained right-aligned user bubble; compact session rail with plain previews and semantic status dots. Narrow panes use their available width.

```
Session rail | Session title                         Usage ▾
             |                   User request
             | › Work steps · tools / thinking
             | Answer, readable paragraphs
             |   [model/options]       context hint
             |   Message field
             |   +   keyboard hint          mic send
```

Review against brief: avoid identical cards, added gradients, tiny body text, decorative labels, and a second accent palette. Widen the reading lane rather than stretching paragraphs across the entire screen. Keep narrative comments visible as semantic boundaries; consolidate consecutive tool/thinking records without altering source objects. This preserves search, model provenance, permissions, and turn actions. Parse leading uppercase report markers, including the owner's bare-marker Korean convention; this convention can also tag ordinary prose beginning with the same pattern. Quota remains one disclosure with all seat details.

Validation: behavioral tests cover lossless grouping and boundaries, live updates, status parsing, preserved tool inspection and composer controls; existing focused component tests and typecheck. Parent handles browser screenshots, full suite, build, report, and commit.

Final review decisions: compare grouped source references in memoization, retain aggregated role controls, and inspect every enclosing closed disclosure during Find. Visual review reduced empty footer gutters and composer height, then reserved more mobile header width for the session name. Final screenshots and metrics live in `shots-terminal`; see `REPORT.md` for verification results and fixture limits.
