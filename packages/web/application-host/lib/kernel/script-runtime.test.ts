import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { SCRIPT_TOOL_DECLARATIONS } from '@varin/extension-builtins';
import { createScriptRuntime } from './script-runtime.js';
import { withToolInvocation } from './tool-invocation.js';
import type { ToolExecutionReceipt } from './tool-bridge.js';
import type { LaunchSource } from './protocol.generated.js';
import * as nodeBinding from './script-node-binding.js';

const physical: LaunchSource = { resource_owner: { kind: 'local' }, mode: 'live_root',
  live_root: { hostId: 'fixture', rootId: 'fixture-root', canonicalRoot: '/fixture' },
  branch_id: null, revision: null, environment_run_id: null, workspace_id: 'workspace', execution_workspace_id: 'workspace' };
const node = { executable: '/fixture/node', worker_path: '/fixture/worker.js',
  worker_identity: 'fixture-worker', configuration_identity: 'fixture-node' };


test('an invalid script cwd reports no dispatch before opening an environment', async () => {
  const owner = { extensionId: 'varin.builtin.scripts', extensionVersion: '1.0.0', entrypointId: 'host', instanceKey: 'script-test', generation: 1 };
  const signal = new AbortController().signal;
  const scripts = createScriptRuntime({ kernel: { agentRuntimeRequest() { throw new Error('Unexpected process admission'); } } as never,
    runtime: { onEvent: () => () => {}, onReady: () => () => {} } as never,
    resolveLiveSource: async () => {}, onError: error => { throw error; } });
  const input = { cwd: 'D:\\project\\opencr' };
  let receipt: ToolExecutionReceipt | undefined;
  try {
    await assert.rejects(withToolInvocation({ owner, signal, onEffectReceipt: value => { receipt = value; }, authority: {
      invocationId: 'invalid', operationId: 'request:tool:invalid', callId: 'invalid', runId: 'run', threadId: 'thread',
      executorOwner: { kind: 'kernel' }, origin: { kind: 'model_step', request_id: 'request' }, source: null,
      toolName: 'script_open', operation: 'effect', completion: 'job', configurationIdentity: null, arguments: input,
    } }, async invocation => scripts.capability('open', input, { owner, signal, invocation })), /tool_domain_result_unavailable/);
    assert.equal(receipt?.completion.kind, 'not_dispatched');
    assert.equal(receipt?.executor_stopped, true);
  } finally { await scripts.dispose(); }
});

test('a new script reaches its own admission while an old environment is still draining', async () => {
  let release!: () => void;
  const draining = new Promise<void>(resolve => { release = resolve; });
  let beginNew!: () => void;
  const newAdmission = new Promise<void>(resolve => { beginNew = resolve; });
  const old = { id: 'old-environment', managed_process: { purpose: { kind: 'script_environment' } },
    execution_owner: { kind: 'external', identity: 'old', epoch: 'old' } };
  const kernel = {
    kernelEpoch: 'current',
    async agentRuntimeRequest(method: string) {
      if (method === 'runtime.managed_process.pending') return [old];
      assert.equal(method, 'runtime.managed_process.begin'); beginNew();
      throw new Error('Fixture stopped at process admission');
    },
  };
  const runtime = {
    onEvent: () => () => {}, onReady: () => () => {},
    cancelOperation: () => draining,
    launch: async (id: string) => id === 'new-run' ? { selection: { source: physical } } : null,
  };
  const scripts = createScriptRuntime({ kernel: kernel as never, runtime: runtime as never,
    resolveLiveSource: async () => {}, onError: error => { throw error; } });
  const declaration = SCRIPT_TOOL_DECLARATIONS.find(value => value.tool?.name === 'script_open')!;
  const owner = { extensionId: 'varin.builtin.scripts', extensionVersion: '1.0.0', entrypointId: 'host', instanceKey: 'script-test', generation: 1 };
  const signal = new AbortController().signal;
  let call: Promise<unknown> | undefined;
  const current = vi.spyOn(nodeBinding, 'resolveScriptNodeBinding').mockResolvedValue(node);
  const saved = vi.spyOn(nodeBinding, 'restoreScriptNodeBinding').mockResolvedValue(node);
  try {
    const configurationIdentity = (await scripts.prepareConfiguration(() => null, physical))(declaration);
    call = withToolInvocation({ owner, signal, authority: {
      invocationId: 'new', operationId: 'request:tool:new', callId: 'new', runId: 'new-run', threadId: 'new-thread',
      executorOwner: { kind: 'kernel' }, origin: { kind: 'model_step', request_id: 'request' }, source: physical,
      toolName: 'script_open', operation: 'effect', completion: 'job', configurationIdentity, arguments: {},
    } }, async invocation => scripts.capability('open', {}, { owner, signal, invocation }));
    // This is before the old cancellation resolves. The new source admission is
    // intentionally absent; real evaluator/process behavior has its own Rust fixture.
    await newAdmission;
    assert.deepEqual(await call, { error: 'Fixture stopped at process admission' });
  } finally { current.mockRestore(); saved.mockRestore(); release(); await call; await scripts.dispose(); }
});

test('script admission fences a mismatched frozen source before any evaluator or grant', async () => {
  const probe = vi.spyOn(nodeBinding, 'restoreScriptNodeBinding');
  const kernel = { agentRuntimeRequest: vi.fn() };
  const selected = { ...physical, execution_workspace_id: 'other-workspace' };
  const scripts = createScriptRuntime({ kernel: kernel as never,
    runtime: { launch: async () => ({ selection: { source: selected } }), onEvent: () => () => {}, onReady: () => () => {} } as never,
    resolveLiveSource: async () => { throw new Error('Unexpected resource preparation'); }, onError: error => { throw error; } });
  const owner = { extensionId: 'varin.builtin.scripts', extensionVersion: '1.0.0', entrypointId: 'host', instanceKey: 'script-test', generation: 1 };
  const signal = new AbortController().signal;
  let receipt: ToolExecutionReceipt | undefined;
  try {
    await assert.rejects(withToolInvocation({ owner, signal, onEffectReceipt: value => { receipt = value; }, authority: {
      invocationId: 'stale', operationId: 'request:tool:stale', callId: 'stale', runId: 'run', threadId: 'thread',
      executorOwner: { kind: 'kernel' }, origin: { kind: 'model_step', request_id: 'request' }, source: physical,
      toolName: 'script_open', operation: 'effect', completion: 'job', configurationIdentity: node.configuration_identity, arguments: {},
    } }, async invocation => scripts.capability('open', {}, { owner, signal, invocation })), /tool_domain_result_unavailable/);
    assert.equal(receipt?.completion.kind, 'not_dispatched');
    assert.equal(probe.mock.calls.length, 0);
    assert.equal(kernel.agentRuntimeRequest.mock.calls.length, 0);
  } finally { probe.mockRestore(); await scripts.dispose(); }
});

test('does not rebind or respawn after its original physical open may have executed', async () => {
  const restore = vi.spyOn(nodeBinding, 'restoreScriptNodeBinding').mockResolvedValue(node);
  const processSpawn = vi.fn(async () => { throw new Error('Original process reply lost'); });
  const root = physical.live_root!;
  const kernel = {
    agentRuntimeRequest: vi.fn(async () => ({})),
    issueGrant: vi.fn(async () => ({ grantId: 'fixture-grant' })),
    retireGrant: vi.fn(),
    scoped: () => ({ fileRootRegister: async () => root, processSpawn }),
  };
  const cancelOperation = vi.fn(async () => ({}));
  const runtime = {
    launch: async () => ({ selection: { source: physical, tools: [], extension_bindings: [] } }),
    run: async () => ({ id: 'run', thread_id: 'thread', state: 'executing' }),
    operation: async () => ({ run_id: 'run', managed_process: { purpose: { kind: 'script_environment' } },
      lifetime: 'environment', phase: 'running', execution_owner: { kind: 'external', identity: 'host', epoch: 'epoch' } }),
    executionEnvironment: async () => ({}),
    cancelOperation, onEvent: () => () => {}, onReady: () => () => {},
  };
  const scripts = createScriptRuntime({ kernel: kernel as never, runtime: runtime as never,
    resolveLiveSource: async () => {}, onError: error => { throw error; } });
  const owner = { extensionId: 'varin.builtin.scripts', extensionVersion: '1.0.0', entrypointId: 'host', instanceKey: 'script-test', generation: 1 };
  const signal = new AbortController().signal;
  const receipts: ToolExecutionReceipt[] = [];
  const invoke = () => withToolInvocation({ owner, signal, onEffectReceipt: receipt => { receipts.push(receipt); }, authority: {
    invocationId: 'unknown', operationId: 'request:tool:unknown', callId: 'unknown', runId: 'run', threadId: 'thread',
    executorOwner: { kind: 'external', identity: 'host', epoch: 'epoch' }, origin: { kind: 'model_step', request_id: 'request' }, source: physical,
    toolName: 'script_open', operation: 'effect', completion: 'job', configurationIdentity: node.configuration_identity, arguments: {},
  } }, async invocation => scripts.capability('open', {}, { owner, signal, invocation }));
  try {
    await invoke();
    await invoke();
    assert.equal(processSpawn.mock.calls.length, 1);
    assert.equal(restore.mock.calls.length, 1);
    assert.equal(kernel.issueGrant.mock.calls.length, 1);
    assert.equal(kernel.retireGrant.mock.calls.length, 0);
    assert.deepEqual(cancelOperation.mock.calls, [['request:tool:unknown']]);
    assert.equal(receipts.length, 2);
    for (const receipt of receipts) {
      assert.equal(receipt.executor_stopped, false);
      assert.equal(receipt.completion.kind, 'result');
      assert.equal(receipt.completion.effect, 'unknown');
    }
  } finally { restore.mockRestore(); await scripts.dispose(); }
});
