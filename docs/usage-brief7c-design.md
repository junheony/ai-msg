# BRIEF7c usage design

Audience: the owner choosing which subscribed coding account can take the next turn. Show remaining capacity, its constrained window, and when it returns.

Plan: preserve the shared Korean system/Pretendard stack, tabular numerals and glass surfaces. Existing palette: canvas #14141c, surface #22222e, text #efeff6, muted #b3b1c2, amber #d6a24a, coral #e2675b. Light mode uses existing semantic tokens. Provider marks identify rows; Claude accounts use small A/B/C badges. One remaining-capacity track per account, fixed numeric column, right-aligned reset column below.

```
[mark] Claude [A]                      37%
────────────────── remaining track ──────
주간                37%       2일 후 리셋
Fable               소진      2일 후 리셋
[mark] GPT / Codex                     82%
Hermes와 한도 공유
[mark] Gemini       로그인 필요    로그인
```

Pre-build critique: the owner crop repeats the same bar twice, wraps the current account in another pill, and repeats Gemini login copy on two lines. Identical rounded cards would amplify the noise. Use one list with quiet separators and aligned subrows. Preserve the shell and type scale; emphasize provider marks and capacity. Exhaustion uses a restrained amber chip plus relative reset text; absolute timestamps explicitly show KST in tooltips. Login state is muted with one action. Unknown values remain unknown.

References: https://ref.theseeker.io/?category=dashboard and https://glass.samasante.com/. Borrow restrained hierarchy within the established shell.
