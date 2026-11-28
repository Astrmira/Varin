/** A stable logical store retains its revision while the native connection can park. */
import type { KnowledgeStore, OpenWorkspaceKnowledgeDeps } from "./store-contract.js";
import { knowledgeStoreProcess, type KnowledgeStoreProcess } from "./store-process.js";
import { STORE_METHODS, restoreStoreError, type StoreMethod, type DirectStoreMethod } from "./store-protocol.js";
import { resolveAssociations, type AssociationRefreshPort } from "./association-refresh.js";
import { purgeFiles, type FilePurgePort } from "./file-purge.js";
export * from "./store-contract.js";

interface Session {
  owner: KnowledgeStoreProcess;
  id: number;
  dim: number;
}

export async function openWorkspaceKnowledge(deps: OpenWorkspaceKnowledgeDeps): Promise<KnowledgeStore> {
  let resident: Session | undefined;
  let opening: Promise<Session> | undefined;
  let closing: Promise<void> | undefined;
  let shutdown: Promise<void> | undefined;
  let revision = "";
  let idle: NodeJS.Timeout | undefined;
  const active = new Set<Promise<unknown>>();

  async function open(): Promise<Session> {
    const owner = knowledgeStoreProcess();
    const id = owner.register({
      revision: value => { revision = value; },
      notify: message => {
        if (message.type === "plan-changed") deps.onPlanChanged?.(message.change);
        else if (message.type === "knowledge") deps.onKnowledgeChanged?.(message.ids);
        else reportError(restoreStoreError(message.error));
      },
    });
    try {
      const { dim } = await owner.request(id, "open", [{
        dataDir: deps.dataDir, hostId: deps.hostId, workspaceId: deps.workspaceId,
        ...(deps.scope === undefined ? {} : { scope: deps.scope }),
        embedding: deps.embedding ? { dim: deps.embedding.dim } : null,
      }]) as { dim: number };
      return resident = { owner, id, dim };
    } catch (error) {
      await owner.release(id);
      throw error;
    }
  }
  function acquire(): Promise<Session> {
    if (closing) return closing.then(acquire);
    if (resident) return Promise.resolve(resident);
    return opening ??= open().finally(() => { opening = undefined; });
  }
  function releaseSession(): Promise<void> {
    if (closing) return closing;
    const session = resident;
    if (!session) return Promise.resolve();
    closing = (async () => {
      try { await session.owner.request(session.id, "close", []); }
      catch (error) {
        // A failed checkpoint on a live writer retains its handle for retry.
        if (!session.owner.failed) throw error;
        resident = undefined;
        await session.owner.release(session.id);
        throw error;
      }
      resident = undefined;
      await session.owner.release(session.id);
    })().finally(() => { closing = undefined; });
    return closing;
  }
  function reportError(error: unknown) {
    if (deps.onPersistenceError) deps.onPersistenceError(error);
    else console.error("[KnowledgeStore] Checkpoint failed:", error);
  }
  function schedule() {
    if (active.size || shutdown || !resident) return;
    clearTimeout(idle);
    idle = setTimeout(() => { void releaseSession().catch(reportError); }, deps.idleDelayMs ?? 60_000);
    idle.unref();
  }
  const { dim } = await acquire();
  schedule();
  function run<T>(action: (session: Session) => Promise<T>): Promise<T> {
    if (shutdown) return Promise.reject(new Error("Knowledge store is closing or closed"));
    clearTimeout(idle);
    const work = resident && !closing ? action(resident) : acquire().then(action);
    active.add(work);
    const done = () => { active.delete(work); schedule(); };
    void work.then(done, done);
    return work;
  }
  async function call(method: StoreMethod, args: unknown[], signal?: AbortSignal) {
    signal?.throwIfAborted();
    // Hot calls snapshot arguments in request(). Preserve admission-time values during a cold open too.
    const values = resident && !closing ? args : structuredClone(args);
    return run(session => session.owner.request(session.id, method, values, signal));
  }
  const methods = Object.fromEntries((Object.keys(STORE_METHODS) as DirectStoreMethod[])
    .map(method => [method, (...args: unknown[]) => call(method, args)])) as Pick<KnowledgeStore, DirectStoreMethod>;
  return {
    ...methods, dim,
    knowledgeRevision: () => {
      if (shutdown || resident?.owner.failed) throw new Error("Knowledge store is unavailable");
      return revision;
    },
    removeFileSymbols: (path, options) => {
      const { signal, ...serializable } = options ?? {};
      return call("removeFileSymbols", [path, options === undefined ? undefined : serializable], signal) as ReturnType<KnowledgeStore["removeFileSymbols"]>;
    },
    purgeFileCatalog: (scope, options) => {
      const captured = structuredClone(scope);
      return run(({ owner, id }) => purgeFiles({
        beginFilePurge: value => owner.request(id, "beginFilePurge", [value]) as ReturnType<FilePurgePort["beginFilePurge"]>,
        stepFilePurge: key => owner.request(id, "stepFilePurge", [key]) as ReturnType<FilePurgePort["stepFilePurge"]>,
        releaseFilePurge: async key => { await owner.request(id, "releaseFilePurge", [key]); },
      }, captured, options));
    },
    resolveAssociationCandidates: () => run(({ owner, id }) => resolveAssociations({
      beginAssociationRefresh: () => owner.request(id, "beginAssociationRefresh", []) as ReturnType<AssociationRefreshPort["beginAssociationRefresh"]>,
      stepAssociationRefresh: key => owner.request(id, "stepAssociationRefresh", [key]) as ReturnType<AssociationRefreshPort["stepAssociationRefresh"]>,
      releaseAssociationRefresh: async key => { await owner.request(id, "releaseAssociationRefresh", [key]); },
    })),
    close: () => {
      clearTimeout(idle);
      return shutdown ??= Promise.allSettled([...active]).then(releaseSession).catch(error => {
        shutdown = undefined;
        throw error;
      });
    },
  };
}
