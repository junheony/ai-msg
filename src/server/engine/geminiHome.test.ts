import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureGeminiSeatHome } from './geminiHome';

let root = '';
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = ''; });

describe('ensureGeminiSeatHome', () => {
  it('g1 is the real home; g2 is a 0700 directory with git and ssh links and no .gemini link', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-agy-home-'));
    fs.writeFileSync(path.join(root, '.gitconfig'), '[user]\n');
    fs.mkdirSync(path.join(root, '.ssh'));
    fs.writeFileSync(path.join(root, '.ssh', 'config'), 'Host x\n');
    expect(ensureGeminiSeatHome('g1', root)).toEqual({ ok: true, home: root });
    expect(fs.existsSync(path.join(root, '.agy-g2'))).toBe(false);
    const made = ensureGeminiSeatHome('g2', root);
    expect(made).toEqual({ ok: true, home: path.join(root, '.agy-g2') });
    const seat = path.join(root, '.agy-g2');
    expect(fs.lstatSync(seat).isDirectory()).toBe(true);
    expect(fs.lstatSync(seat).mode & 0o777).toBe(0o700);
    expect(fs.readlinkSync(path.join(seat, '.gitconfig'))).toBe(path.join(root, '.gitconfig'));
    expect(fs.readlinkSync(path.join(seat, '.ssh'))).toBe(path.join(root, '.ssh'));
    expect(fs.existsSync(path.join(seat, '.gemini'))).toBe(false);
    fs.unlinkSync(path.join(seat, '.gitconfig'));
    fs.writeFileSync(path.join(seat, '.gitconfig'), 'kept');
    expect(ensureGeminiSeatHome('g2', root).ok).toBe(true);
    expect(fs.readFileSync(path.join(seat, '.gitconfig'), 'utf8')).toBe('kept');
  });

  it('a symlink in place of the seat directory is refused', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-agy-home-'));
    const other = path.join(root, 'other');
    fs.mkdirSync(other);
    fs.symlinkSync(other, path.join(root, '.agy-g2'));
    expect(ensureGeminiSeatHome('g2', root)).toMatchObject({ ok: false });
  });
});
