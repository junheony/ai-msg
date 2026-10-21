import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { capServiceLog } from './serviceLog';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-svclog-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

it('under the cap: untouched; over it: copied to .1 and truncated in place (same inode, appends keep working)', () => {
  const file = path.join(dir, 'quarterdeck.log');
  expect(capServiceLog(file, 10)).toBe(false); // missing file
  fs.writeFileSync(file, 'short\n');
  expect(capServiceLog(file, 10)).toBe(false);
  const fd = fs.openSync(file, 'a');
  fs.writeSync(fd, 'more than ten bytes\n');
  const ino = fs.statSync(file).ino;
  expect(capServiceLog(file, 10)).toBe(true);
  expect(fs.readFileSync(`${file}.1`, 'utf8')).toBe('short\nmore than ten bytes\n');
  expect(fs.statSync(file).size).toBe(0);
  expect(fs.statSync(file).ino).toBe(ino);
  fs.writeSync(fd, 'after\n');
  fs.closeSync(fd);
  expect(fs.readFileSync(file, 'utf8')).toBe('after\n');
});
