# 리서치 패널

The hub's 리서치 tab and the panel at the bottom of the 개요 show two JSON files from the server's disk. The server reads them on every request, so a new or edited entry appears without a build or restart (open pages refresh every 5 minutes, or on reload).

| | Default path | Override |
| --- | --- | --- |
| Articles | `~/.msg/research/articles.json` | `MSG_RESEARCH_DIR` |
| Outside sources | `~/.msg/research/sources.json` | `MSG_RESEARCH_DIR` |

The route is `GET /api/hub/research`, behind the normal login. It is read-only; there is no write route.

## Add an article

```sh
scripts/msg-research-add \
  --title "토큰화 주식 내러티브" \
  --date 2026-11-02 \
  --url https://example.com/report \
  --tags "RWA,Perp/Prop" \
  --summary "한 줄 결론" \
  --pinned
```

`--title`, `--date`, `--url` are required. Optional: `--summary`, `--tags` (comma separated), `--source` (default `AI-Crypto 리서치`), `--id` (generated from the date when omitted), `--pinned`, `--daily`. It refuses a duplicate id or URL and writes atomically; `MSG_RESEARCH_DIR` applies here too.

To fill in a summary later, edit the entry in `articles.json`. An empty summary shows as 요약 대기.

## `articles.json`

A JSON array of:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string, required | Unique. |
| `title` | string, required | |
| `date` | `YYYY-MM-DD`, required | Must be a real date. |
| `url` | http(s) URL, required | Opens in a new tab. |
| `summary` | string | One-line conclusion. Empty or absent means 요약 대기. |
| `tags` | string[] | The first tag colours the card. |
| `source` | string | Default `AI-Crypto 리서치`. |
| `pinned` | boolean | Sorts first. The first article is the lead. |
| `updatedDaily` | boolean | Shows 매일 갱신 in place of the date and sorts after dated articles. |

Order: pinned, then newest date, then daily-updated. These tags have their own colour: `RWA`, `Perp/Prop` (shown as Perp·Prop), `AI Compute`, `Launchpad`. Any other tag works and stays neutral.

## `sources.json`

A JSON array of:

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string, required | |
| `nameKo` | string | Shown beside the name. |
| `url` | http(s) URL, required | Record the final URL after redirects. |
| `focus` | string, required | One line on what they cover. |
| `category` | `Research house`, `Data` or `AI-GPU`, required | The row it appears in. |
| `ownerPick` | boolean | Moves it to the 오너 픽 row at the top. |

## When something is wrong

| State | What the page shows |
| --- | --- |
| File missing | Articles: a friendly empty state with the next step. Sources: the section is hidden. |
| File is not a JSON array, or over 2 MB | Names the file to check. The other file still shows. |
| Some entries are invalid or duplicated | Those are left out; the page says how many. |
| Server predates this route | Says to deploy the new build, with a retry button. |

The font is Hahmlet (OFL), bundled through `@fontsource-variable/hahmlet`; the browser downloads only the slices a page uses.

## Screenshots

```sh
npm run build
QA_PORT=9381 node --import tsx scripts/qa/research-demo.ts /tmp/research-qa.json &
PLAYWRIGHT=<path to playwright/index.mjs> node scripts/qa/shoot-research.mjs /tmp/research-qa.json shots-research
```

The demo host is isolated and read-only. It reads the real research files; the hub status above the panel on the 개요 is a test fixture.
