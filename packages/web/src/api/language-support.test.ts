import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runtimeFetchMock } = vi.hoisted(() => ({ runtimeFetchMock: vi.fn() }));

vi.mock('@varin/application-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@varin/application-client')>(),
  runtimeFetch: runtimeFetchMock,
}));

describe('createWebLanguageSupportAPI', () => {
  beforeEach(() => runtimeFetchMock.mockReset());

  it('uploads the selected client file to the connected Host for offline preparation', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ status: 'installed' }));
    const archive = new Blob([Uint8Array.of(0, 255, 1)]);
    const { createWebLanguageSupportAPI } = await import('./language-support');
    await expect(createWebLanguageSupportAPI().prepareServer({ workspaceId: 'ws/a', languageId: 'cpp', archive })).resolves.toEqual({ status: 'installed' });
    expect(runtimeFetchMock).toHaveBeenCalledExactlyOnceWith('/api/language-support/server/import?workspaceId=ws%2Fa&languageId=cpp', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/octet-stream' }, body: archive,
    });
  });

  it('posts getStatus to the host language-support route', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      workspaceId: 'ws-1',
      languages: [],
      partial: false,
      scannedFiles: 0,
      fileLimit: 8000,
    }));
    const { createWebLanguageSupportAPI } = await import('./language-support');
    const status = await createWebLanguageSupportAPI().getStatus({ workspaceId: 'ws-1' });
    expect(status.workspaceId).toBe('ws-1');
    expect(runtimeFetchMock).toHaveBeenCalledExactlyOnceWith('/api/language-support/status', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-1' }),
    });
  });
});
