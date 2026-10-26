# AI-MSG demo video: shot list

A 35–45 second screen recording for the landing page's demo section. Until it exists the page shows still
screenshots instead (`site/assets/shots/<locale>/`). Recording it is a manual job: it needs a real session.

## Before recording

- Record from a separate demo user account on the computer, not your everyday one: fresh app settings, a throwaway
  project folder with a small sample repo, and session titles that say nothing about real work.
- Sign in only the accounts you want on screen. Hide the menu bar clock, notifications and bookmarks.
- Window at 1440×900, app language English, dark theme. Phone cut: a real phone on the same Tailscale network, or a
  390-wide browser window.
- Nothing personal on screen: no home-folder paths, emails, account names, tokens or company repos. Check every frame
  before export.

## Cuts

| # | Length | What is on screen | Caption (optional) |
|---|--------|-------------------|--------------------|
| 1 | 5 s | The inbox: Claude Code, Codex, Gemini and Grok sessions side by side in the sidebar. | One inbox for every coding agent |
| 2 | 8 s | Start a session, type a small task, the agent starts working; open a second one in split view. | Run them side by side |
| 3 | 7 s | A permission card appears; approve it with one click. | Approve from the conversation |
| 4 | 8 s | The usage bars near a limit; the next turn carries on with another account or vendor (failover note visible). | When one hits its limit, the work carries on |
| 5 | 7 s | The same session on the phone: read the reply, answer a question. | From your desk or your phone |
| 6 | 5 s | End card: AI-MSG logo, `npx ai-msg`, the site address. | Free and open source |

No sound track required; if you add one, keep it quiet and royalty free. No voice-over needed.

## Export

- H.264 MP4, 1440 px wide (or 1280), 30 fps, no audio or AAC, **20 MB or less** (the build refuses anything larger).
- Save it as `site/assets/demo/demo.mp4`. The build picks it up and shows the video (with the inbox screenshot as the
  poster) in place of the stills.
- Rebuild with `npx tsx site/build.ts --out <folder>` and watch it once in the built page before publishing.
