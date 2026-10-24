// Trusted forward proxy in the VM supervisor. Never loaded into the check container.
import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';

export function matches(pattern, host, port) {
  const [name, explicitPort] = pattern.split(':');
  return (
    (!explicitPort || +explicitPort === port) &&
    (name.startsWith('*.') ? host.endsWith(name.slice(1)) && host !== name.slice(2) : host === name)
  );
}
export function permitted(policy, host, port) {
  // A final DNS root dot names the same host; it must not bypass deny rules.
  host = host.replace(/\.$/, '');
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    host !== host.toLowerCase() ||
    !/^[a-z0-9.-]+$/.test(host) ||
    net.isIP(host)
  )
    return false;
  if (
    ['localhost', 'docker.internal', 'metadata.google.internal'].some(
      (name) => host === name || host.endsWith('.' + name),
    )
  )
    return false;
  if ((policy.deny ?? []).some((pattern) => matches(pattern, host, port))) return false;
  return (
    policy.network === 'open' ||
    (policy.network === 'allowlist' &&
      (policy.allow ?? []).some((pattern) => matches(pattern, host, port)))
  );
}
export function publicIPv4(ip) {
  if (net.isIP(ip) !== 4) return false;
  const [a, b, c] = ip.split('.').map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}
export async function startProxy(policy, upstreamAddress, resolve = lookup) {
  const upstream = new URL(upstreamAddress);
  if (upstream.protocol !== 'http:' || upstream.username || upstream.password)
    throw new Error('Unsupported sbx upstream proxy');
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    socket.setTimeout(60000, () => socket.destroy());
    return socket;
  };
  const authorize = async (host, port) => {
    if (!permitted(policy, host, port)) throw new Error('Proxy denied');
    // Upstream sbx resolves again and enforces its policy. This check also rejects local names.
    const addresses = await resolve(host, { family: 4, all: true });
    if (!addresses.length || addresses.some(({ address }) => !publicIPv4(address)))
      throw new Error('Proxy denied private destination');
  };
  const server = http.createServer(async (req, res) => {
    let outgoing;
    try {
      const target = new URL(req.url);
      if (target.protocol !== 'http:' || target.username || target.password)
        throw new Error('Proxy denied');
      await authorize(target.hostname, +(target.port || 80));
      const headers = { ...req.headers, host: target.host };
      for (const field of [
        'proxy-authorization',
        'proxy-connection',
        'connection',
        'upgrade',
        ...String(headers.connection ?? '')
          .split(',')
          .map((x) => x.trim().toLowerCase()),
      ])
        delete headers[field];
      outgoing = http.request(
        {
          hostname: upstream.hostname,
          port: upstream.port || 80,
          path: target.href,
          method: req.method,
          headers,
          timeout: 30000,
        },
        (incoming) => {
          res.writeHead(incoming.statusCode ?? 502, incoming.headers);
          incoming.pipe(res);
        },
      );
      outgoing.on('socket', track);
      outgoing.on('timeout', () => outgoing.destroy());
      outgoing.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end('Upstream connection failed');
      });
      req.on('aborted', () => outgoing.destroy());
      res.on('close', () => outgoing.destroy());
      req.pipe(outgoing);
    } catch {
      res.writeHead(403);
      res.end('Proxy denied');
    }
  });
  server.on('connection', track);
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('connect', async (req, client, head) => {
    try {
      const match = /^([a-z0-9.-]+):([0-9]{1,5})$/.exec(req.url);
      if (!match) throw new Error('Proxy denied');
      await authorize(match[1], +match[2]);
      const outgoing = http.request({
        hostname: upstream.hostname,
        port: upstream.port || 80,
        method: 'CONNECT',
        path: req.url,
        headers: { host: req.url },
        timeout: 30000,
      });
      outgoing.on('socket', track);
      outgoing.on('timeout', () => outgoing.destroy());
      outgoing.on('error', () => client.destroy());
      client.on('close', () => outgoing.destroy());
      outgoing.on('connect', (response, remote, upstreamHead) => {
        track(remote);
        if (response.statusCode !== 200) {
          client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
          remote.destroy();
          return;
        }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) remote.write(head);
        if (upstreamHead.length) client.write(upstreamHead);
        client.pipe(remote);
        remote.pipe(client);
        remote.on('close', () => client.destroy());
        client.on('close', () => remote.destroy());
      });
      outgoing.end();
    } catch {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    }
  });
  server.maxConnections = 64;
  server.requestTimeout = 60000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', resolve);
  });
  return {
    port: server.address().port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
