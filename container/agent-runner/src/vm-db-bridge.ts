/**
 * Root-only Incus VM session bridge.
 *
 * VM managed volumes are copy-based: the host and guest do not share an
 * inode.  This helper merges host-owned inbound snapshots into the live guest
 * database and creates consistent guest-owned outbound snapshots for the
 * host.  It is invoked through `incus exec` by the trusted host runtime, never
 * by the unprivileged agent process.
 */
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const WORKSPACE_INBOUND = '/workspace/inbound.db';
const WORKSPACE_OUTBOUND = '/workspace/outbound.db';
const STAGED_INBOUND = '/run/area51-sync/inbound.db';
const STAGED_OUTBOUND = '/run/area51-sync/outbound.db';
const STAGED_HEARTBEAT = '/run/area51-sync/heartbeat';
const WORKSPACE_HEARTBEAT = '/workspace/.heartbeat';
const PROVIDER_STATE = '/home/node/.claude';
const STAGED_PROVIDER_STATE = '/run/area51-sync/provider-state';
const STAGED_PROVIDER_MANIFEST = '/run/area51-sync/provider-state.json';

const MAX_PROVIDER_STATE_FILES = 2_048;
const MAX_PROVIDER_STATE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PROVIDER_STATE_TOTAL_BYTES = 64 * 1024 * 1024;

const INBOUND_TABLES = ['messages_in', 'delivered', 'destinations', 'session_routing'] as const;

export function importInboundSnapshot(): void {
  const db = new Database(WORKSPACE_INBOUND);
  try {
    db.exec('PRAGMA journal_mode = DELETE');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(`ATTACH DATABASE '${STAGED_INBOUND}' AS staged`);
    db.transaction(() => {
      for (const table of INBOUND_TABLES) {
        db.exec(`DELETE FROM main.${table}`);
        db.exec(`INSERT INTO main.${table} SELECT * FROM staged.${table}`);
      }
    })();
    db.exec('DETACH DATABASE staged');
  } finally {
    db.close();
  }
}

export function exportOutboundSnapshot(): void {
  fs.mkdirSync('/run/area51-sync', { recursive: true, mode: 0o700 });
  fs.rmSync(STAGED_OUTBOUND, { force: true });
  const db = new Database(WORKSPACE_OUTBOUND);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    // VACUUM INTO is an atomic, transactionally consistent copy even while
    // the long-lived agent connection remains open.
    db.exec(`VACUUM INTO '${STAGED_OUTBOUND}'`);
  } finally {
    db.close();
  }
  fs.chmodSync(STAGED_OUTBOUND, 0o600);
  let heartbeat = 'missing';
  try {
    heartbeat = String(Math.floor(fs.statSync(WORKSPACE_HEARTBEAT).mtimeMs));
  } catch {
    // A missing heartbeat is meaningful: the agent has not reported activity.
  }
  fs.writeFileSync(STAGED_HEARTBEAT, heartbeat, { mode: 0o600 });
  fs.chmodSync(STAGED_HEARTBEAT, 0o600);
}

/** Snapshot bounded regular provider-state files into a root-owned staging tree. */
export function exportProviderStateSnapshot(): void {
  fs.rmSync(STAGED_PROVIDER_STATE, { recursive: true, force: true });
  fs.mkdirSync(STAGED_PROVIDER_STATE, { recursive: true, mode: 0o700 });
  const files: Array<{ path: string; size: number; sha256: string }> = [];
  let totalBytes = 0;

  const visit = (directory: string, prefix: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const source = path.join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stats = fs.lstatSync(source);
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        visit(source, relative);
        continue;
      }
      if (!stats.isFile()) throw new Error(`Unsupported provider-state entry: ${relative}`);
      if (files.length >= MAX_PROVIDER_STATE_FILES) throw new Error('Provider state exceeds 2048 files');

      const destination = path.join(STAGED_PROVIDER_STATE, ...relative.split('/'));
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      const descriptor = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let content: Buffer;
      try {
        const opened = fs.fstatSync(descriptor);
        if (!opened.isFile()) throw new Error(`Provider-state entry changed type: ${relative}`);
        content = fs.readFileSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      if (content.byteLength > MAX_PROVIDER_STATE_FILE_BYTES) {
        throw new Error(`Provider-state file exceeds ${MAX_PROVIDER_STATE_FILE_BYTES} bytes: ${relative}`);
      }
      totalBytes += content.byteLength;
      if (totalBytes > MAX_PROVIDER_STATE_TOTAL_BYTES) throw new Error('Provider state exceeds 64 MiB');
      fs.writeFileSync(destination, content, { mode: 0o600 });
      fs.chmodSync(destination, 0o600);
      files.push({
        path: relative,
        size: content.byteLength,
        sha256: createHash('sha256').update(content).digest('hex'),
      });
    }
  };

  visit(PROVIDER_STATE, '');
  fs.writeFileSync(STAGED_PROVIDER_MANIFEST, JSON.stringify({ version: 1, files }), { mode: 0o600 });
  fs.chmodSync(STAGED_PROVIDER_MANIFEST, 0o600);
}

if (import.meta.main) {
  if (process.getuid?.() !== 0) throw new Error('VM database bridge must run as root');
  const command = process.argv[2];
  if (command === 'import-inbound') importInboundSnapshot();
  else if (command === 'export-outbound') exportOutboundSnapshot();
  else if (command === 'export-provider-state') exportProviderStateSnapshot();
  else throw new Error(`Unknown VM database bridge command: ${command ?? '(missing)'}`);
}
