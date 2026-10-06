import { legacyRegistry, type AccountRegistry } from './accounts';

/** Tests only: the a/b/c registry (`~/.claude`, `~/.claude-b`, `~/.claude-c` under `homeDir`), passed explicitly wherever production code takes one. */
export function testRegistry(homeDir = '/h'): AccountRegistry {
  return legacyRegistry(homeDir);
}
