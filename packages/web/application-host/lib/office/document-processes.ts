import { createKernelProcessService } from '../kernel/process-service.js';
import type { KernelClient } from '../kernel/kernel-client.js';
import { canonicalizePathIdentity, isPathWithinRoot } from '../workspace/path-safety.js';

export function createDocumentProcesses(kernel: KernelClient, hostId: string, directory: string) {
  const workspaceId = `document-reading:${hostId}`;
  return createKernelProcessService({
    client: kernel,
    async resolveIdentity(cwd) {
      const canonicalRoot = await canonicalizePathIdentity(directory);
      const canonicalCwd = await canonicalizePathIdentity(cwd);
      if (!isPathWithinRoot(canonicalCwd, canonicalRoot)) throw new Error('Document parser escaped its private directory');
      return { workspaceId, executionWorkspaceId: workspaceId, canonicalRoot };
    },
  });
}
