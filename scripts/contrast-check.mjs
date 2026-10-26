#!/usr/bin/env node
// WCAG 2.x contrast check for the text tokens in src/ui/styles.css (spec §7.2: faint >= 4.5, muted ~6.4 on --bg, chips >= 4.5). Exit 1 on a miss.
// Tokens are read from the stylesheet itself; color-mix(var(--fg) N%, transparent) overlays are composited by hand.
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/ui/styles.css", import.meta.url), "utf8");
const block = (re) => {
  const m = css.match(re);
  if (!m) throw new Error(`block not found: ${re}`);
  return m[1];
};
const vars = (body) => Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const dark = vars(block(/^:root \{([\s\S]*?)^\}/m));
const light = { ...dark, ...vars(block(/^:root\[data-theme="light"\] \{([\s\S]*?)^\}/m)) };

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lin = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const mix = (fg, bg, a) => fg.map((c, i) => c * a + bg[i] * (1 - a));

function check(name, t) {
  const c = (k) => {
    const v = t[k];
    if (!/^#[0-9a-f]{6}$/i.test(v)) throw new Error(`${name} --${k} is not a hex color: ${v}`);
    return hex(v);
  };
  const pct = (k) => Number(t[k].match(/var\(--fg\) ([\d.]+)%/)[1]) / 100;
  // --hover / --selected: a hex, an rgba(...) or a color-mix(var(--fg|--accent) N%, transparent), laid over `base`.
  const over = (k, base) => {
    const v = t[k];
    if (/^#[0-9a-f]{6}$/i.test(v)) return hex(v);
    const rgba = v.match(/^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/);
    if (rgba) return mix([+rgba[1], +rgba[2], +rgba[3]], base, Number(rgba[4]));
    const cm = v.match(/var\(--([\w-]+)\) ([\d.]+)%, transparent/);
    if (cm) return mix(c(cm[1]), base, Number(cm[2]) / 100);
    throw new Error(`${name} --${k}: cannot composite ${v}`);
  };
  const bg = c("bg");
  const pill = (base) => mix(c("fg"), base, pct("pill-bg"));
  // [label, foreground, background, floor]
  const rows = [
    ["fg / bg", c("fg"), bg, 7],
    ["muted / bg", c("muted"), bg, 6.4],
    ["muted / sidebar", c("muted"), c("sidebar"), 4.5],
    ["muted / panel", c("muted"), c("panel"), 4.5],
    ["faint / bg", c("faint"), bg, 4.5],
    ["faint / sidebar", c("faint"), c("sidebar"), 4.5],
    ["faint / panel", c("faint"), c("panel"), 4.5],
    ["link / bg", c("link"), bg, 4.5],
    ["link / panel", c("link"), c("panel"), 4.5],
    ["muted / pill (chip)", c("muted"), pill(bg), 4.5],
    ["fg / pill (chip)", c("fg"), pill(bg), 4.5],
    ["ok / bg", c("ok"), bg, 4.5],
    ["warn / bg", c("warn"), bg, 4.5],
    ["danger / bg", c("danger"), bg, 4.5],
    ["bg / warn (badge)", bg, c("warn"), 4.5],
    ["fg / bubble", c("fg"), c("bubble"), 7],
    // Text / glyph on an --accent fill: the 전송 button arrow (graphics 3), the .tag badge and the find-in-page current hit (text 4.5).
    ["on-accent / accent (send)", c("on-accent"), c("accent"), 3],
    ["on-accent / accent (tag, find-hit)", c("on-accent"), c("accent"), 4.5],
    ["btn-primary", c("btn-primary-fg"), c("btn-primary-bg"), 4.5],
    // Sidebar rows: the meta / time are faint at rest (faint / sidebar above) and muted on a tinted row (hover, shown ⋯,
    // open menu, current): faint there drops under 4.5 in the light theme.
    ["muted / sidebar+hover", c("muted"), over("hover", c("sidebar")), 4.5],
    ["muted / sidebar+selected", c("muted"), over("selected", c("sidebar")), 4.5],
    // 설정 sheet (on --panel): a hovered segment button (.seg button:hover → --fg on --hover) and 모두 자동 승인 (--danger).
    ["fg / panel+hover (seg)", c("fg"), over("hover", c("panel")), 4.5],
    ["muted / panel+hover", c("muted"), over("hover", c("panel")), 4.5],
    ["danger / panel", c("danger"), c("panel"), 4.5],
    // Tool calls (R2-B, on --code-bg): a failed call's exit-code chip (--bg on a --danger fill), its danger edge and the
    // server-cut note's --warn bar (graphics floor 3), notes and key names in --muted; the section header on --bg-raised.
    ["bg / danger (exit chip)", bg, c("danger"), 4.5],
    ["danger edge / code-bg", c("danger"), c("code-bg"), 3],
    ["warn bar / code-bg (cut note)", c("warn"), c("code-bg"), 3],
    ["muted / code-bg (tool notes)", c("muted"), c("code-bg"), 4.5],
    ["muted / bg-raised (tool head)", c("muted"), c("bg-raised"), 4.5],
    // Usage strip (top bar / phone line): segments on --bg, the session's segment (and the line under the bar, hovered /
    // its sheet open) on --panel; the "→" of the next turn
    // is a glyph (graphics floor 3).
    ...[["fg", 4.5], ["muted", 4.5], ["warn", 4.5], ["danger", 4.5], ["accent", 3]].flatMap(([k, floor]) => [
      [`${k} / strip`, c(k), bg, floor],
      [`${k} / strip current`, c(k), c("panel"), floor],
    ]),
    ["fg-strong / strip current", c("fg-strong"), c("panel"), 4.5],
    // Old numbers (a stale seat): on the strip only the clock and age dim to --muted (a "리셋됨" seat's label too; the
    // number keeps its level colour, checked above), on the bar / current; and in the sheet
    // (rows, the status tag, the refresh line: on --panel, a seat card's faint tint over it). The 12px clock / refresh
    // icons are currentColor in the same muted.
    ["muted / strip stale", c("muted"), bg, 4.5],
    ["muted / strip stale current", c("muted"), c("panel"), 4.5],
    ["muted / sheet old seat", c("muted"), mix(c("fg"), c("panel"), 0.025), 4.5],
    ["fg / sheet old seat name", c("fg"), mix(c("fg"), c("panel"), 0.025), 4.5],
    // 설치 점검 (on --panel): commands and the 기본 badge on a pill, the state dots (graphics floor 3).
    ["fg / pill on panel", c("fg"), pill(c("panel")), 4.5],
    ["fg-strong / panel", c("fg-strong"), c("panel"), 4.5],
    ["muted / pill on panel", c("muted"), pill(c("panel")), 4.5],
    ["ok dot / panel", c("ok"), c("panel"), 3],
    ["warn dot / panel", c("warn"), c("panel"), 3],
    // Sidebar row avatars: the session glyph (a 2px line icon, --avatar-glyph) on the project colour — graphics floor 3.
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => [`glyph / avatar-${n}`, c("avatar-glyph"), c(`avatar-${n}`), 3]),
    // …and the default monogram (the title's first letter or two, 600+ weight, --avatar-glyph): text, so the text floor.
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => [`monogram / avatar-${n}`, c("avatar-glyph"), c(`avatar-${n}`), 4.5]),
    // Engine badges (C · G · Gm · X): a white letter on the engine colour — text, so the text floor; in a sidebar row's
    // line 2 the badge is muted with the letter cut in the sidebar colour.
    ...["claude", "codex", "gemini", "grok"].map((k) => [`badge letter / engine-${k}`, c("engine-fg"), c(`engine-${k}`), 4.5]),
    ["badge letter / muted (row)", c("sidebar"), c("muted"), 4.5],
    // Sidebar row end: the one status mark (unread / running ring in --accent, 승인 대기 in --warn, background in --muted)
    // on the row at rest, hovered and current (there accent leans 15% toward --fg) — graphics floor 3. The engine glyph and 읽기 전용 tag are muted (above).
    ...["accent", "warn", "muted"].flatMap((k) => [
      [`${k} mark / sidebar`, c(k), c("sidebar"), 3],
      [`${k} mark / sidebar+hover`, c(k), over("hover", c("sidebar")), 3],
      [`${k} mark / sidebar+selected`, k === "accent" ? mix(c("fg"), c("accent"), 0.15) : c(k), over("selected", c("sidebar")), 3],
    ]),
  ];
  console.log(`\n${name}`);
  let bad = 0;
  for (const [label, f, b, floor] of rows) {
    const r = ratio(f, b);
    const ok = r >= floor;
    if (!ok) bad++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(22)} ${r.toFixed(2)}:1  (>= ${floor})`);
  }
  return bad;
}

// Landing page (site/styles.css): its own :root (dark) and a prefers-color-scheme: light :root, same text floors.
const siteCss = readFileSync(new URL("../site/styles.css", import.meta.url), "utf8");
const siteBlock = (re) => {
  const m = siteCss.match(re);
  if (!m) throw new Error(`site block not found: ${re}`);
  return m[1];
};
const siteDark = vars(siteBlock(/^:root \{([\s\S]*?)^\}/m));
const siteLight = { ...siteDark, ...vars(siteBlock(/@media \(prefers-color-scheme: light\) \{\s*:root \{([\s\S]*?)^ {2}\}/m)) };
function checkSite(name, t) {
  const c = (k) => {
    const v = t[k];
    if (!/^#[0-9a-f]{6}$/i.test(v)) throw new Error(`${name} --${k} is not a hex color: ${v}`);
    return hex(v);
  };
  const rows = [
    ["fg / bg", c("fg"), c("bg"), 7],
    ["fg-strong / panel", c("fg-strong"), c("panel"), 7],
    ["muted / bg", c("muted"), c("bg"), 4.5],
    ["muted / panel", c("muted"), c("panel"), 4.5],
    ["muted / bg-raised", c("muted"), c("bg-raised"), 4.5],
    ["faint / bg", c("faint"), c("bg"), 4.5],
    ["link / bg", c("link"), c("bg"), 4.5],
    ["link / panel", c("link"), c("panel"), 4.5],
    ["accent / bg (eyebrow)", c("accent"), c("bg"), 4.5],
    ["on-accent / accent (step)", c("on-accent"), c("accent"), 4.5],
    ["btn-primary", c("btn-primary-fg"), c("btn-primary-bg"), 4.5],
    ["code-fg / code-bg", c("code-fg"), c("code-bg"), 4.5],
    ["faint / code-bg", c("faint"), c("code-bg"), 4.5],
    ["warn / panel (badge)", c("warn"), c("panel"), 4.5],
    ["warn / bg (badge)", c("warn"), c("bg"), 4.5],
    ["ok / panel (check)", c("ok"), c("panel"), 3],
  ];
  console.log(`\n${name}`);
  let bad = 0;
  for (const [label, f, b, floor] of rows) {
    const r = ratio(f, b);
    const ok = r >= floor;
    if (!ok) bad++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(22)} ${r.toFixed(2)}:1  (>= ${floor})`);
  }
  return bad;
}

const bad = check("dark", dark) + check("light", light) + checkSite("site dark", siteDark) + checkSite("site light", siteLight);
console.log(bad ? `\n${bad} pair(s) below floor` : "\nall pairs pass");
process.exit(bad ? 1 : 0);
