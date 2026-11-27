import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { isAllowedObservationRequest, OBSERVATION_WEBSOCKET_PATH } from '@varin/application-client';
import { waitWithSignal } from '../cancellation.js';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { attachmentUploadIdentity } from '../kernel/attachment-upload-identity.js';
import { InboxError, type InboxCommand, type SupervisorUserInbox } from './user-inbox.js';
import { rejectedInboxDraft } from './user-inbox-auth.js';
import { inboxMethod, INBOX_ACTOR_HEADER, INBOX_RECONCILE_PATH, INBOX_REPLAY_HEADER, INBOX_REQUEST_BYTES, INBOX_STATUS_PATH,
  type InboxActor, type InboxResult } from './user-inbox-wire.js';

interface DurableIngress {
  inbox: SupervisorUserInbox;
  authenticate(authorization: string | undefined): Promise<InboxActor | null>;
}
const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, {
  'Content-Type': 'application/json', 'Cache-Control': 'no-store',
}).end(JSON.stringify(body));
const contentType = (command: Pick<InboxCommand, 'method'>) => command.method === 'attachments/upload' ? 'application/octet-stream' : 'application/json';

async function bufferRequest(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > INBOX_REQUEST_BYTES) throw new InboxError(413, 'http-body-too-large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

function decodeCommand(actor: InboxActor, method: InboxCommand['method'], url: URL, body: Buffer) {
  const required = (value: unknown) => {
    if (typeof value !== 'string' || !value.length) throw new InboxError(400, 'invalid-inbox-input');
    return value;
  };
  const input = method === 'attachments/upload' ? Object.fromEntries(url.searchParams) : JSON.parse(body.toString('utf8')) as Record<string, unknown>;
  if (!input || input.runtime !== 'agent') throw new InboxError(400, 'invalid-inbox-input');
  const threadId = required(input.threadId);
  const branchId = required(input.branchId);
  const key = method === 'materials/upload' ? createHash('sha256').update(body).digest('hex') : required(input.key);
  let upload;
  if (method === 'attachments/upload') {
    if (Number(input.byteLength) !== body.length) throw new InboxError(400, 'invalid-attachment-length');
    upload = attachmentUploadIdentity(threadId, { byteLength: body.length, key, filename: required(input.filename), mimeType: String(input.mimeType ?? '') });
  }
  return { command: { actor, method, url: url.pathname + url.search, threadId, branchId, key, body }, upload,
    queueable: method !== 'enqueue' || input.mode !== 'interrupt' };
}

const replayHeaders = (launchId: string, entry: InboxActor) => ({
  [INBOX_REPLAY_HEADER]: launchId, [INBOX_ACTOR_HEADER]: JSON.stringify({ principalId: entry.principalId, clientId: entry.clientId }),
  'Content-Type': 'application/json',
});

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
export async function openSupervisorGateway(port: number, durable?: DurableIngress) {
  let target: number | undefined;
  let active = 0;
  let lastTraffic = performance.now();
  let waiters = notification();
  let settled = notification();
  let demand = notification();
  let drainingInbox = false;
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
  const signalDemand = () => { demand.resolve(); };
  const dispatchBuffered = async (req: IncomingMessage, res: ServerResponse, signal: AbortSignal, body: Buffer) => {
    await prepare(req, signal);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || ['host', 'connection', 'transfer-encoding', 'content-length', 'expect'].includes(name)) continue;
      for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
    }
    const response = await fetch(targets.get(req)! + req.url, {
      method: 'POST', body: new Uint8Array(body), redirect: 'manual', signal, headers,
    });
    return response;
  };
  const forwardBufferedResponse = async (res: ServerResponse, response: Response) => {
    for (const [name, value] of response.headers) {
      if (!['content-length', 'content-encoding', 'connection', 'transfer-encoding', 'set-cookie'].includes(name)) res.setHeader(name, value);
    }
    if (response.headers.getSetCookie().length) res.setHeader('Set-Cookie', response.headers.getSetCookie());
    res.writeHead(response.status);
    if (response.body) await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), res);
    else res.end();
  };
  const ingress = async (req: IncomingMessage, res: ServerResponse, signal: AbortSignal, url: URL) => {
    const actor = await durable!.authenticate(req.headers.authorization);
    if (!actor) {
      if (url.pathname === INBOX_STATUS_PATH) json(res, 401, { code: 'unauthorized' });
      else if (await prepare(req, signal)) await proxy(req, res);
      return;
    }
    if (url.pathname === INBOX_STATUS_PATH) {
      const id = url.searchParams.get('inboxId') ?? '';
      const until = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
      let result = durable!.inbox.status(actor.principalId, id);
      while (result === null && !until.aborted) {
        await waitWithSignal(settled.promise, until).catch(error => { if (!until.aborted) throw error; });
        if (!signal.aborted) result = durable!.inbox.status(actor.principalId, id);
      }
      if (signal.aborted) return;
      json(res, result === undefined ? 404 : 200, result === undefined ? { code: 'inbox-input-not-found' } : { result });
      return;
    }
    const method = inboxMethod(url.pathname)!;
    const raw = await bufferRequest(req);
    const { command, upload, queueable } = decodeCommand(actor, method, url, raw);
    let receipt;
    if (queueable) receipt = !target && !drainingInbox ? durable!.inbox.accept(command) : durable!.inbox.find(command);
    if (!receipt) {
      const response = await dispatchBuffered(req, res, signal, raw).catch(() => undefined);
      if (!response) { if (!signal.aborted) json(res, 502, { code: 'thread-forwarding-interrupted' }); return; }
      const unavailable = response.status === 503 ? await response.clone().json().catch(() => null) as { code?: string } | null : null;
      if (queueable && !target && !drainingInbox && ['host-parking', 'host-draining'].includes(unavailable?.code ?? '')) {
        await response.body?.cancel();
        receipt = durable!.inbox.accept(command);
      } else { await forwardBufferedResponse(res, response); return; }
    }
    signalDemand();
    if (upload) { json(res, 202, upload); return; }
    json(res, 202, receipt);
  };
  const server = createServer((req, res) => {
    // This authority exists only between the supervisor and its own child.
    delete req.headers[INBOX_REPLAY_HEADER];
    delete req.headers[INBOX_ACTOR_HEADER];
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://localhost'); }
    catch { json(res, 400, { code: 'invalid-request-target' }); return; }
    const method = req.method === 'POST' ? inboxMethod(url.pathname) : undefined;
    const cold = !target && !drainingInbox;
    const stagedUpload = method === 'attachments/upload' && Number(url.searchParams.get('byteLength')) <= INBOX_REQUEST_BYTES;
    if (durable && (req.method === 'GET' && url.pathname === INBOX_STATUS_PATH || method &&
      (!req.headers['content-encoding'] || req.headers['content-encoding'] === 'identity') &&
      (method === 'submit' || method === 'enqueue' || cold && (stagedUpload || method === 'materials/upload')) &&
      req.headers['content-type']?.split(';')[0] === contentType({ method }))) {
      const isStatus = url.pathname === INBOX_STATUS_PATH;
      const closed = new AbortController();
      if (isStatus) res.once('close', () => closed.abort());
      const signal = isStatus ? AbortSignal.any([closed.signal, stopSignal.signal]) : enter(res);
      void ingress(req, res, signal, url).catch(error => {
        if (res.destroyed || res.headersSent) { res.destroy(); return; }
        const failure = error instanceof InboxError ? error : error instanceof SyntaxError || error?.harnessCode === 'invalid-params'
          ? new InboxError(400, 'invalid-inbox-input') : new InboxError(503, 'inbox-unavailable');
        json(res, failure.status, { code: failure.code, admission: 'not_started' });
      });
      return;
    }
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
    wake: signalDemand,
    hasDemand: () => active !== 0 || (durable?.inbox.hasPending() ?? false),
    async waitForDemand(ms: number, signal: AbortSignal) {
      if (active || durable?.inbox.hasPending()) return;
      const until = AbortSignal.any([signal, AbortSignal.timeout(ms)]);
      await waitWithSignal(demand.promise, until).catch(error => { if (!until.aborted) throw error; });
    },
    quietFor: () => active ? 0 : performance.now() - lastTraffic,
    async activate(value: number, launchId: string, signal: AbortSignal) {
      if (target === value) return;
      drainingInbox = true;
      try {
        await durable?.inbox.replay(async entry => {
          const headers = replayHeaders(launchId, entry.actor);
          const origin = 'http://127.0.0.1:' + value;
          const input = entry.method === 'submit' || entry.method === 'enqueue';
          const lookup = async (result?: InboxResult) => {
            const draft = result && result.status >= 400 ? rejectedInboxDraft(JSON.parse(Buffer.from(entry.body).toString('utf8'))) : undefined;
            const response = await fetch(origin + INBOX_RECONCILE_PATH, {
              method: 'POST', headers, signal, body: JSON.stringify({ inboxId: entry.id, key: entry.key,
                threadId: entry.threadId, branchId: entry.branchId, method: entry.replayMethod,
                ...(result ? { result } : {}), ...(draft ? { draft } : {}) }),
            });
            if (!response.ok) throw new Error('The original Catalog has not reconciled inbox input');
            return await response.json() as { result?: InboxResult };
          };
          if (input) {
            const persisted = await lookup();
            if (persisted.result) return persisted.result;
          }
          let url = entry.url;
          let body = new Uint8Array(entry.body);
          if (entry.queueNext) {
            const { expectedHead: _head, model: _model, agent: _agent, source: _source, ...message } = JSON.parse(Buffer.from(body).toString('utf8'));
            body = new TextEncoder().encode(JSON.stringify({ ...message, mode: 'next_run' }));
            url = '/api/threads/enqueue';
          }
          const response = await fetch(origin + url, { method: 'POST', body, signal, redirect: 'error',
            headers: { ...headers, 'Content-Type': contentType(entry) } });
          const result = { status: response.status, body: await response.json() as { admission?: string; code?: string } | null };
          const busy = ['host-parking', 'host-draining', 'thread-forwarding-interrupted'].includes(result.body?.code ?? '');
          const ambiguous = input && result.status >= 400 && ![403, 404, 409, 413].includes(result.status)
            && result.body?.admission !== 'not_started';
          if (busy || ambiguous || result.status >= 500 && result.body?.admission !== 'not_started') {
            throw new Error('The Host has not settled the original inbox command');
          }
          if (input) {
            const acknowledged = await lookup(result);
            if (!acknowledged.result) throw new Error('Catalog inbox acknowledgement unavailable');
            return acknowledged.result;
          }
          return result;
        }, () => { settled.resolve(); settled = notification(); });
        signal.throwIfAborted();
        target = value;
        lastTraffic = performance.now();
        waiters.resolve();
        waiters = notification();
      } finally { drainingInbox = false; }
    },
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
