import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportConfig, importConfig, SECRET_FILES, type TransferIo } from './configTransfer';

const TOKEN = 'ab'.repeat(32);
const SECRET_NOTE = `note sk-ant-${'x'.repeat(40)} and ${TOKEN}`;

function io(configDir: string, cwd: string, locked = false): TransferIo & { outText: () => string; errText: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    configDir, cwd, isLocked: () => locked,
    out: (s) => out.push(s), err: (s) => err.push(s),
    outText: () => out.join('\n'), errText: () => err.join('\n'),
  };
}

function spoken(t: ReturnType<typeof io>): string {
  return `${t.outText()}\n${t.errText()}`;
}

describe('config export / import', () => {
  let root: string;
  let configDir: string;
  let cwd: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-xfer-'));
    configDir = path.join(root, 'cfg');
    cwd = path.join(root, 'work');
    fs.mkdirSync(configDir, { mode: 0o700 });
    fs.mkdirSync(cwd);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function writeCfg(name: string, text: string) {
    fs.writeFileSync(path.join(configDir, name), text, { mode: 0o600 });
  }

  it('copies portable files and leaves secrets out of the archive and the output', () => {
    writeCfg('token', TOKEN + '\n');
    writeCfg('memory.md', SECRET_NOTE);
    writeCfg('pins.json', '{"pins":["s1"]}\n');
    writeCfg('settings.json', '{"defaultPermissionMode":"default"}\n');
    writeCfg('vapid.json', '{"privateKey":"SECRET-VAPID"}\n');
    writeCfg('service.env', 'PATH=/secret/bin\nHOME=/Users/secret-home\n');
    writeCfg('env', 'DECK_TOKEN=should-not-copy\n');
    const t = io(configDir, cwd);
    const outFile = path.join(cwd, 'deck-config.json');
    expect(exportConfig(t, { outFile })).toBe(0);
    const said = spoken(t);
    expect(said).not.toContain(TOKEN);
    expect(said).not.toContain('SECRET-VAPID');
    expect(said).not.toContain('sk-ant-');
    expect(said).not.toContain('/Users/secret-home');
    expect(said).not.toContain('should-not-copy');
    expect(said).toContain('pins.json');
    expect(said).toContain('memory.md');
    for (const name of SECRET_FILES) expect(said).toContain(name);
    const archive = JSON.parse(fs.readFileSync(outFile, 'utf8')) as { format: string; version: number; files: Record<string, string> };
    expect(archive).toMatchObject({ format: 'deck-config-export', version: 1 });
    expect(archive.files['pins.json']).toContain('s1');
    expect(archive.files['memory.md']).toBe(SECRET_NOTE);
    expect(archive.files['settings.json']).toContain('default');
    expect(archive.files.token).toBeUndefined();
    expect(archive.files['vapid.json']).toBeUndefined();
    expect(archive.files['service.env']).toBeUndefined();
    expect(archive.files.env).toBeUndefined();
    expect(fs.statSync(outFile).mode & 0o777).toBe(0o600);
  });

  it('refuses to write the archive inside the config dir, and skips a symlinked memory file', () => {
    writeCfg('pins.json', '{"pins":[]}\n');
    const t = io(configDir, cwd);
    expect(exportConfig(t, { outFile: path.join(configDir, 'out.json') })).toBe(1);
    expect(t.errText()).toMatch(/설정 폴더/);
    expect(fs.existsSync(path.join(configDir, 'out.json'))).toBe(false);
    fs.symlinkSync(path.join(configDir, 'token'), path.join(configDir, 'memory.md'));
    writeCfg('token', TOKEN);
    const t2 = io(configDir, cwd);
    const outFile = path.join(cwd, 'a.json');
    expect(exportConfig(t2, { outFile })).toBe(1);
    expect(t2.errText()).toMatch(/memory\.md/);
    expect(t2.errText()).not.toContain(TOKEN);
    const archive = JSON.parse(fs.readFileSync(outFile, 'utf8')) as { files: Record<string, string> };
    expect(archive.files['memory.md']).toBeUndefined();
    expect(archive.files['pins.json']).toContain('pins');
  });

  it('imports onto a new host, refuses overwrite without --yes, and never writes token', () => {
    const src = path.join(cwd, 'in.json');
    const archive = {
      format: 'deck-config-export', version: 1,
      files: {
        'pins.json': '{"pins":["moved"]}\n',
        'memory.md': SECRET_NOTE,
        'session-state.json': '{"s1":{"permissionMode":"acceptEdits","accountPin":"a"}}\n',
        token: TOKEN,
        'vapid.json': '{"privateKey":"nope"}',
        '../token': TOKEN,
        'pins.json/../../token': TOKEN,
      },
    };
    fs.writeFileSync(src, JSON.stringify(archive));
    const dest = path.join(root, 'new-host');
    const t = io(dest, cwd);
    expect(importConfig(t, { file: src, yes: false })).toBe(0);
    expect(spoken(t)).not.toContain(TOKEN);
    expect(spoken(t)).not.toContain('sk-ant-');
    expect(fs.readFileSync(path.join(dest, 'pins.json'), 'utf8')).toContain('moved');
    expect(fs.readFileSync(path.join(dest, 'memory.md'), 'utf8')).toBe(SECRET_NOTE);
    expect(fs.readFileSync(path.join(dest, 'session-state.json'), 'utf8')).toContain('acceptEdits');
    expect(fs.existsSync(path.join(dest, 'token'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'token'))).toBe(false);
    expect((fs.statSync(path.join(dest, 'memory.md')).mode & 0o777)).toBe(0o600);
    const again = io(dest, cwd);
    expect(importConfig(again, { file: src, yes: false })).toBe(2);
    expect(again.errText()).toMatch(/--yes/);
    expect(again.errText()).toContain('pins.json');
    expect(fs.readFileSync(path.join(dest, 'pins.json'), 'utf8')).toContain('moved');
    const replaced = JSON.parse(fs.readFileSync(src, 'utf8')) as { files: Record<string, string> };
    replaced.files['pins.json'] = '{"pins":["next"]}\n';
    fs.writeFileSync(src, JSON.stringify(replaced));
    const yes = io(dest, cwd);
    expect(importConfig(yes, { file: src, yes: true })).toBe(0);
    expect(fs.readFileSync(path.join(dest, 'pins.json'), 'utf8')).toContain('next');
    expect(spoken(yes)).not.toContain(TOKEN);
  });

  it('refuses a live server, a symlink archive, a bad file, and a symlink destination', () => {
    const src = path.join(cwd, 'in.json');
    fs.writeFileSync(src, JSON.stringify({ format: 'deck-config-export', version: 1, files: { 'pins.json': '{}\n' } }));
    const locked = io(configDir, cwd, true);
    expect(importConfig(locked, { file: src, yes: true })).toBe(1);
    expect(locked.errText()).toMatch(/서비스를 멈춘/);
    expect(fs.existsSync(path.join(configDir, 'pins.json'))).toBe(false);
    const link = path.join(cwd, 'link.json');
    fs.symlinkSync(src, link);
    const via = io(configDir, cwd);
    expect(importConfig(via, { file: link, yes: true })).toBe(1);
    expect(via.errText()).toMatch(/심볼릭 링크/);
    writeCfg('token', TOKEN + '\n');
    const asToken = io(path.join(root, 'elsewhere'), cwd);
    expect(importConfig(asToken, { file: path.join(configDir, 'token'), yes: true })).toBe(1);
    expect(spoken(asToken)).not.toContain(TOKEN);
    fs.symlinkSync(path.join(configDir, 'token'), path.join(configDir, 'pins.json'));
    const destLink = io(configDir, cwd);
    expect(importConfig(destLink, { file: src, yes: true })).toBe(1);
    expect(fs.readlinkSync(path.join(configDir, 'pins.json'))).toContain('token');
    expect(destLink.errText()).not.toContain(TOKEN);
  });
});
