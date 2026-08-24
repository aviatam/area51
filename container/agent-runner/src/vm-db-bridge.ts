/**
 * Root-only Incus VM database bridge.
 *
 * VM managed volumes are copy-based: the host and guest do not share an
 * inode.  This helper merges host-owned inbound snapshots into the live guest
 * database and creates consistent guest-owned outbound snapshots for the
 * host.  It is invoked through `incus exec` by the trusted host runtime, never
 * by the unprivileged agent process.
 */
import { Database } from 'bun:sqlite';
import fs from 'node:fs';

const WORKSPACE_INBOUND = '/workspace/inbound.db';
const WORKSPACE_OUTBOUND = '/workspace/outbound.db';
const STAGED_INBOUND = '/run/area51-sync/inbound.db';
const STAGED_OUTBOUND = '/run/area51-sync/outbound.db';
const STAGED_HEARTBEAT = '/run/area51-sync/heartbeat';
const WORKSPACE_HEARTBEAT = '/workspace/.heartbeat';

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

if (import.meta.main) {
  if (process.getuid?.() !== 0) throw new Error('VM database bridge must run as root');
  const command = process.argv[2];
  if (command === 'import-inbound') importInboundSnapshot();
  else if (command === 'export-outbound') exportOutboundSnapshot();
  else throw new Error(`Unknown VM database bridge command: ${command ?? '(missing)'}`);
}
