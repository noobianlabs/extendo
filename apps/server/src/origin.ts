/**
 * Decides whether an HTTP request or WebSocket upgrade may reach the Extendo server.
 *
 * Extendo listens on loopback and is meant to be reached either directly or through a
 * reverse proxy. The decision is the same for both transports, so the HTTP guard and the
 * `/ws` upgrade guard cannot drift apart.
 */

export type OriginReason =
  | 'no-origin'
  | 'host-match'
  | 'allowed-origin'
  | 'missing-host'
  | 'host-not-loopback'
  | 'origin-not-allowed';

export interface OriginPolicy {
  devOrigins: string[];
  allowedOrigins: string[];
  trustProxy: boolean;
}

export interface OriginDecision {
  allowed: boolean;
  reason: OriginReason;
  host: string;
  origin: string;
  forwardedHost: string;
}

export interface OriginPolicyOptions {
  devOrigins?: string[];
  allowedOrigins?: string[];
  trustProxy?: boolean;
  env?: NodeJS.ProcessEnv;
}

export type RequestHeaders = Record<string, string | string[] | undefined>;

export const devOrigins = ['http://127.0.0.1:5173', 'http://localhost:5173'];

const loopback = /^(?:localhost|127\.0\.0\.1|::1)$/i;

function header(headers: RequestHeaders, name: string): string {
  const value = headers[name];
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(',')[0]?.trim() ?? '';
}

function flag(value: string | undefined): boolean {
  return /^(?:1|true|yes|on)$/i.test(value?.trim() ?? '');
}

export function normalizeOrigin(origin: string): string | null {
  const trimmed = origin.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.pathname !== '/' || url.search || url.hash) return null;
    return trimmed.toLowerCase();
  } catch {
    return null;
  }
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map(normalizeOrigin).filter((origin): origin is string => origin !== null);
}

function unique(origins: string[]): string[] {
  return [...new Set(origins)];
}

function normalizeList(origins: string[]): string[] {
  return unique(origins.map(normalizeOrigin).filter((origin): origin is string => origin !== null));
}

export function resolveOriginPolicy(options: OriginPolicyOptions = {}): OriginPolicy {
  const env = options.env ?? process.env;
  return {
    devOrigins: normalizeList(options.devOrigins ?? devOrigins),
    allowedOrigins: normalizeList([...splitList(env.EXTENDO_ALLOWED_ORIGINS), ...(options.allowedOrigins ?? [])]),
    trustProxy: options.trustProxy ?? flag(env.EXTENDO_TRUST_PROXY),
  };
}

export function isAllowedOrigin(origin: string, policy: OriginPolicy): boolean {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  return policy.allowedOrigins.includes(normalized) || policy.devOrigins.includes(normalized);
}

function splitHost(host: string): { hostname: string; port: string } | null {
  const trimmed = host.trim().toLowerCase();
  if (!trimmed) return null;
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(trimmed);
  if (bracketed) return { hostname: bracketed[1]!, port: bracketed[2] ?? '' };
  const colon = trimmed.lastIndexOf(':');
  if (colon === -1) return { hostname: trimmed, port: '' };
  const port = trimmed.slice(colon + 1);
  if (!/^\d{1,5}$/.test(port)) return { hostname: trimmed, port: '' };
  return { hostname: trimmed.slice(0, colon), port };
}

function sameHost(origin: string, host: string, forwardedProto: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const target = splitHost(host);
  if (!target) return false;
  const originHostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (originHostname !== target.hostname) return false;
  const proto = forwardedProto.toLowerCase();
  const targetPort = target.port || (proto === 'https' ? '443' : proto === 'http' ? '80' : '');
  if (!targetPort) return true;
  const originPort = url.port || (url.protocol === 'https:' ? '443' : '80');
  return originPort === targetPort;
}

/**
 * A request is trusted when it targets loopback, or when the operator opted into
 * `EXTENDO_TRUST_PROXY` and the proxy supplied a forwarded host. Forwarded headers are
 * ignored entirely when that opt-in is off, so a loopback-only server cannot be spoofed.
 */
export function decideOrigin(headers: RequestHeaders, policy: OriginPolicy): OriginDecision {
  const host = header(headers, 'host');
  const origin = header(headers, 'origin');
  const forwardedHost = header(headers, 'x-forwarded-host');
  const forwardedProto = header(headers, 'x-forwarded-proto');
  const proxied = policy.trustProxy && forwardedHost.length > 0;
  const effectiveHost = proxied ? forwardedHost : host;
  const decision = (allowed: boolean, reason: OriginReason): OriginDecision => ({
    allowed, reason, host: effectiveHost, origin, forwardedHost,
  });

  if (!effectiveHost) return decision(false, 'missing-host');
  const target = splitHost(effectiveHost);
  if (!proxied && !(target && loopback.test(target.hostname))) return decision(false, 'host-not-loopback');
  if (!origin) return decision(true, 'no-origin');
  if (sameHost(origin, effectiveHost, forwardedProto)) return decision(true, 'host-match');
  if (isAllowedOrigin(origin, policy)) return decision(true, 'allowed-origin');
  return decision(false, 'origin-not-allowed');
}

export function describeOrigin(decision: OriginDecision): string {
  return `host=${decision.host || '(none)'} origin=${decision.origin || '(none)'} forwarded-host=${decision.forwardedHost || '(none)'} reason=${decision.reason}`;
}
