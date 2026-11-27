import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it as test } from 'vitest';
import { ExtensionCatalogStore } from '@varin/extension-host';
import { pairResourceNode, revokeResourceNodeClient, startResourceNode } from '../../resource-node.js';
import { toolOperationId } from './protocol.generated.js';
import type { ThreadPreparedSource } from '@varin/application-client';
import type { ManagedRemoteIdentity, ManagedSourceBinding, ManagedSourceReceipt, ManagedSourceResolveReceipt } from '../harness/managed-remote-types.js';
import { createSocketResourceProvider } from '../deployment/resource-provider.js';
import { createManagedRemoteTargetRegistry } from '../harness/managed-remote-client.js';

const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? fileURLToPath(new URL(
  '../../../../../kernel/target/release/' + (process.platform === 'win32' ? 'varin-kernel.exe' : 'varin-kernel'), import.meta.url));
const available = await fs.stat(kernelPath).then(() => true, () => false);
if (!available && process.env.VARIN_REQUIRE_RELEASE_KERNEL === '1') throw new Error('Resource node acceptance requires a release kernel');
const it = test.skipIf(!available);

it('discovers a dormant provider workspace and reads it after the Resource Node address changes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-provider-'));
  const dataDir = path.join(dir, 'state'), workspaceRoot = path.join(dir, 'shared'), output = path.join(dir, 'worker.json');
  const options = { dataDir, workspaceRoot, port: 0, kernelPath };
  const socketPath = process.platform === 'win32'
    ? '\\\\.\\pipe\\varin-provider-' + randomUUID() : path.join(dir, 'provider.sock');
  const leases = new Set<string>();
  let node: Awaited<ReturnType<typeof startResourceNode>> | undefined;
  let generation = 0;
  let acquired = 0;
  let alternate: ReturnType<typeof createServer> | undefined;
  await fs.mkdir(workspaceRoot);
  await pairResourceNode({ ...options, output, write: true, commands: true });
  const { token } = JSON.parse(await fs.readFile(output, 'utf8')) as { token: string };
  const { hostId } = await new ExtensionCatalogStore(dataDir).getHostIdentity();
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== 'Bearer provider-test') { res.writeHead(401).end(); return; }
      let raw = '';
      for await (const chunk of req) raw += String(chunk);
      const input = JSON.parse(raw) as { resourceId: string; leaseId: string; generation?: string };
      if (req.url === '/v1/resources/describe') {
        res.end(JSON.stringify([{ id: 'workspace', hostId, label: 'Managed test workspace', role: 'resources', capabilities: ['sources'] }]));
      } else if (req.url === '/v1/resources/acquire') {
        acquired++;
        if (!node) { node = await startResourceNode(options); generation++; }
        leases.add(input.leaseId);
        res.end(JSON.stringify({ ...input, generation: String(generation), endpoint: 'http://127.0.0.1:' + node.port,
          bearer: token, expiresAt: Date.now() + 60_000 }));
      } else if (req.url === '/v1/resources/release') {
        if (!leases.delete(input.leaseId)) { res.writeHead(409).end(); return; }
        res.writeHead(204).end();
      } else res.writeHead(404).end();
    } catch { res.writeHead(500).end(); }
  });
  try {
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(socketPath, resolve));
    const coordinatorHostId = 'provider-coordinator';
    const registry = createManagedRemoteTargetRegistry({ coordinatorHostId, readSettings: async () => ({}),
      kernel: {} as never, resources: {} as never,
      provider: createSocketResourceProvider({ id: 'operator', socketPath, bearer: 'provider-test' }) });
    const first = (await registry.describeSourceTargets()).targets[0]!;
    expect(first.label).toBe('Managed test workspace');
    expect((await registry.sourceTargets()).targets[0]).toEqual(first);
    expect(acquired).toBe(0);
    const source = await registry.source(first.resourceOwner);
    const resolved = await source.resolve({ coordinatorHostId, path: workspaceRoot });
    const prepared = await source.prepare({ coordinatorHostId, input: {
      runtime: 'agent', threadId: 'thread:provider', branchId: 'branch:provider', key: 'prepare',
      resourceOwner: first.resourceOwner, workspaceId: resolved.workspaceId, mode: 'live_root', content: { mode: 'saved-files' }, captureScopes: [],
    } });
    const binding = await source.bind({ coordinatorHostId, source: prepared.source, scope: { kind: 'source_read',
      threadId: 'thread:provider', branchId: 'branch:provider', key: 'provider-read' }, purpose: 'read', retention: 'caller' });
    expect(leases.size).toBe(1);
    await source.release({ coordinatorHostId, authorityId: binding.authorityId, resourceEpoch: binding.resourceEpoch, mode: 'retire' });
    await expect.poll(() => leases.size).toBe(0);
    const originalPort = node!.port;
    await node!.close();
    node = undefined;
    alternate = createServer();
    await new Promise<void>((resolve, reject) => alternate!.once('error', reject).listen(originalPort, '127.0.0.1', resolve));
    const reopened = await registry.source(first.resourceOwner);
    expect((await reopened.resolve({ coordinatorHostId, path: workspaceRoot })).workspaceId).toBe(resolved.workspaceId);
    expect(node!.port).not.toBe(originalPort);
    expect((await registry.describeSourceTargets()).targets[0]?.resourceOwner).toEqual(first.resourceOwner);
    await expect(source.resolve({ coordinatorHostId, path: workspaceRoot })).rejects.toThrow('original provider instance ended');
    await expect.poll(() => leases.size).toBe(0);
  } finally {
    await node?.close();
    if (alternate) await new Promise<void>(resolve => alternate!.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it('pairs offline, serves an actual original live file and process, and reopens the same resource-only node', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-standalone-node-'));
  const workspaceRoot = path.join(dir, 'shared'), dataDir = path.join(dir, 'state');
  const options = { workspaceRoot, dataDir, port: 0, kernelPath, releaseId: 'test-artifact' };
  const creds = async (name: string, write: boolean, commands: boolean) => {
    const output = path.join(dir, name + '.json');
    await pairResourceNode({ ...options, output, write, commands });
    return JSON.parse(await fs.readFile(output, 'utf8')) as { token: string; clientId: string };
  };
  let node: Awaited<ReturnType<typeof startResourceNode>> | undefined;
  try {
    await fs.mkdir(workspaceRoot);
    await fs.writeFile(path.join(workspaceRoot, 'note.txt'), 'original node bytes');
    const reader = await creds('read', false, false), worker = await creds('work', true, true);
    node = await startResourceNode(options);
    const origin = () => 'http://127.0.0.1:' + node!.port;
    const api = (route: string, token?: string, input?: unknown) => fetch(origin() + '/api/harness/managed-execution/v1' + route, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    const accepted = async <T = unknown>(request: Promise<Response>): Promise<T> => {
      const res = await request;
      const body = await res.json();
      expect(res.status, JSON.stringify(body)).toBe(200);
      return body as T;
    };
    expect(await accepted(fetch(origin() + '/health'))).toEqual({ status: 'ok', role: 'resources', control: 'ready', releaseId: 'test-artifact' });
    expect([401, 403]).toContain((await api('/identity')).status);
    const identity = await accepted<ManagedRemoteIdentity>(api('/identity', reader.token));
    expect(identity.capabilities).toContain('sources');
    for (const absent of ['remote-shell', 'storage', 'materials', 'attachment-stream']) expect(identity.capabilities).not.toContain(absent);
    expect((await api('/shell/exec', worker.token, {})).status).toBe(404);
    expect((await fetch(origin() + '/api/threads')).status).toBe(404);
    expect(await accepted(api('/retention', worker.token))).toMatchObject({ retireReady: true });
    const coordinatorHostId = 'cloud-coordinator', threadId = 'thread:node', runId = 'run:node';
    const remote = { kind: 'managed_host', hostId: identity.hostId, connectionId: 'this-connection', endpointIdentity: 'this-endpoint' };
    const source = (name: string, token: string, body: object) => api('/sources/' + name, token, { coordinatorHostId, ...body });
    expect((await source('resolve', reader.token, { path: dataDir })).ok).toBe(false);
    const { workspaceId } = await accepted<ManagedSourceResolveReceipt>(source('resolve', reader.token, { path: workspaceRoot }));
    const prepare = async (token: string) => (await accepted<ThreadPreparedSource>(source('prepare', token, { input: {
      runtime: 'agent', threadId, branchId: 'main', key: randomUUID(), resourceOwner: remote,
      workspaceId, mode: 'live_root', content: { mode: 'saved-files' }, captureScopes: [],
    } }))).source;
    const readonly = await prepare(reader.token);
    expect(readonly.tools).toContain('file_read');
    expect(readonly.tools).not.toContain('file_write');
    expect(readonly.tools).not.toContain('process_spawn');
    const scope = { kind: 'run', threadId, runId, epoch: 1 };
    expect((await source('bind', reader.token, { source: { ...readonly, tools: ['file_write'] },
      scope, purpose: 'source', retention: 'run' })).ok).toBe(false);
    const prepared = await prepare(worker.token);
    expect(prepared.tools).toContain('process_spawn');
    expect(prepared.tools).not.toContain('code_retrieval');
    const binding = await accepted<ManagedSourceBinding>(source('bind', worker.token, {
      source: { ...prepared, tools: ['file_read', 'file_write', 'process_spawn'] }, scope, purpose: 'source', retention: 'run',
    }));
    expect(await accepted(api('/retention', worker.token))).toMatchObject({ retireReady: false, authorities: 1 });
    const address = { authorityId: binding.authorityId, resourceEpoch: binding.resourceEpoch };
    const execute = async (name: string, args: unknown) => {
      const declaration = binding.capabilities.tools.find(tool => tool.name === name);
      if (!declaration) throw new Error(`The node did not admit ${name}`);
      const callId = randomUUID(), origin = { kind: 'model_step' as const, request_id: 'request:node-native' };
      const call = { runId, callId, origin, operationId: toolOperationId(origin, callId), name, arguments: args, schemaVersion: declaration.version };
      await accepted(source('authorize', worker.token, { ...address, call }));
      return accepted<ManagedSourceReceipt>(source('execute', worker.token, { ...address, call,
        ...(name === 'file_write' || name === 'process_spawn' ? { journal: { executionId: 'execution:node-native', threadId,
          branchId: 'main', runId, entryId: 'entry:node-native', epoch: scope.epoch } } : {}),
        ...(name === 'process_spawn' && binding.executionEnvironment ? { executionEnvironment: binding.executionEnvironment } : {}),
      }));
    };
    const { result } = await execute('file_read', { path: 'note.txt' });
    expect(result).toMatchObject({ completion: { outcome: 'succeeded', content: { data: { readVersion: expect.any(String) } } } });
    const read = (result as { completion: { content: { data: { content: { text: string }; readVersion: string } } } }).completion.content.data;
    expect(read.content.text).toBe('original node bytes');
    await execute('file_write', { path: 'note.txt', readVersion: read.readVersion, content: 'updated on node' });
    expect(await fs.readFile(path.join(workspaceRoot, 'note.txt'), 'utf8')).toBe('updated on node');
    const spawned = await execute('process_spawn', { cwd: '', command: process.execPath, mode: 'pipe',
      args: ['-e', 'require("node:fs").writeFileSync("process.txt", "ran on node")'] });
    expect(spawned.accepted).toBe(true);
    await expect.poll(async () => (await accepted<ManagedSourceReceipt>(source('observe', worker.token,
      { ...address, operationId: spawned.operationId }))).executorStopped).toBe(true);
    expect(await fs.readFile(path.join(workspaceRoot, 'process.txt'), 'utf8')).toBe('ran on node');
    await accepted(source('release', worker.token, { ...address, mode: 'retire' }));
    expect(await accepted(api('/retention', worker.token))).toMatchObject({ retireReady: true });
    const terminal = (command: object) => source('terminal', worker.token, { sessionId: 'resource-node-terminal', command });
    const shell = process.platform === 'win32' ? 'cmd' : 'sh';
    expect(await accepted(terminal({ action: 'create', options: { cwd: workspaceRoot, shell } }))).toMatchObject({ status: 'running' });
    expect(await accepted(api('/retention', worker.token))).toMatchObject({ retireReady: false, activeProcess: true });
    await accepted(terminal({ action: 'write', inputId: 'terminal-effect', data: `"${process.execPath}" -e "require('node:fs').writeFileSync('pty.txt','resource-terminal')"\r` }));
    await expect.poll(() => fs.readFile(path.join(workspaceRoot, 'pty.txt'), 'utf8').catch(() => null)).toBe('resource-terminal');
    expect(await accepted(terminal({ action: 'close', force: true }))).toMatchObject({ status: 'exited' });
    await expect.poll(() => accepted(api('/retention', worker.token))).toMatchObject({ retireReady: true });
    await node.close();
    await revokeResourceNodeClient(options, worker.clientId);
    node = await startResourceNode(options);
    expect((await accepted<ManagedRemoteIdentity>(api('/identity', reader.token))).hostId).toBe(identity.hostId);
    expect((await accepted<ManagedSourceResolveReceipt>(source('resolve', reader.token, { path: workspaceRoot }))).workspaceId).toBe(workspaceId);
    expect([401, 403]).toContain((await api('/identity', worker.token)).status);
    await expect(fs.stat(path.join(dataDir, 'kernel', node.hostId, 'agent-runtime'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await node?.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 60_000);
