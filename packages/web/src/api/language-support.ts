import type {
  LanguageSupportAPI,
  LanguageSupportInstallResult,
  LanguageSupportStatus,
  LanguageSupportServerInfo,
} from '@varin/application-client';
import { LanguageSupportError, parseLanguageSupportFailureReason } from '@varin/application-client';
import { runtimeFetch } from '@varin/application-client';
import { getRuntimeEndpointGeneration } from '@varin/application-client';

const assertGeneration = (generation: number): void => {
  if (generation !== getRuntimeEndpointGeneration()) {
    throw new LanguageSupportError('Application host endpoint changed', { reason: 'failed' });
  }
};

const post = async (path: string, body: unknown, archive?: Blob): Promise<unknown> => {
  const generation = getRuntimeEndpointGeneration();
  const response = await runtimeFetch(path, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': archive ? 'application/octet-stream' : 'application/json' },
    body: archive ?? JSON.stringify(body),
  });
  assertGeneration(generation);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText })) as {
      error?: string;
      reason?: unknown;
    };
    throw new LanguageSupportError(error.error || 'Language support request failed', {
      reason: parseLanguageSupportFailureReason(error.reason),
      status: response.status,
    });
  }
  return response.json();
};

export const createWebLanguageSupportAPI = (): LanguageSupportAPI => ({
  getStatus: (request) => post('/api/language-support/status', request) as Promise<LanguageSupportStatus>,
  prepareServer: ({ archive, ...request }) => post(archive ? '/api/language-support/server/import?' + new URLSearchParams(request) : '/api/language-support/server/prepare', request, archive) as Promise<LanguageSupportServerInfo>,
  cancelServerPreparation: async (request) => { await post('/api/language-support/server/cancel', request); },
  install: (request) => post('/api/language-support/install', request) as Promise<LanguageSupportInstallResult>,
  cancelInstall: (request) => post('/api/language-support/cancel', request) as Promise<LanguageSupportInstallResult>,
  importUserGrammar: (request) => post('/api/language-support/import', request) as Promise<LanguageSupportInstallResult>,
});
