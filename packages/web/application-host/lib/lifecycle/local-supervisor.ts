import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { SupervisorJournal } from './supervisor-journal.js';
import type { FollowupEventReceiveParams } from '@varin/protocol';

async function readPage(): Promise<FollowupEventReceiveParams> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    length += bytes.length;
    if (length > 4 * 1024 * 1024) throw new Error('Supervisor input is too large');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as FollowupEventReceiveParams;
}

function ensureRunning(command: string[]): Promise<void> {
  const [executable, ...args] = command;
  if (!executable) throw new Error('A local readiness command is required');
  return new Promise((resolve, reject) => {
    // Do not forward journal content to an executable or let a journal record
    // pick a command. Operators supply explicit argv only.
    execFile(executable, args, { timeout: 30_000 }, error => {
      if (error) reject(new Error('Local readiness command failed')); else resolve();
    });
  });
}

async function main(argv: string[]): Promise<unknown> {
  const [directory, owner, action, ...args] = argv;
  if (!directory || !owner) throw new Error('Supervisor journal and owner are required');
  const journal = await SupervisorJournal.open(directory, owner);
  if (action === 'accept' && args.length === 1) return journal.accept(args[0]!, await readPage());
  if (action === 'publish' && args.length === 2) {
    if (!/^\d+$/.test(args[0]!) || !(args[1] === 'none' || /^\d+$/.test(args[1]!))) throw new Error('Invalid wake publication');
    return journal.publishWake({revision: Number(args[0]), nextWakeAtMs: args[1] === 'none' ? null : Number(args[1])});
  }
  if (action === 'status' && !args.length) return { wake: await journal.currentWake(), pending: await journal.hasPendingEvents() };
  if (action === 'wake-due' && args.length > 2 && /^\d+$/.test(args[0]!) && args[1] === '--') {
    return { wake: await journal.reconcileDueWake(Number(args[0]), Date.now(), () => ensureRunning(args.slice(2))) };
  }
  if (action === 'wake-inbox' && args.length > 1 && args[0] === '--') {
    if (!await journal.hasPendingEvents()) return { wake: 'waiting' };
    await ensureRunning(args.slice(1));
    return { wake: 'ready' };
  }
  throw new Error('Invalid supervisor command');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).then(
    result => console.log(JSON.stringify(result)),
    () => { console.error('Local supervisor command failed'); process.exitCode = 1; },
  );
}
