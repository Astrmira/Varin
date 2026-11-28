import type { BotSession, BotSummary, ConversationOrganizationPlacement, ThreadIdentity, ThreadSummary } from '@varin/application-client';
import { currentRequestPrincipal } from '../kernel/request-principal.js';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import { GROUP_THREAD_PREFIX } from './bot-group-chat.js';

export function createBotSessions(getRuntime: () => Pick<AgentRuntimeClient, 'botScope' | 'threadCatalog' | 'thread' | 'createBotThread' | 'resolveBotEntry'>, prepareOrganization?: (identity: ThreadIdentity, placement: ConversationOrganizationPlacement) => Promise<import('@varin/application-client').ConversationCreationDefaults | null>) {
  const session = (bot: BotSummary, thread: ThreadSummary): BotSession => ({
    identity: { runtime: 'agent', threadId: thread.thread_id, branchId: thread.main_branch_id },
    thread,
    primary: thread.thread_id === bot.entry.threadId,
  });
  async function listSessions(bot: BotSummary, view: 'owned' | 'visible' = 'owned'): Promise<BotSession[]> {
    const principalId = currentRequestPrincipal();
    if (view === 'visible') {
      const threads = await getRuntime().threadCatalog({ botId: bot.id, archived: 'include', ...(principalId === undefined ? {} : { principalId }) });
      return threads.map(thread => session(bot, thread)).sort((a, b) => Number(b.primary) - Number(a.primary) || a.thread.created_at_ms - b.thread.created_at_ms);
    }
    const scope = await getRuntime().botScope(bot.id, undefined, true, principalId);
    const threads = new Map(scope.threads.map(thread => [thread.thread_id, thread]));
    return scope.sessions.filter(threadId => !threadId.startsWith(GROUP_THREAD_PREFIX)).flatMap(threadId => {
      const thread = threads.get(threadId);
      return thread && thread.deleted_at_ms === null ? [session(bot, thread)] : [];
    });
  }

  async function createSession(bot: BotSummary, identity: ThreadIdentity, organization?: ConversationOrganizationPlacement): Promise<BotSession> {
    const runtime = getRuntime();
    const defaults = organization && prepareOrganization ? await prepareOrganization(identity, organization) : undefined;
    await runtime.createBotThread(bot.id, identity.threadId, identity.branchId, undefined, organization, currentRequestPrincipal(), defaults ?? undefined);
    const thread = await runtime.thread(identity.threadId);
    return { identity: { runtime: 'agent', threadId: thread.thread_id, branchId: thread.main_branch_id }, thread, primary: false };
  }

  // The profile keeps its original identity. Catalog validates its ownership and
  // resolves or creates a usable entry in one transaction, including after GC.
  async function ensureEntry(bot: BotSummary): Promise<ThreadIdentity> {
    if (bot.entry.runtime !== 'agent') throw new Error('Agent Bot identity is required');
    const identity = await getRuntime().resolveBotEntry(bot.id, bot.entry.threadId, bot.entry.branchId, undefined, currentRequestPrincipal());
    return { runtime: 'agent', ...identity };
  }

  return { ensureEntry, listSessions, createSession };
}
