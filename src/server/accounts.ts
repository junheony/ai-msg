import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ACCOUNT_ID_RE, buildRegistry, defaultAccountsConfig, type AccountRegistry } from '../shared/accounts';

/** `<configDir>/accounts.json` (optional). Unknown fields are ignored. */
const accountsFileSchema = z.object({
  version: z.literal(1),
  home: z.string().optional(),
  accounts: z.array(z.object({
    id: z.string().regex(ACCOUNT_ID_RE),
    label: z.string().min(1).max(40).optional(),
    configDir: z.string().min(1).optional(),
    card: z.string().min(1).optional(),
    retired: z.boolean().optional(),
  })),
});

function exists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Names of the Claude profile directories in the home dir: `.claude`, and every `.claude-<x>` directory that holds a
 * `projects` dir or a `.claude.json` (what a profile has once it was logged in or used) — so a same-looking directory
 * that is not a profile (plugin data, an emptied backup) is not taken for an account. Only names and existence are read.
 */
export function discoverProfileNames(homeDir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(homeDir);
  } catch {
    return [];
  }
  const isDir = (p: string) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  return names
    .filter((n) => n === '.claude' || n.startsWith('.claude-'))
    .filter((n) => {
      const dir = path.join(homeDir, n);
      if (!isDir(dir)) return false;
      return n === '.claude' || isDir(path.join(dir, 'projects')) || exists(path.join(dir, '.claude.json'));
    })
    .sort();
}

/**
 * The account registry: `<configDir>/accounts.json` when there is one, else the profiles found in the home dir.
 * A file that cannot be used (unreadable, broken JSON, schema, duplicate id, unknown home, …) never stops the
 * server: the reason is logged and the discovered profiles are used.
 */
export function loadAccountRegistry(opts: { configDir: string; homeDir: string; log?: (line: string) => void }): AccountRegistry {
  const file = path.join(opts.configDir, 'accounts.json');
  let text: string | null = null;
  let problem: string | null = null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') problem = `읽지 못함 (${(err as NodeJS.ErrnoException).code ?? String(err)})`;
  }
  if (text !== null) {
    try {
      const parsed = accountsFileSchema.safeParse(JSON.parse(text));
      if (parsed.success) return buildRegistry(parsed.data, { homeDir: opts.homeDir });
      problem = parsed.error.issues.map((i) => `${i.path.join('.') || '(최상위)'}: ${i.message}`).join('; ');
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
    }
  }
  if (problem !== null) (opts.log ?? console.error)(`deck: ${file} 을 쓸 수 없어 기본 발견(~/.claude, ~/.claude-<id>)으로 시작합니다 — ${problem}`);
  return buildRegistry(defaultAccountsConfig(discoverProfileNames(opts.homeDir)), { homeDir: opts.homeDir });
}
