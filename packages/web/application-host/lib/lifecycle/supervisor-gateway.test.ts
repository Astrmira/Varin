import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from 'vitest';
import { openSupervisorGateway } from './supervisor-gateway.js';

test('the stable gateway wakes only for foreground demand and forwards the original write once', async () => {
  const gateway = await openSupervisorGateway(0);
  const endpoint = 'http://127.0.0.1:' + gateway.port;
  const requests: unknown[] = [];
  const owner = createServer(async (req, res) => {
    let body = '';
    for await (const bytes of req) body += bytes;
    requests.push({ url: req.url, authorization: req.headers.authorization, method: req.method, body });
    res.writeHead(201).end();
  });
  try {
    await new Promise<void>(resolve => owner.listen(0, '127.0.0.1', resolve));
    const passive = await fetch(endpoint + '/api/threads/observe?cursor=2');
    expect(passive.status).toBe(503);
    await passive.body?.cancel();
    const mint = await fetch(endpoint + '/auth/url-token?observation=1', { method: 'POST' });
    expect(mint.status).toBe(503);
    await mint.body?.cancel();
    expect(gateway.hasDemand()).toBe(false);
    const pending = fetch(endpoint + '/api/threads/submit', {
      method: 'POST', body: 'first-input', headers: { Authorization: 'Bearer test-client' },
    });
    await expect.poll(() => gateway.hasDemand()).toBe(true);
    expect(requests).toEqual([]);
    gateway.setTarget((owner.address() as AddressInfo).port);
    expect((await pending).status).toBe(201);
    expect(requests).toEqual([{ url: '/api/threads/submit', authorization: 'Bearer test-client', method: 'POST', body: 'first-input' }]);
    await expect.poll(() => gateway.hasDemand()).toBe(false);
  } finally {
    await gateway.close();
    owner.closeAllConnections();
    await new Promise<void>(resolve => owner.close(() => resolve()));
  }
});
