import { describe, expect, it } from 'vitest';
import { decideOrigin, resolveOriginPolicy, type OriginPolicy } from './origin.js';

function policy(overrides: Partial<OriginPolicy> = {}): OriginPolicy {
  return resolveOriginPolicy({ devOrigins: [], env: {}, ...overrides });
}

describe('origin policy', () => {
  it('allows a loopback request that carries no Origin', () => {
    expect(decideOrigin({ host: '127.0.0.1:4310' }, policy())).toMatchObject({ allowed: true, reason: 'no-origin' });
    expect(decideOrigin({ host: 'localhost:4310' }, policy())).toMatchObject({ allowed: true, reason: 'no-origin' });
    expect(decideOrigin({ host: '[::1]:4310' }, policy())).toMatchObject({ allowed: true, reason: 'no-origin' });
  });

  it('allows a loopback request whose Origin matches the Host', () => {
    expect(decideOrigin({ host: '127.0.0.1:4310', origin: 'http://127.0.0.1:4310' }, policy()))
      .toMatchObject({ allowed: true, reason: 'host-match' });
    expect(decideOrigin({ host: 'localhost:4310', origin: 'https://localhost:4310' }, policy()))
      .toMatchObject({ allowed: true, reason: 'host-match' });
  });

  it('rejects a loopback request with a foreign Origin when trust-proxy is off', () => {
    const decision = decideOrigin({ host: '127.0.0.1:4310', origin: 'https://example.test' }, policy());
    expect(decision).toMatchObject({ allowed: false, reason: 'origin-not-allowed' });
    expect(decision.origin).toBe('https://example.test');
  });

  it('allows a foreign Origin that is listed in EXTENDO_ALLOWED_ORIGINS', () => {
    const resolved = resolveOriginPolicy({ devOrigins: [], env: { EXTENDO_ALLOWED_ORIGINS: 'https://4320-abc.capysandbox.net, https://extendo.example' } });
    expect(resolved.allowedOrigins).toEqual(['https://4320-abc.capysandbox.net', 'https://extendo.example']);
    expect(decideOrigin({ host: 'localhost:4320', origin: 'https://4320-abc.capysandbox.net' }, resolved))
      .toMatchObject({ allowed: true, reason: 'allowed-origin' });
    expect(decideOrigin({ host: 'localhost:4320', origin: 'https://4320-abc.capysandbox.net/' }, resolved))
      .toMatchObject({ allowed: true, reason: 'allowed-origin' });
  });

  it('ignores x-forwarded-host when trust-proxy is off', () => {
    const decision = decideOrigin({
      host: 'localhost:4320',
      origin: 'https://4320-abc.capysandbox.net',
      'x-forwarded-host': '4320-abc.capysandbox.net',
      'x-forwarded-proto': 'https',
    }, policy());
    expect(decision).toMatchObject({ allowed: false, reason: 'origin-not-allowed' });
    expect(decision.forwardedHost).toBe('4320-abc.capysandbox.net');
  });

  it('rejects a public Host when trust-proxy is off', () => {
    expect(decideOrigin({ host: '4320-abc.capysandbox.net', origin: 'https://4320-abc.capysandbox.net' }, policy()))
      .toMatchObject({ allowed: false, reason: 'host-not-loopback' });
  });

  it('allows a proxied request when trust-proxy is on and the Origin matches the forwarded host', () => {
    const decision = decideOrigin({
      host: 'localhost:4320',
      origin: 'https://4320-abc.capysandbox.net',
      'x-forwarded-host': '4320-abc.capysandbox.net',
      'x-forwarded-proto': 'https',
    }, policy({ trustProxy: true }));
    expect(decision).toMatchObject({ allowed: true, reason: 'host-match', host: '4320-abc.capysandbox.net' });
  });

  it('rejects the same proxied request when trust-proxy is off', () => {
    const decision = decideOrigin({
      host: 'localhost:4320',
      origin: 'https://4320-abc.capysandbox.net',
      'x-forwarded-host': '4320-abc.capysandbox.net',
      'x-forwarded-proto': 'https',
    }, policy());
    expect(decision).toMatchObject({ allowed: false, reason: 'origin-not-allowed' });
  });

  it('keeps the vite dev origins allowed', () => {
    expect(decideOrigin({ host: '127.0.0.1:4310', origin: 'http://127.0.0.1:5173' }, resolveOriginPolicy({ env: {} })))
      .toMatchObject({ allowed: true, reason: 'allowed-origin' });
    expect(decideOrigin({ host: '127.0.0.1:4310', origin: 'http://localhost:5173' }, resolveOriginPolicy({ env: {} })))
      .toMatchObject({ allowed: true, reason: 'allowed-origin' });
  });

  it('rejects a missing Host and a null Origin', () => {
    expect(decideOrigin({}, policy())).toMatchObject({ allowed: false, reason: 'missing-host' });
    expect(decideOrigin({ host: '127.0.0.1:4310', origin: 'null' }, policy()))
      .toMatchObject({ allowed: false, reason: 'origin-not-allowed' });
  });

  it('reads EXTENDO_TRUST_PROXY from the environment', () => {
    expect(resolveOriginPolicy({ env: { EXTENDO_TRUST_PROXY: '1' } }).trustProxy).toBe(true);
    expect(resolveOriginPolicy({ env: { EXTENDO_TRUST_PROXY: 'true' } }).trustProxy).toBe(true);
    expect(resolveOriginPolicy({ env: { EXTENDO_TRUST_PROXY: '0' } }).trustProxy).toBe(false);
    expect(resolveOriginPolicy({ env: {} }).trustProxy).toBe(false);
  });

  it('drops malformed entries from the allowlist', () => {
    const resolved = resolveOriginPolicy({ devOrigins: [], env: { EXTENDO_ALLOWED_ORIGINS: 'not a url, https://ok.example/path' } });
    expect(resolved.allowedOrigins).toEqual([]);
  });
});
