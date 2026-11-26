import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { openKnowledgeDatabase } from './database.js';
import { knowledgeDatabaseExists } from './database-files.js';
import { createSemanticStoreEngine } from './semantic/store-engine.js';
import { createHashEmbedder } from './semantic/embedder.js';
import { semanticGenerationDir, spaceIdOf, workspaceScope } from './semantic/identity.js';

const require = createRequire(import.meta.url);
const roots: string[] = [];
beforeAll(() => {
  if (process.env.VARIN_TDB_MIGRATOR_PATH) return;
  const prepare = fileURLToPath(new URL('../../../../../scripts/prepare-trivium-migrator.mjs', import.meta.url));
  vi.stubEnv('VARIN_TDB_MIGRATOR_PATH', execFileSync(process.execPath, [prepare], { encoding: 'utf8' }).trim());
});
afterAll(() => vi.unstubAllEnvs());
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const options = { dim: 8, syncMode: 'full' as const, autoBuildQuiver: false, loadTextIndex: false, payloadCacheMb: 0 };
function legacy(checkpoint: boolean, dim = 8) {
  const root = mkdtempSync(join(tmpdir(), 'varin-tdb-upgrade-')); roots.push(root);
  const file = join(root, 'knowledge.tdb');
  const child = spawnSync(process.execPath, ['-e', `
    const { TriviumDB } = require(process.argv[1]);
    const options = JSON.parse(process.argv[3]);
    const db = new TriviumDB(process.argv[2], options);
    if (process.argv[4] === 'true') {
      db.insert(Array(options.dim).fill(0), { type: 'knowledge', content: '检查点原文' });
      db.createIndex('type'); db.flush();
    }
    const id = db.insert(Array(options.dim).fill(1), { type: 'knowledge', content: 'WAL 原文' });
    if (process.argv[4] === 'true') db.link(1, id, 'related');
    process.exit(0); // An acknowledged WAL without a successful close.
  `, require.resolve('triviumdb-upgrade-0.8'), file, JSON.stringify({ ...options, dim }), String(checkpoint)], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  expect(child.error ?? child.status, child.stderr).toBe(0);
  return file;
}

function installCheckpoint(version: string, directory: string, filename = 'knowledge.tdb') {
  // Frozen file groups from the published addons: insert + createIndex + flush,
  // then insert + link and immediate process exit. No old engine is shipped for this path.
  const fixture = new URL(`./fixtures/trivium-${version}-checkpoint-wal.json`, import.meta.url);
  const files: Record<string, string> = JSON.parse(readFileSync(fixture, 'utf8'));
  for (const [name, data] of Object.entries(files)) writeFileSync(join(directory, name.replace('knowledge.tdb', filename)), Buffer.from(data, 'base64'));
  return files;
}

it.each(['0.9.0', '0.9.1'])('recovers a %s checkpoint and its acknowledged WAL before publishing a new checkpoint', async version => {
  const root = mkdtempSync(join(tmpdir(), 'varin-tdb-checkpoint-')); roots.push(root);
  const files = installCheckpoint(version, root);
  const file = join(root, 'knowledge.tdb');
  const db = openKnowledgeDatabase(file, options);
  try {
    expect(db.getPayload(1)).toEqual({ type: 'knowledge', content: 'checkpoint' });
    expect(db.get(2)).toMatchObject({ payload: { type: 'knowledge', content: 'pending WAL' }, vector: Array(8).fill(0.25) });
    expect(db.get(1)?.edges).toContainEqual(expect.objectContaining({ targetId: 2, label: 'related' }));
    db.updatePayload(2, { type: 'knowledge', content: 'after upgrade' });
  } finally { db.close(); }
  // A restored installation can contain only the active migrated directory.
  for (const [name, data] of Object.entries(files)) {
    expect(readFileSync(join(root, name))).toEqual(Buffer.from(data, 'base64'));
    unlinkSync(join(root, name));
  }
  expect(await knowledgeDatabaseExists(file)).toBe(true);
  const reader = openKnowledgeDatabase(file, { ...options, accessMode: 'readOnly' });
  try {
    expect(reader.getPayload(2)).toEqual({ type: 'knowledge', content: 'after upgrade' });
    expect(reader.get(1)?.edges).toContainEqual(expect.objectContaining({ targetId: 2, label: 'related' }));
  } finally { reader.close(); }
});

it('publishes a readable immutable semantic generation after migrating its writer', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'varin-tdb-semantic-')); roots.push(dataDir);
  const scope = workspaceScope('project');
  const space = { ...createHashEmbedder().space, dim: 8 };
  const directory = semanticGenerationDir(dataDir, 'host', scope, spaceIdOf(space), 'g1');
  mkdirSync(directory, { recursive: true });
  installCheckpoint('0.9.1', directory, 'index.tdb');
  const store = createSemanticStoreEngine({ dataDir, hostId: 'host', scope, space });
  try {
    const reader = await store.retainPublished();
    expect(reader).toBeTruthy();
    expect(await store.listDocumentStatesPinned(reader!.token)).toEqual([]);
  } finally { await store.close(); }
});

it('upgrades a 0.8 checkpoint and its pending WAL without changing node identities or graph links', () => {
  const file = legacy(true);
  const db = openKnowledgeDatabase(file, options);
  try {
    expect(db.nodeCount()).toBe(2);
    expect(db.getPayload(1)).toEqual({ type: 'knowledge', content: '检查点原文' });
    expect(db.getPayload(2)).toEqual({ type: 'knowledge', content: 'WAL 原文' });
    expect(db.get(1)?.edges).toContainEqual(expect.objectContaining({ targetId: 2, label: 'related' }));
    db.updatePayload(2, { type: 'knowledge', content: '新版本修订' });
  } finally { db.close(); }
  const reader = openKnowledgeDatabase(file, { ...options, accessMode: 'readOnly' });
  try { expect(reader.getPayload(2)).toEqual({ type: 'knowledge', content: '新版本修订' }); }
  finally { reader.close(); }
});

it.each([1, 8])('automatically checkpoints an old WAL-only store with dimension %s, preserving read-only opens', dim => {
  const file = legacy(false, dim);
  const wal = readFileSync(`${file}.wal`);
  expect(() => openKnowledgeDatabase(file, { ...options, dim, accessMode: 'readOnly' })).toThrow();
  expect(readFileSync(`${file}.wal`)).toEqual(wal);
  const db = openKnowledgeDatabase(file, { ...options, dim });
  try {
    expect(db.nodeCount()).toBe(1);
    expect(db.getPayload(1)).toEqual({ type: 'knowledge', content: 'WAL 原文' });
    expect(db.get(1)?.vector).toEqual(Array(dim).fill(1));
  } finally { db.close(); }
  const reopened = openKnowledgeDatabase(file, { ...options, dim });
  try { expect(reopened.getPayload(1)).toEqual({ type: 'knowledge', content: 'WAL 原文' }); }
  finally { reopened.close(); }
});

it('preserves a damaged main file and reports its original error', () => {
  const root = mkdtempSync(join(tmpdir(), 'varin-tdb-damage-')); roots.push(root);
  const file = join(root, 'knowledge.tdb'), original = Buffer.from('damaged database');
  writeFileSync(file, original);
  expect(() => openKnowledgeDatabase(file, options)).toThrow();
  expect(readFileSync(file)).toEqual(original);
});

it('does not discard a corrupt legacy WAL during checkpoint upgrade', () => {
  const file = legacy(false), wal = readFileSync(`${file}.wal`);
  wal.writeUInt8(wal.readUInt8(wal.length - 1) ^ 0x40, wal.length - 1);
  writeFileSync(`${file}.wal`, wal);
  expect(() => openKnowledgeDatabase(file, options)).toThrow();
  expect(readFileSync(`${file}.wal`)).toEqual(wal);
});


it('reports a corrupt base checkpoint even when its WAL header matches a recoverable old store', () => {
  const { TriviumDB } = require('triviumdb') as typeof import('triviumdb');
  const missing = legacy(false), intact = legacy(true), damaged = legacy(true);
  const damagedMain = Buffer.from('damaged 0.8 checkpoint');
  writeFileSync(damaged, damagedMain);
  const wal = readFileSync(`${damaged}.wal`);
  for (const file of [missing, intact]) expect(readFileSync(`${file}.wal`).subarray(0, 6)).toEqual(wal.subarray(0, 6));
  const diagnostic = (file: string) => {
    try { new TriviumDB(file, options).close(); } catch (error) { return error; }
    return null;
  };
  const missingWal = readFileSync(`${missing}.wal`);
  expect(diagnostic(missing)).toMatchObject({ code: 'TDB_MIGRATION_REQUIRED', details: { component: 'wal', found: 3 } });
  expect(readFileSync(`${missing}.wal`)).toEqual(missingWal);
  expect(diagnostic(intact)).toMatchObject({ code: 'TDB_MIGRATION_REQUIRED', details: { component: 'database' } });
  const corruption = diagnostic(damaged);
  expect(corruption).toMatchObject({ code: 'TDB_CORRUPTED_FILE' });
  expect(() => openKnowledgeDatabase(damaged, options)).toThrow(expect.objectContaining({
    message: (corruption as Error).message,
  }));
  expect(readFileSync(damaged)).toEqual(damagedMain);
  expect(readFileSync(`${damaged}.wal`)).toEqual(wal);
});
