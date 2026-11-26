/** Native opens and offline conversions run in the private storage owner. */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statfsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TriviumDBOptions } from 'triviumdb';
import { knowledgeDatabasePath, knowledgeMigrationRoot, knowledgeMigrationTarget } from './database-files.js';

const require = createRequire(import.meta.url);
const { TriviumDB } = require('triviumdb') as typeof import('triviumdb');
const checkpointLegacyWal = `
  const fs = require('node:fs');
  const { crc32 } = require('node:zlib');
  // 0.8 stops replay at a bad CRC. Reject complete corrupt frames before it
  // opens the writer, so upgrading cannot silently discard committed data.
  const fd = fs.openSync(process.argv[2] + '.wal', 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const header = Buffer.alloc(6), word = Buffer.alloc(4), block = Buffer.alloc(64 * 1024);
    const read = (buffer, length, position) => {
      let done = 0;
      while (done < length) {
        const count = fs.readSync(fd, buffer, done, length - done, position + done);
        if (!count) throw new Error('Legacy WAL changed during upgrade');
        done += count;
      }
    };
    read(header, 6, 0);
    if (header.toString('ascii', 0, 4) !== 'TVWL' || header.readUInt16LE(4) !== 3)
      throw new Error('Unsupported legacy WAL format');
    for (let offset = 6; offset + 4 <= size;) {
      read(word, 4, offset);
      const length = word.readUInt32LE(0), end = offset + 4 + length;
      if (end + 4 > size) break; // The original engine recovers a physically incomplete tail.
      let checksum = 0;
      for (let position = offset + 4; position < end;) {
        const count = Math.min(block.length, end - position);
        read(block, count, position);
        checksum = crc32(block.subarray(0, count), checksum); position += count;
      }
      read(word, 4, end);
      if (checksum !== word.readUInt32LE(0)) throw new Error('Corrupt legacy WAL frame at byte ' + offset);
      offset = end + 4;
    }
  } finally { fs.closeSync(fd); }
  const { TriviumDB } = require(process.argv[1]);
  const database = new TriviumDB(process.argv[2], JSON.parse(process.argv[3]));
  database.close();
`;

function migrate(file: string, options: TriviumDBOptions) {
  const target = knowledgeMigrationTarget(file);
  mkdirSync(knowledgeMigrationRoot(file), { recursive: true });
  const executable = process.env.VARIN_TDB_MIGRATOR_PATH || fileURLToPath(new URL(
    './native/triviumdb-migrate' + (process.platform === 'win32' ? '.exe' : ''), import.meta.url));
  // The native tool computes required scratch space and checks actual free disk.
  // Use the source volume's capacity for its CLI budgets instead of imposing a
  // fixed 1 GiB limit on existing Varin data.
  const volume = statfsSync(dirname(file), { bigint: true });
  const capacityMiB = ((volume.blocks * volume.bsize) / 1048576n + 1n).toString();
  const result = spawnSync(executable, ['--execute', '--source', file, '--destination', target,
    '--source-dtype', options.dtype ?? 'f32', '--storage', options.storageMode ?? 'mmap',
    '--max-source-mib', capacityMiB, '--max-work-mib', capacityMiB], { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    let failure;
    try { failure = JSON.parse(result.stderr).error; } catch { /* Non-JSON process failure. */ }
    throw Object.assign(new Error(`Knowledge migration failed for ${file}: ${failure?.message || result.stderr.trim() || result.signal || result.status}`),
      failure && { code: failure.code, phase: failure.phase, outcome: failure.outcome, details: failure.details });
  }
  return new TriviumDB(join(target, 'database.tdb'), options);
}

export function openKnowledgeDatabase(file: string, options: TriviumDBOptions) {
  const writable = options.accessMode !== 'readOnly' && options.accessMode !== 'immutable';
  const current = knowledgeDatabasePath(file);
  if (current !== file) {
    if (writable && existsSync(current + '.migration')) return migrate(file, options);
    if ((!existsSync(current) && !existsSync(current + '.publish')) || !existsSync(join(dirname(current), 'migration-report.json'))) {
      throw new Error(`Incomplete migrated knowledge database at ${current}`);
    }
    return new TriviumDB(current, options);
  }
  try { return new TriviumDB(file, options); }
  catch (error) {
    const diagnostic = error as { code?: string; details?: { component?: string; found?: number } };
    if (!writable || diagnostic.code !== 'TDB_MIGRATION_REQUIRED') throw error;
    if (diagnostic.details?.component === 'wal' && diagnostic.details.found === 3 && !existsSync(file)) {
      // 0.8 could acknowledge its first writes before publishing any main file.
      // Only its original engine can turn that WAL into the migrator's required checkpoint.
      const base = basename(file);
      const orphan = readdirSync(dirname(file)).find(name => name.startsWith(base + '.') && name !== base + '.wal' && name !== base + '.lock');
      if (orphan) throw new Error(`Missing knowledge checkpoint for ${file} with existing artifact ${orphan}`, { cause: error });
      execFileSync(process.execPath, ['-e', checkpointLegacyWal, require.resolve('triviumdb-upgrade-0.8'), file,
        JSON.stringify({ dim: options.dim, dtype: options.dtype, syncMode: 'full',
          autoBuildQuiver: false, loadTextIndex: false, payloadCacheMb: 0 })], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
    }
    return migrate(file, options);
  }
}
