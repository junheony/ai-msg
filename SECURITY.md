# Security

AI-MSG runs commands on the machine it is installed on. Please report vulnerabilities privately.

## Reporting

Use GitHub's private vulnerability reporting: the repository's **Security** tab, then **Report a vulnerability**. Do not open a public issue for a security problem.

Include the commit you tested, how to reproduce it, and what an attacker gains. Never include your login token, CLI credentials or conversation transcripts.

## Scope

In scope: authentication and session handling, the `Host` / `Origin` checks, the permission flow, the in-app re-login window (it may run only the server-chosen login command for a seat — `claude auth login`, the same command with `CLAUDE_CONFIG_DIR`, `codex login`, `grok login --device-auth`, or `agy` with no arguments in that Gemini seat's HOME — and accepts one auth-code line or Enter, never a command string), file and attachment APIs, and anything that lets a web page or another tailnet device act without the login token.

Out of scope: exposing the port to the public internet (unsupported), and behavior of the Claude Code, Codex or Gemini CLIs themselves.

## Claude hooks and mods

MSG runs Claude as `claude -p` and shows its own approval card before an edit tool runs. Claude Code mods (CLI 2.1.287 and later) are plugin JavaScript that can run on `tool.call` and approve the call before that card. User, project, and plugin hooks can do the same.

Each MSG turn writes a private `--settings` file. That file registers MSG's PreToolUse relay and, by default, sets `disableAllHooks: true`. In flag settings this turns off user, project, local, and plugin hooks, and it stops user-installed mods. MSG's own hooks are in that same file, so they still run. A project setting of `disableAllHooks: false` does not override the flag file.

`DECK_ALLOW_USER_MODS=1` in the server environment omits `disableAllHooks`. User hooks and mods then load, and a mod can approve a tool call without MSG's card. Leave it unset unless that is what you want.

These do not do this job:

- `--safe-mode` / `CLAUDE_CODE_SAFE_MODE` also drops CLAUDE.md, skills, plugins, MCP, and custom commands. MSG would lose the user MCP servers it intentionally keeps, and its own hooks would not be a reliable exception.
- `allowManagedModsOnly` is ignored outside managed settings, so a `--settings` file cannot set it.
- `allowManagedHooksOnly` is managed-scope only.
- `--setting-sources` with an empty list does not reliably stop hooks, and MSG loads user settings on purpose (subscription login, MCP).
- `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=0` has been ignored since CLI 2.1.287.

Managed settings and org-installed mods cannot be turned off by MSG. The 총사령탑 judge process is separate: it already sets `disableAllHooks` and does not register hooks of its own.

Only the latest commit on `main` is supported. This is a personal project maintained on a best-effort basis.
