// Private adapter for the native model's saved-location references. The Catalog
// owns the reference and Operation; this Host only borrows the original resource.
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ThreadLocationDirectory, ThreadPreparedSource, ThreadPrepareSource, ThreadSourceTarget } from '@varin/application-client';
import type { SourceResourceOwner } from '@varin/protocol';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { KernelClient } from './kernel-client.js';
import type { LaunchSource, Run, SourceToolBinding } from './protocol.generated.js';
import { SourceAdmissionError, sourceFailureCode } from './source-admission-error.js';
import { resolveSourceTextPolicy } from './source-provenance.js';
import { resourceSource } from './thread-context.js';
import type { SourceDirectory } from './thread-sources.js';
import { sourceToolSchemas } from './source-launch.js';
import { workLocationCapabilities } from './work-location-capabilities.js';
import { normalizeWorkspaceRelativePath } from '../workspace/path-safety.js';
import { resourceSections } from '../agent-resources/render.js';
import type { PreparedAgentResources } from '../agent-resources/authority.js';
import type { createResourceFileTransfer } from '../workspace/resource-file-routes.js';

const denied = () => new SourceAdmissionError('source_authority_denied');
const changed = () => new SourceAdmissionError('source_changed');
const unavailable = () => new SourceAdmissionError('source_unavailable');
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();

type Row = Extract<ThreadLocationDirectory['locations'][number], { resourceOwner: SourceResourceOwner }>;
interface LocationKey { id?: string; path: string; workspaceId: string; resourceOwner: SourceResourceOwner }
interface Lease { binding: SourceToolBinding; operationId: string; release(): Promise<void> }
type Runtime = Pick<AgentRuntimeClient, 'run' | 'thread' | 'launch' | 'operation' | 'managedSource' | 'coordinatorHostId' | 'principalCanUseHostResources'>;
export type ModelWorkLocationOwner = (query: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;

/** Use the already authorized resource snapshot, not a second path reader.
 * The token changes when the instructions or owning selection change, and
 * the failed preparation includes precisely the instructions for reissue. */
export function workLocationContext(snapshot: PreparedAgentResources, source: LaunchSource) {
  const instructions = snapshot.instructions.filter(entry => entry.origin !== 'user');
  const system = snapshot.system?.origin !== 'user' ? snapshot.system : null;
  const appendSystem = snapshot.appendSystem?.origin !== 'user' ? snapshot.appendSystem : null;
  if (!instructions.length && !system && !appendSystem) return undefined;
  const sections = resourceSections({system,appendSystem,instructions,capturedFiles:snapshot.capturedFiles,skills:[]},'', 'resource_read');
  const rendered = [sections.preamble,sections.append_system,sections.workspace_instructions].filter(Boolean).join('\n\n');
  const revision = 'work-location:' + createHash('sha256').update(JSON.stringify({source,rendered})).digest('hex');
  return {kind:'work_location_context_required' as const,revision,instructions:rendered};
}

function device(target: ThreadSourceTarget) {
  const owner = target.resourceOwner;
  if (owner.kind === 'local') return target.label;
  // An unnamed connection's display label defaults to its URL.
  return !target.label || /(:\/\/|[@/\\?#])/.test(target.label)
    || [owner.hostId, owner.connectionId, owner.endpointIdentity].some(id => target.label.includes(id))
    ? 'Managed Host' : target.label;
}

export function createModelWorkLocations(options: {
  runtime: Runtime; kernel: Pick<KernelClient, 'isReady' | 'kernelEpoch' | 'issueGrant' | 'scoped' | 'retireGrant' | 'textEncodingPolicy'>;
  directory: Pick<SourceDirectory, 'list' | 'describe' | 'resolve'>;
  prepare(input: ThreadPrepareSource, signal?: AbortSignal): Promise<ThreadPreparedSource>;
  captureLocationContext?(run: Run, source: ThreadPreparedSource['source'], signal: AbortSignal): Promise<PreparedAgentResources>;
  executionEnvironment?(): Promise<NonNullable<SourceToolBinding['executionEnvironment']>>;
  openProcessView?(source: LaunchSource, runId: string, processId: string, signal: AbortSignal): Promise<{ toolBinding: SourceToolBinding; release(): Promise<void> }>;
  transfer?: ReturnType<typeof createResourceFileTransfer>;
}) {
  const {runtime, directory, kernel} = options;
  const leases = new Map<string, Lease>();
  const preparing = new Map<string, AbortController>();
  const keyFor = (runId: string, operationId: string) => JSON.stringify([runId, operationId]);
  async function admit(query: Record<string, unknown>, signal: AbortSignal) {
    if (!nonempty(query.runId) || !nonempty(query.threadId) || !nonempty(query.callId) ||
      !object(query.origin) || query.origin.kind !== 'model_step' || !nonempty(query.origin.request_id)) throw denied();
    const run = await runtime.run(query.runId, signal);
    if (run.id !== query.runId || run.thread_id !== query.threadId || run.cancel_requested ||
      !['executing','generating','runnable','waiting'].includes(run.state) ||
      !await runtime.principalCanUseHostResources?.(run.principal_id)) throw denied();
    const [thread, launch] = await Promise.all([runtime.thread(run.thread_id, signal), runtime.launch(run.id, signal)]);
    if (thread.parent_thread_id || (thread.principal_id ?? null) !== (run.principal_id ?? null) || !launch || launch.run_id !== run.id) throw denied();
    const lazy = launch.selection.source === null ? launch.selection.lazy_work_location : undefined;
    const tools = lazy ? launch.selection.tools : sourceToolSchemas(launch.selection);
    if ((!lazy && launch.selection.source?.mode !== 'live_root') || !tools.some(tool => tool.name === 'file_read')) throw denied();
    signal.throwIfAborted();
    return {run,lazy,tools};
  }
  async function prepareLocation(run: Run, operationId: string, row: Omit<Row, 'id'>, key: LocationKey, canonicalPath: string, signal: AbortSignal) {
    const identity = {runtime: 'agent' as const, threadId: run.thread_id, branchId: run.branch_id};
    const prepared = await options.prepare({...identity, key: `work-location:${operationId}`, resourceOwner: row.resourceOwner,
      workspaceId: key.workspaceId, mode: 'live_root', ...(row.selection ? {selection: row.selection} : {}),
      captureScopes: [], content: {mode:'saved-files'}}, signal);
    const source = prepared.source;
    if (source.mode !== 'live_root' || !source.liveRoot || !source.tools.includes('file_read') ||
      source.workspaceId !== key.workspaceId || source.executionWorkspaceId !== key.workspaceId ||
      !isDeepStrictEqual(source.resourceOwner, key.resourceOwner) || prepared.path !== canonicalPath || prepared.path !== source.liveRoot.canonicalRoot) throw changed();
    return { ...source, liveRoot: source.liveRoot };
  }
  async function lease(run: Run, operationId: string, tool: string, source: Awaited<ReturnType<typeof prepareLocation>>, key: LocationKey, signal: AbortSignal): Promise<Lease> {
    if (!source.tools.includes(tool)) throw denied();
    const process = tool === 'process_spawn';
    const capabilities = workLocationCapabilities(tool);
    if (!capabilities) throw denied();
    const base = { runId: run.id, threadId: run.thread_id, workspaceId: source.workspaceId,
      executionWorkspaceId: source.executionWorkspaceId, resourceOwner: source.resourceOwner, sourceMode: 'live_root' as const,
      enabledTools: [tool], rootId: source.liveRoot.rootId, liveRoot: source.liveRoot };
    if (source.resourceOwner.kind === 'managed_host') {
      const client = await runtime.managedSource(source.resourceOwner, signal);
      const coordinatorHostId = runtime.coordinatorHostId;
      // Do not abort an in-flight remote bind and lose its reply/retirement address.
      const bound = await client.bind({coordinatorHostId, scope: {kind:'run', threadId:run.thread_id, runId:run.id, epoch:run.epoch},
        operationId, purpose: tool === 'file_read' ? 'work_location_read' : 'work_location', retention:'caller', source:{...source, tools:[tool]}});
      const address = {coordinatorHostId, authorityId:bound.authorityId, resourceEpoch:bound.resourceEpoch};
      const release = async () => { await client.release({...address, mode:'retire'}); };
      try {
        if (!isDeepStrictEqual({...bound.source,environment_run_id:bound.source.environment_run_id ?? null},
          {...resourceSource(source),environment_run_id:null}) || !isDeepStrictEqual(bound.physicalRoot, source.liveRoot)
          || !isDeepStrictEqual(bound.capabilities.tools.map(tool => tool.name), [tool])
          || !isDeepStrictEqual(bound.capabilities.grantCapabilities, capabilities)
          || bound.executionOwner.kind !== 'external' || bound.executionOwner.epoch !== bound.resourceEpoch) throw changed();
        return {operationId, release, binding:{...base, grantId:bound.authorityId,
          ...(bound.textEncoding ? {textEncoding:bound.textEncoding} : {}),
          ...(bound.executionEnvironment ? { executionEnvironment: bound.executionEnvironment } : {}),
          remoteAuthority:{authorityId:bound.authorityId,resourceEpoch:bound.resourceEpoch,executionOwner:bound.executionOwner}}};
      } catch (error) { await release(); throw error; }
    }
    // The already registered root and exact tool determine this Operation's grant.
    const grant = await kernel.issueGrant({grantId:`work-location-read:${randomUUID()}`, threadId:run.thread_id,
      runId:run.id, operationId, owningWorkspace:key.workspaceId, executionWorkspace:key.workspaceId,
      capabilities, pathScopes:['']}, signal);
    const release = async () => {
      // Old local grants cannot run in a new epoch. Cleanup must not restart
      // the local kernel when its transport has just exited.
      if (kernel.isReady && grant.kernelEpoch === kernel.kernelEpoch) await kernel.retireGrant(grant.grantId);
    };
    try {
      const textEncoding = await resolveSourceTextPolicy(kernel, kernel.scoped(grant), resourceSource(source)!, source.liveRoot, signal);
      const executionEnvironment = process ? await options.executionEnvironment?.() : undefined;
      return {operationId, release, binding:{...base, grantId:grant.grantId, ...(textEncoding ? {textEncoding} : {}),
        ...(executionEnvironment ? { executionEnvironment } : {})}};
    } catch (error) { await release(); throw error; }
  }
  async function releaseEntry(key: string, entry: Lease) {
    await entry.release();
    if (leases.get(key) === entry) leases.delete(key);
  }
  const query: ModelWorkLocationOwner = async (q, signal) => {
    try {
      if (q.kind === 'work_location_release') {
        if (!nonempty(q.runId) || !nonempty(q.operationId)) throw denied();
        const key = keyFor(q.runId,q.operationId), entry = leases.get(key);
        if (entry) {
          // Rust serializes absent optional fields as null on the return
          // journey. Compare the immutable binding coordinates, not JSON shape.
          const returned = q.binding;
          if (!object(returned) || entry.binding.threadId !== q.threadId || returned.runId !== entry.binding.runId ||
            returned.threadId !== q.threadId || returned.grantId !== entry.binding.grantId ||
            !isDeepStrictEqual(returned.resourceOwner, entry.binding.resourceOwner) ||
            !isDeepStrictEqual(returned.liveRoot,entry.binding.liveRoot) ||
            !isDeepStrictEqual(returned.remoteAuthority ?? null,entry.binding.remoteAuthority ?? null)) throw denied();
          await releaseEntry(key, entry);
        }
        return {};
      }
      const {run,lazy,tools} = await admit(q, signal);
      if (q.kind === 'work_location_process_view') {
        if (!nonempty(q.operationId) || !nonempty(q.processId) || !options.openProcessView) throw denied();
        const process = await runtime.operation(q.processId, signal);
        const origin = await runtime.run(process.run_id, signal);
        if (process.managed_process?.purpose.kind !== 'process_job' || origin.thread_id !== run.thread_id ||
          origin.branch_id !== run.branch_id || origin.principal_id !== run.principal_id) throw denied();
        const source = process.resource_source ?? (await runtime.launch(origin.id, signal))?.selection.source;
        if (source?.mode !== 'live_root') throw unavailable();
        const key = keyFor(run.id, q.operationId);
        if (leases.has(key)) throw changed();
        const view = await options.openProcessView(source, origin.id, process.id, signal);
        try {
          await admit(q, signal);
          leases.set(key, { binding: view.toolBinding, operationId: q.operationId, release: view.release });
          return view.toolBinding;
        } catch (error) { await view.release(); throw error; }
      }
      if (q.default !== undefined && (q.default !== true || q.kind !== 'work_location_bind' || !lazy || q.key !== undefined)) throw denied();
      if (q.refresh !== undefined && (q.kind !== 'work_locations' || typeof q.refresh !== 'boolean')) throw denied();
      const listed = q.default === true ? {targets: [], workspace: undefined}
        : q.kind === 'work_locations' && q.refresh !== true && q.device === undefined && q.path === undefined
          ? await (directory.describe?.(signal) ?? directory.list(signal))
          : await directory.list(signal);
      const rows = [...(listed.workspace?.locations ?? []), ...(listed.workspace?.projects ?? [])]
        .filter((row): row is Row => 'resourceOwner' in row && row.selection?.mode !== 'native_workspace');
      const locate = async (row: Omit<Row, 'id'> & { id?: string }, target: ThreadSourceTarget): Promise<{key:LocationKey;canonicalPath:string}> => {
        if (!isDeepStrictEqual(target.resourceOwner,row.resourceOwner)) throw changed();
        const resolved = await directory.resolve({resourceOwner:row.resourceOwner,path:row.path}, signal);
        if (!isDeepStrictEqual(resolved.resourceOwner,row.resourceOwner) || row.workspaceId && resolved.workspaceId !== row.workspaceId) throw changed();
        return {key:{...(row.id ? { id: row.id } : {}),path:row.path,resourceOwner:row.resourceOwner,workspaceId:resolved.workspaceId},canonicalPath:resolved.path};
      };
      const resolveKey = async (given: Record<string, unknown>) => {
        const saved = given.id === undefined ? undefined : rows.find(row => row.id === given.id);
        if (given.id !== undefined && !saved) throw changed();
        if (Object.keys(given).some(field => !['id', 'path', 'resourceOwner', 'workspaceId'].includes(field))
          || given.workspaceId !== undefined && !nonempty(given.workspaceId)
          || !saved && !nonempty(given.workspaceId)
          || saved?.workspaceId && saved.workspaceId !== given.workspaceId) throw changed();
        const target = listed.targets.find(t => isDeepStrictEqual(t.resourceOwner, given.resourceOwner));
        if (!target) throw unavailable();
        const row = given.id === undefined && nonempty(given.path)
          ? { resourceOwner: target.resourceOwner, path: given.path, name: given.path.split(/[/\\]/).filter(Boolean).at(-1) || given.path }
          : saved;
        if (!row || !isDeepStrictEqual(row.resourceOwner, given.resourceOwner) || row.path !== given.path) throw changed();
        const { key, canonicalPath } = await locate(row, target);
        // Saved metadata need not have a workspace registration yet. Explicit
        // device/path lookups and older observations can still pin that identity.
        if (given.workspaceId !== undefined && given.workspaceId !== key.workspaceId) throw changed();
        return { key, row, target, canonicalPath };
      };
      if (q.kind === 'work_locations') {
        if (q.query !== undefined && typeof q.query !== 'string') throw denied();
        if (q.device !== undefined || q.path !== undefined) {
          if (!object(q.device) || !nonempty(q.path) || !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(q.path)) throw denied();
          const target = listed.targets.find(t => isDeepStrictEqual(t.resourceOwner, q.device));
          if (!target) throw unavailable();
          const name = q.path.split(/[/\\]/).filter(Boolean).at(-1) || q.path;
          const { key } = await locate({ name, resourceOwner: target.resourceOwner, path: q.path }, target);
          await admit(q, signal);
          return { locations: [{ name, path: key.path, device: device(target), key }], devices: [] };
        }
        const search = String(q.query ?? '').toLowerCase().trim();
        const results: Array<{name:string;device:string;path:string;key?:LocationKey;unavailable?:string}> = [];
        for (const row of rows) {
          const target = listed.targets.find(t => isDeepStrictEqual(t.resourceOwner,row.resourceOwner));
          const label = target ? device(target) : 'Managed Host';
          if (!`${row.name}\n${row.path}\n${label}`.toLowerCase().includes(search)) continue;
          const presentation = {name:row.name,device:label,path:row.path};
          if (target?.resourceOwner.kind === 'managed_host' && !target.capabilities.includes('work-location-read')) {
            results.push({...presentation,unavailable:'Original Host requires an update'});
          } else if (target) {
            results.push({...presentation,key:{id:row.id,path:row.path,resourceOwner:row.resourceOwner,
              ...(row.workspaceId ? {workspaceId:row.workspaceId} : {})}});
          } else results.push({...presentation,unavailable:'Original Host is unavailable'});
          if (results.length === 32) break;
        }
        await admit(q, signal);
        return {locations:results, devices: listed.targets.map(target => ({ name: device(target), owner: target.resourceOwner }))};
      }
      if (!['work_location_bind', 'work_location_switch', 'work_location_transfer'].includes(String(q.kind)) || !nonempty(q.operationId)
        || !object(q.origin) || q.operationId !== `${q.origin.request_id}:tool:${q.callId}`) throw denied();
      if (q.kind === 'work_location_transfer') {
        if (!options.transfer || !object(q.from) || !object(q.to) || typeof q.move !== 'boolean'
          || !object(q.from.key) || !object(q.to.key)) throw denied();
        const path = normalizeWorkspaceRelativePath(q.from.path), destinationPath = normalizeWorkspaceRelativePath(q.to.path);
        if (!path || !destinationPath) throw denied();
        const [from, to] = await Promise.all([resolveKey(q.from.key), resolveKey(q.to.key)]);
        await admit(q, signal);
        const result = await options.transfer({
          key: q.operationId, move: q.move, path, destinationPath,
          source: { resourceOwner: from.key.resourceOwner, workspaceId: from.key.workspaceId, root: from.canonicalPath },
          destination: { resourceOwner: to.key.resourceOwner, workspaceId: to.key.workspaceId, root: to.canonicalPath },
        }, signal);
        return { copied: result.copied, removed: result.removed, ...(result.error ? { error: 'The file transfer did not complete. Check both locations before retrying.' } : {}),
          from: device(from.target), to: device(to.target), path, destinationPath };
      }
      if (!object(q.key) && q.default !== true) throw denied();
      const target = await (async () => {
        if (q.default !== true || !lazy) return resolveKey(q.key as Record<string, unknown>);
        const row = {name: 'Default work location',path:lazy.path,resourceOwner:lazy.resource_owner,
          ...(lazy.workspace_id ? {workspaceId: lazy.workspace_id} : {})};
        // Resolve only the Catalog's original saved default. A client/query
        // cannot substitute a different owner, working directory or grant.
        const description = {resourceOwner:row.resourceOwner,label:row.name,capabilities:[]};
        return {row,target:description,...await locate(row,description)};
      })();
      const {key:actual,row,canonicalPath} = target;
      if (q.kind === 'work_location_switch') {
        const source = await prepareLocation(run, q.operationId, row, actual, canonicalPath, signal);
        await admit(q, signal);
        return { source: resourceSource(source), name: row.name, device: device(target.target), path: canonicalPath };
      }
      const tool = q.tool;
      if (typeof tool !== 'string' || !workLocationCapabilities(tool)) throw denied();
      if (q.default === true && !tools.some(schema => schema.name === tool)) throw denied();
      if (q.default !== true && target.target.resourceOwner.kind === 'managed_host'
        && !target.target.capabilities.includes(tool === 'file_read' ? 'work-location-read' : 'work-location')) throw unavailable();
      const key = keyFor(run.id,q.operationId);
      if (leases.has(key) || preparing.has(key)) throw changed();
      const lifecycle = new AbortController();
      preparing.set(key,lifecycle);
      const active = AbortSignal.any([signal,lifecycle.signal]);
      try {
        const source = await prepareLocation(run, q.operationId, row, actual, canonicalPath, active);
        if (q.default === true && options.captureLocationContext) {
          const snapshot = await options.captureLocationContext(run, source, active);
          const context = workLocationContext(snapshot, resourceSource(source)!);
          await admit(q, active);
          if (context && context.revision !== q.resourceContext) return context;
        }
        const entry = await lease(run,q.operationId,tool,source,actual,active);
        try {
          const current = await admit(q, active);
          if (current.run.epoch !== run.epoch || !isDeepStrictEqual(current.lazy,lazy)) throw changed();
          leases.set(key,entry);
          return entry.binding;
        } catch(error) { await entry.release(); throw error; }
      } finally { preparing.delete(key); }
    } catch(error) {
      // Neither model nor execution transcripts should receive transport URLs,
      // credentials or raw target diagnostics, even on a malformed response.
      signal.throwIfAborted();
      throw new SourceAdmissionError(sourceFailureCode(error) ?? 'source_unavailable');
    }
  };
  return {query, async releaseRun(runId?:string) {
    for (const [key, controller] of preparing) if (runId === undefined || JSON.parse(key)[0] === runId) controller.abort();
    await Promise.all([...leases].filter(([key])=>runId === undefined || JSON.parse(key)[0] === runId).map(([key,entry])=>releaseEntry(key,entry)));
  }};
}
