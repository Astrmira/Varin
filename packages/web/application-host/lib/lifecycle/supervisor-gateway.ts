import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { isAllowedObservationRequest, OBSERVATION_WEBSOCKET_PATH } from '@varin/application-client';
import { waitWithSignal } from '../cancellation.js';

function passive(request: IncomingMessage): boolean {
  const method = request.method === 'HEAD' ? 'GET' : request.method ?? 'GET';
  const pathname = (request.url ?? '').split('?', 1)[0]!;
  return (method === 'GET' && ['/live', '/health', OBSERVATION_WEBSOCKET_PATH, '/api/varin/realtime-proxy/sse'].includes(pathname)) ||
    (method === 'POST' && request.url === '/auth/url-token?observation=1') ||
    isAllowedObservationRequest(method, pathname);
}

function notification() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, resolve: release };
}

/** One loopback endpoint for the upstream gateway across Host generations.
 * App authentication remains at the Host. Waiting requests carry their
 * original headers and body and are forwarded at most once. */
export async function openSupervisorGateway(port: number) {
  let target: number | undefined;
  let active = 0;
  let lastTraffic = performance.now();
  let waiters = notification();
  let demand = notification();
  const stopSignal = new AbortController();
  const sockets = new Set<Socket>();
  const targets = new WeakMap<IncomingMessage, string>();
  const proxy = createProxyMiddleware<IncomingMessage, ServerResponse>({
    router: req => targets.get(req)!,
    on: {
      error(_error, _request, response) {
        if ('writeHead' in response && !response.headersSent) response.writeHead(502).end();
        else response.destroy();
      },
    },
  });
  const enter = (peer: ServerResponse | Socket) => {
    const signal = new AbortController();
    const release = () => {
      if (signal.signal.aborted) return;
      active--;
      if (!active) demand = notification();
      lastTraffic = performance.now();
      signal.abort();
    };
    active++;
    demand.resolve();
    peer.once('close', release);
    if ('writeHead' in peer) peer.once('finish', release);
    return AbortSignal.any([stopSignal.signal, signal.signal]);
  };
  const prepare = async (request: IncomingMessage, signal: AbortSignal) => {
    // A reconnecting background client follows the connection state but
    // supplies no demand for a cold Host.
    if (!target && passive(request)) return false;
    while (!target) await waitWithSignal(waiters.promise, signal);
    signal.throwIfAborted();
    targets.set(request, 'http://127.0.0.1:' + target);
    return true;
  };
  const server = createServer((req, res) => {
    if (!target && passive(req)) {
      const live = req.url === '/live';
      res.writeHead(live ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end(JSON.stringify(live ? { status: 'ok' } : { code: 'host-asleep' }));
      return;
    }
    const health = ['GET', 'HEAD'].includes(req.method ?? '') && /^\/(?:health|live)(?:\?|$)/u.test(req.url ?? '');
    const signal = health ? stopSignal.signal : enter(res);
    void prepare(req, signal).then(ready => {
      if (ready) return proxy(req, res);
      res.writeHead(503).end();
    }).catch(() => res.destroy());
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (req, socket: Socket, head) => {
    if (!target && passive(req)) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    const signal = enter(socket);
    void prepare(req, signal).then(ready => {
      if (ready) proxy.upgrade(req, socket, head);
      else socket.destroy();
    }).catch(() => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return {
    port: (server.address() as AddressInfo).port,
    hasDemand: () => active !== 0,
    async waitForDemand(ms: number, signal: AbortSignal) {
      if (active) return;
      const until = AbortSignal.any([signal, AbortSignal.timeout(ms)]);
      await waitWithSignal(demand.promise, until).catch(error => { if (!until.aborted) throw error; });
    },
    quietFor: () => active ? 0 : performance.now() - lastTraffic,
    setTarget(value: number | undefined) {
      if (target === value) return;
      target = value;
      if (!target && !active) demand = notification();
      if (value) lastTraffic = performance.now();
      waiters.resolve();
      waiters = notification();
    },
    async close() {
      stopSignal.abort();
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}
