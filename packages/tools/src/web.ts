import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

const privateIPs = new BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) privateIPs.addSubnet(prefix, bits, 'ipv4');
for (const [prefix, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) privateIPs.addSubnet(prefix, bits, 'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

export async function fetchPublicText(input: string, turnSignal: AbortSignal) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new Error('Expected an HTTP(S) URL without credentials or a custom port');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const ipVersion = isIP(hostname);
  const signal = AbortSignal.any([turnSignal, AbortSignal.timeout(12_000)]);
  signal.throwIfAborted();
  const addresses = ipVersion ? [{ address: hostname, family: ipVersion }] : await lookup(hostname, { all: true });
  signal.throwIfAborted();
  const target = addresses[0];
  if (!target || addresses.some(({ address, family }) =>
    family === 4 ? privateIPs.check(address, 'ipv4') : !globalV6.check(address, 'ipv6') || privateIPs.check(address, 'ipv6'),
  )) throw new Error('Web fetch only accepts public IP addresses');

  return new Promise<{ url: string; status: number; contentType: string; text: string; truncated: boolean }>((resolve, reject) => {
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = transport(url, {
      signal,
      family: target.family,
      lookup: (_host, _options, callback) => callback(null, target.address, target.family),
      headers: { accept: 'text/*, application/json, application/xml', 'user-agent': 'Extendo/0.1' },
      agent: false,
    }, (res) => {
      const status = res.statusCode ?? 0;
      const contentType = (res.headers['content-type'] ?? '').toLowerCase();
      res.on('error', reject);
      if (status < 200 || status >= 300) {
        res.destroy();
        reject(new Error(`Web fetch returned HTTP ${status}; redirects are not followed`));
        return;
      }
      if (!/^(?:text\/|application\/(?:[\w.-]+\+)?(?:json|xml)(?:[;\s]|$))/.test(contentType)) {
        res.destroy();
        reject(new Error('The response is not a supported text format'));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      const finish = (truncated: boolean) => resolve({ url: url.href, status, contentType, text: Buffer.concat(chunks).toString('utf8'), truncated });
      res.on('data', (chunk: Buffer) => {
        const limit = 48_000 - bytes;
        const piece = chunk.subarray(0, limit);
        chunks.push(piece);
        bytes += piece.length;
        if (chunk.length > limit) {
          finish(true);
          res.destroy();
        }
      });
      res.once('end', () => finish(false));
    });
    req.once('error', reject);
    req.end();
  });
}
