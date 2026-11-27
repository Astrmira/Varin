import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { startContainerResourceProvider } from './container-provider.js';
import { createSocketResourceProvider } from './resource-provider.js';

it('starts only on acquire and retires the original generation after the last lease and detach', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'varin-provider-helper-'));
  const socketPath = process.platform === 'win32' ? '\\\\.\\pipe\\varin-provider-' + randomUUID() : path.join(root, 'control.sock');
  const workspace = path.join(root, 'workspaces'), state = path.join(root, 'state');
  const controlFile = path.join(root, 'control.json'), nodeFile = path.join(root, 'node.json'), file = path.join(root, 'provider.json');
  const hostId = 'resource-host';
  let nodeReadyToRetire = false;
  const node = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer original-node-token') { res.writeHead(401).end(); return; }
    res.setHeader('x-varin-managed-host', hostId);
    if (req.url?.endsWith('/retention')) { res.end(JSON.stringify({ retireReady: nodeReadyToRetire })); return; }
    res.end(JSON.stringify({ hostId, role: 'resources', requestHostIdentity: true }));
  });
  await new Promise<void>(resolve => node.listen(0, '127.0.0.1', resolve));
  const port = (node.address() as { port: number }).port;
  await Promise.all([mkdir(workspace), mkdir(state), writeFile(controlFile, '{"token":"control-token"}'),
    writeFile(nodeFile, '{"token":"original-node-token"}')]);
  await writeFile(file, JSON.stringify({ version: 1, id: 'local', socketPath, credentialFile: controlFile,
    leaseDurationMs: 60_000, startupTimeoutMs: 10_000, idleRetentionMs: 500,
    resources: [{ id: 'work', hostId, label: 'Local work', workspace, state, credentialFile: nodeFile, image: 'varin-node:fixture' }],
  }));

  let instance: { Id: string; State: { Running: boolean; StartedAt: string }; Config: { Labels: Record<string, string> };
    NetworkSettings: { Ports: { '3000/tcp': Array<{ HostIp: string; HostPort: string }> } } } | undefined;
  let containerName: string | undefined;
  const operations: string[] = [];
  let failDetach = true;
  const helper = await startContainerResourceProvider(file, async (engine, args) => {
    expect(engine).toBe('docker');
    const [operation, ...rest] = args;
    operations.push(operation!);
    if (operation === 'ps') return instance ? containerName! : '';
    if (operation === 'inspect') return JSON.stringify([instance]);
    if (operation === 'create') {
      expect(instance).toBeUndefined();
      containerName = rest[rest.indexOf('--name') + 1]!;
      const [label, value] = rest[rest.indexOf('--label') + 1]!.split('=');
      instance = { Id: randomUUID(), State: { Running: false, StartedAt: new Date().toISOString() },
        Config: { Labels: { [label!]: value! } }, NetworkSettings: { Ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: String(port) }] } } };
      return instance.Id;
    }
    if (operation === 'start') { instance!.State.Running = true; return ''; }
    if (operation === 'stop') { instance!.State.Running = false; return ''; }
    if (operation === 'rm') {
      expect(instance!.State.Running).toBe(false);
      if (failDetach) throw new Error('Volume held');
      instance = undefined;
      return '';
    }
    throw new Error('Unexpected test engine command');
  });
  const provider = createSocketResourceProvider({ id: 'local', socketPath, bearer: 'control-token' });
  const use = (leaseId: string) => provider.acquire({ resourceId: 'work', leaseId });
  try {
    expect((await provider.describe()).map(resource => resource.id)).toEqual(['work']);
    expect(await provider.status('work')).toMatchObject({ state: 'cold' });
    expect(operations).toEqual([]);
    const [first, second] = await Promise.all([use('one'), use('two')]);
    expect(first.generation).toBe(second.generation);
    expect(operations.filter(operation => operation === 'create')).toHaveLength(1);
    const endpoint = first.endpoint + '/api/harness/managed-execution/v1/identity';
    const identity = (bearer: string) => fetch(endpoint, { headers: { authorization: 'Bearer ' + bearer } });
    expect((await identity('original-node-token')).status).toBe(401);
    expect((await identity(first.bearer)).status).toBe(200);
    const claim = (lease: typeof first) => ({ resourceId: lease.resourceId, leaseId: lease.leaseId, generation: lease.generation });
    expect(await provider.renew(claim(first))).toMatchObject(claim(first));
    await expect(provider.retire('work', first.generation)).rejects.toThrow('409');
    await provider.release(claim(first));
    expect((await identity(first.bearer)).status).toBe(401);
    expect(await provider.status('work')).toMatchObject({ state: 'ready' });
    await provider.release(claim(second));
    await expect(provider.retire('work', first.generation)).rejects.toThrow('409');
    expect(operations).not.toContain('stop');
    nodeReadyToRetire = true;
    await expect(provider.retire('work', first.generation)).rejects.toThrow('503');
    expect(await provider.status('work')).toMatchObject({ state: 'unavailable', generation: first.generation });
    failDetach = false;
    expect(await provider.retire('work', first.generation)).toMatchObject({ processExited: true, volumeDetached: true });
    const replacement = await use('replacement');
    expect(replacement.generation).not.toBe(first.generation);
    await provider.release(claim(replacement));
    await expect.poll(async () => (await provider.status('work')).state).toBe('cold');
  } finally {
    await helper.close();
    await new Promise<void>(resolve => node.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
