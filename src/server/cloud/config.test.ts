import { describe, expect, it } from 'vitest';
import { cloudConfig } from './config';

describe('cloudConfig', () => {
  const run = (env: NodeJS.ProcessEnv) => {
    const logs: string[] = [];
    return { cfg: cloudConfig(env, (s) => logs.push(s)), logs };
  };

  it('defaults to the two production origins, enabled', () => {
    expect(run({}).cfg).toEqual({ enabled: true, baseUrl: 'https://app.aimsg.app', relayUrl: 'https://relay.aimsg.app' });
  });

  it('DECK_CLOUD=off turns it off (any case)', () => {
    for (const v of ['off', 'OFF', 'Off']) expect(run({ DECK_CLOUD: v }).cfg.enabled, v).toBe(false);
  });

  it('a disabled config keeps no address', () => {
    for (const env of [{ DECK_CLOUD: 'off', DECK_CLOUD_URL: 'https://app.example.test' }, { DECK_CLOUD_URL: 'http://user:secret@app.example.test' }, { DECK_CLOUD_URL: 'https://same.example.test', DECK_RELAY_URL: 'https://same.example.test' }]) {
      expect(run(env).cfg).toEqual({ enabled: false, baseUrl: '', relayUrl: '' });
    }
  });

  it('https only; http only for loopback; same origin for app and relay → disabled', () => {
    expect(run({ DECK_CLOUD_URL: 'https://app.example.test/', DECK_RELAY_URL: 'https://relay.example.test' }).cfg)
      .toEqual({ enabled: true, baseUrl: 'https://app.example.test', relayUrl: 'https://relay.example.test' });
    for (const host of ['127.0.0.1:8787', 'localhost:8787', '[::1]:8787']) {
      const { cfg, logs } = run({ DECK_CLOUD_URL: `http://${host}`, DECK_RELAY_URL: `http://${host.replace('8787', '8788')}` });
      expect(cfg.enabled, host).toBe(true);
      expect(logs).toEqual([]);
    }
    const plain = run({ DECK_CLOUD_URL: 'http://app.example.test' });
    expect(plain.cfg.enabled).toBe(false);
    expect(plain.logs).toHaveLength(1);
    expect(run({ DECK_RELAY_URL: 'http://relay.example.test' }).cfg.enabled).toBe(false);
    expect(run({ DECK_CLOUD_URL: 'ftp://app.example.test' }).cfg.enabled).toBe(false);
    expect(run({ DECK_CLOUD_URL: 'not a url' }).cfg.enabled).toBe(false);
    const same = run({ DECK_CLOUD_URL: 'https://one.example.test', DECK_RELAY_URL: 'https://one.example.test/x' });
    expect(same.cfg.enabled).toBe(false);
    expect(same.logs).toHaveLength(1);
  });

  it('never logs the configured address (it may carry credentials)', () => {
    const { logs } = run({ DECK_CLOUD_URL: 'http://user:secret@app.example.test' });
    expect(logs.join('\n')).not.toContain('secret');
  });
});
