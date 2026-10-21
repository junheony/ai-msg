import { describe, expect, it } from 'vitest';
import { stableNodePath } from './nodePath';

const links: Record<string, string> = {
  '/opt/homebrew/Cellar/node/26.1.0/bin/node': '/opt/homebrew/Cellar/node/26.1.0/bin/node',
  '/opt/homebrew/opt/node/bin/node': '/opt/homebrew/Cellar/node/26.1.0/bin/node',
  '/opt/homebrew/bin/node': '/opt/homebrew/Cellar/node/26.1.0/bin/node',
  '/usr/local/Cellar/node@24/24.3.0/bin/node': '/usr/local/Cellar/node@24/24.3.0/bin/node',
  '/usr/local/bin/node': '/usr/local/Cellar/node@24/24.3.0/bin/node',
};
const deps = { platform: 'linux' as const, realpath: (p: string) => links[p] ?? p, exists: (p: string) => p in links || p.startsWith('/usr/bin'), nodeVersion: async () => 'v26.1.0' };

describe('stableNodePath', () => {
  it('nodePath: Homebrew Cellar → opt/bin symlink with the same realpath', async () => {
    expect(await stableNodePath({ ...deps, execPath: '/opt/homebrew/Cellar/node/26.1.0/bin/node' })).toEqual({ node: '/opt/homebrew/opt/node/bin/node' });
    // node@24: no opt link here → <prefix>/bin/node, whose real path matches.
    expect(await stableNodePath({ ...deps, execPath: '/usr/local/Cellar/node@24/24.3.0/bin/node' })).toEqual({ node: '/usr/local/bin/node' });
    expect(await stableNodePath({ ...deps, execPath: '/x/Cellar/node/1.0.0/bin/node' })).toHaveProperty('error');
  });

  it('nodePath: nvm/fnm/volta/asdf/mise paths are refused without --node', async () => {
    for (const p of ['/h/.nvm/versions/node/v24.1.0/bin/node', '/h/.local/share/fnm/node-versions/v24/installation/bin/node', '/h/.fnm/x/bin/node', '/h/.volta/tools/image/node/24.0.0/bin/node', '/h/.asdf/installs/nodejs/24.0.0/bin/node', '/h/.local/share/mise/installs/node/24/bin/node', '/usr/local/n/versions/node/24.0.0/bin/node']) {
      const r = await stableNodePath({ ...deps, execPath: p });
      expect(r, p).toHaveProperty('error');
      expect((r as { error: string }).error).toContain('--node');
    }
  });

  it('nodePath: --node is checked for version >= 24', async () => {
    expect(await stableNodePath({ ...deps, execPath: '/h/.nvm/versions/node/v24.1.0/bin/node', explicit: '/usr/bin/node' })).toEqual({ node: '/usr/bin/node' });
    expect(await stableNodePath({ ...deps, execPath: '/usr/bin/node', explicit: '/usr/bin/node', nodeVersion: async () => 'v22.3.0' })).toHaveProperty('error');
    expect(await stableNodePath({ ...deps, execPath: '/usr/bin/node', explicit: '/nope/node' })).toHaveProperty('error');
    expect(await stableNodePath({ ...deps, execPath: '/usr/bin/node', explicit: '/usr/bin/node', nodeVersion: async () => null })).toHaveProperty('error');
  });

  it('other paths as they are; darwin adds the TCC warning', async () => {
    expect(await stableNodePath({ ...deps, execPath: '/usr/bin/node' })).toEqual({ node: '/usr/bin/node' });
    expect(await stableNodePath({ ...deps, platform: 'darwin', execPath: '/usr/bin/node' })).toMatchObject({ node: '/usr/bin/node', warning: expect.stringContaining('전체 디스크') });
  });
});
