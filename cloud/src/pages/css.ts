/** `/static/pages.css` — the one stylesheet of the app-origin pages (no inline style: CSP `default-src 'self'`). */
export const PAGES_CSS = `:root { color-scheme: light dark; --fg: #1a1a1a; --muted: #555; --bg: #fff; --line: #d8d8d8; --accent: #1d4ed8; --accent-fg: #fff; }
@media (prefers-color-scheme: dark) { :root { --fg: #ececec; --muted: #b0b0b0; --bg: #161616; --line: #3a3a3a; --accent: #93b4ff; --accent-fg: #0b1530; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, sans-serif; }
main { max-width: 40rem; margin: 0 auto; padding: 2rem 1.25rem; }
footer { max-width: 40rem; margin: 0 auto; padding: 1rem 1.25rem 2rem; color: var(--muted); font-size: 0.875rem; }
a { color: var(--accent); }
h1 { font-size: 1.5rem; margin: 0 0 1rem; }
h2 { font-size: 1.125rem; margin: 1.75rem 0 0.5rem; }
section { border-top: 1px solid var(--line); }
.muted, small { color: var(--muted); }
.items { list-style: none; margin: 0; padding: 0; }
.items li { display: flex; align-items: center; gap: 0.75rem; min-height: 44px; border-bottom: 1px solid var(--line); }
.items li span { flex: 1; }
.actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 0.75rem 0; }
button, .button { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 1rem; border: 1px solid var(--accent); border-radius: 8px; background: var(--accent); color: var(--accent-fg); font: inherit; text-decoration: none; cursor: pointer; }
.items button { background: transparent; color: var(--accent); }
button:disabled { opacity: 0.6; cursor: default; }
input { min-height: 44px; padding: 0 0.75rem; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); font: inherit; }
`;
