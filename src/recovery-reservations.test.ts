import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { getRegisteredMigrations, runMigrations } from './db/migrations/index.js';
import './modules/tool-actions/index.js';
import { createSnapshot, restoreSnapshot } from './recovery-snapshot.js';
import { enforceRecoveryGate } from './recovery-gate.js';
import { prepareRestoredState } from './recovery-reconciliation.js';
import { importSurvivingReservations, inspectSurvivingReservations } from './recovery-reservations.js';
import { SessionToolActions } from './session-tool-actions.js';
import { parseToolConfiguration } from './tool-action-config.js';

const roots: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'area51-import-reservations-')));
  roots.push(root);
  const install = path.join(root, 'source');
  const config = path.join(root, 'config');
  fs.mkdirSync(path.join(install, 'data'), { recursive: true });
  fs.mkdirSync(config);
  const source = path.join(install, 'data', 'v2.db');
  const db = new Database(source);
  try {
    runMigrations(db, getRegisteredMigrations());
    db.exec(
      "INSERT INTO agent_groups VALUES ('agent','Agent','agent',NULL,'2026-01-01T00:00:00.000Z'); INSERT INTO sessions (id,agent_group_id,status,container_status,last_active,created_at) VALUES ('session','agent','active','stopped','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'); INSERT INTO tool_action_requests VALUES ('session','before-snapshot','2026-01-01T00:00:00.000Z'); INSERT INTO pending_approvals (approval_id,session_id,request_id,action,payload,created_at) VALUES ('stale','session','before-snapshot','tool_action','{}','2026-01-01T00:00:00.000Z')",
    );
  } finally {
    db.close();
  }
  fs.chmodSync(source, 0o600);
  const snapshot = path.join(root, 'snapshot');
  const captured = createSnapshot({
    install,
    hostConfig: config,
    output: snapshot,
    commit: 'a'.repeat(40),
    offlineAcknowledged: true,
  });
  const staging = path.join(root, 'restored');
  restoreSnapshot(snapshot, captured.manifestSha256, staging);
  const target = path.join(staging, 'install', 'data', 'v2.db');
  const change = (file: string, sql: string) => {
    const db = new Database(file);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
  };
  const add = () =>
    change(source, "INSERT INTO tool_action_requests VALUES ('session','after-snapshot','2026-01-02T00:00:00.000Z')");
  const digest = () => inspectSurvivingReservations(source, true).sourceLedgerSha256;
  return { source, staging, target, change, add, digest };
}

it('imports post-snapshot reservations idempotently without changing approvals, sessions, source or holds', () => {
  const f = fixture();
  f.add();
  const sourceBytes = fs.readFileSync(f.source);
  const report = importSurvivingReservations(f.staging, f.source, f.digest(), true);
  expect(report).toMatchObject({
    importedReservations: 1,
    preservedReservations: 2,
    externalEffectsReconciled: false,
    postSnapshotEffectsKnown: false,
    activationAllowed: false,
  });
  expect(importSurvivingReservations(f.staging, f.source, f.digest(), true)).toEqual(report);
  expect(fs.readFileSync(f.source)).toEqual(sourceBytes);
  const db = new Database(f.target, { readonly: true });
  try {
    expect(db.prepare('SELECT COUNT(*) AS n FROM pending_approvals').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT status FROM sessions').get()).toEqual({ status: 'active' });
  } finally {
    db.close();
  }
  expect(() => enforceRecoveryGate(path.join(f.staging, 'install'))).toThrow('Restored installation is held');
  const prepared = prepareRestoredState(f.staging, true);
  expect(prepared.uncertainReservations).toHaveLength(2);
  expect(prepared.invalidatedApprovals).toHaveLength(1);
  expect(prepareRestoredState(f.staging, true)).toEqual(prepared);
});

it('suppresses redelivery of a real post-snapshot HTTP write after restoring and importing reservations', async () => {
  const f = fixture();
  let writes = 0;
  const server = createServer((req, res) => {
    expect(req.headers.authorization).toBe('Bearer synthetic-private-token');
    req.resume();
    writes++;
    res.writeHead(200);
    res.end('{}');
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server');
  const config = parseToolConfiguration(
    JSON.stringify({
      schema: 'area51.tool-actions.v1',
      actions: {
        write: { url: `http://127.0.0.1:${address.port}/write`, token: 'synthetic-private-token', arguments: {} },
      },
      policy: { agent: { write: 'allow' } },
    }),
  );
  const make = (db: Database.Database) =>
    new SessionToolActions({
      configuration: () => config,
      approvers: () => [],
      approval: async () => false,
      reserve: (s, id) =>
        db.prepare('INSERT OR IGNORE INTO tool_action_requests VALUES (?,?,?)').run(s.id, id, new Date().toISOString())
          .changes === 1,
    });
  const request = { action: 'tool_action', tool: 'write', args: {}, requestId: 'after-snapshot' };
  const session = { id: 'session', agent_group_id: 'agent' };
  const source = new Database(f.source);
  try {
    expect(await make(source).request(session, request)).toMatchObject({ status: 'executed' });
  } finally {
    source.close();
  }
  expect(writes).toBe(1);
  importSurvivingReservations(f.staging, f.source, f.digest(), true);
  prepareRestoredState(f.staging, true);
  const restored = new Database(f.target);
  try {
    expect(await make(restored).request(session, request)).toEqual({ status: 'denied' });
  } finally {
    restored.close();
  }
  expect(writes).toBe(1);
  expect(() => enforceRecoveryGate(path.join(f.staging, 'install'))).toThrow('Restored installation is held');
}, 20_000);

it('requires offline acknowledgement for inspection and import', () => {
  const f = fixture();
  expect(() => inspectSurvivingReservations(f.source, false)).toThrow('offline acknowledgement');
  expect(() => importSurvivingReservations(f.staging, f.source, 'a'.repeat(64), false)).toThrow(
    'offline acknowledgement',
  );
});
it('includes committed reservations still in the surviving WAL', () => {
  const f = fixture();
  const db = new Database(f.source);
  try {
    db.pragma('journal_mode=WAL');
    db.pragma('wal_autocheckpoint=0');
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.exec("INSERT INTO tool_action_requests VALUES ('session','wal-write','2026-01-02T00:00:00.000Z')");
    expect(fs.statSync(`${f.source}-wal`).size).toBeGreaterThan(0);
    expect(inspectSurvivingReservations(f.source, true).reservations).toBe(2);
    expect(importSurvivingReservations(f.staging, f.source, f.digest(), true).importedReservations).toBe(1);
  } finally {
    db.close();
  }
});
it.skipIf(process.platform === 'win32')('refuses symlinked surviving SQLite sidecars', () => {
  const f = fixture();
  fs.symlinkSync(f.target, `${f.source}-wal`);
  expect(() => f.digest()).toThrow('sidecars');
});
it('refuses changed source evidence before modifying the target', () => {
  const f = fixture();
  const digest = f.digest();
  f.add();
  expect(() => importSurvivingReservations(f.staging, f.source, digest, true)).toThrow('digest mismatch');
  const db = new Database(f.target, { readonly: true });
  try {
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='recovery_reservation_imports'").get(),
    ).toBeUndefined();
  } finally {
    db.close();
  }
});
it.each(['missing-session', 'conflicting-time', 'missing-ledger', 'prepared', 'unheld'])(
  'refuses %s recovery state',
  (kind) => {
    const f = fixture();
    f.add();
    if (kind === 'missing-session')
      f.change(
        f.source,
        "INSERT INTO sessions (id,agent_group_id,status,container_status,last_active,created_at) VALUES ('new-session','agent','active','stopped','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'); INSERT INTO tool_action_requests VALUES ('new-session','new-write','2026-01-02T00:00:00.000Z')",
      );
    if (kind === 'conflicting-time')
      f.change(
        f.source,
        "UPDATE tool_action_requests SET created_at='2026-01-03T00:00:00.000Z' WHERE request_id='before-snapshot'",
      );
    if (kind === 'missing-ledger') f.change(f.target, 'DROP TABLE tool_action_requests');
    if (kind === 'prepared') prepareRestoredState(f.staging, true);
    if (kind === 'unheld') fs.unlinkSync(path.join(f.staging, 'install', 'data', 'recovery-hold.json'));
    expect(() => importSurvivingReservations(f.staging, f.source, f.digest(), true)).toThrow();
  },
);
it('rolls back partial inserts and audit creation after an injected failure', () => {
  const f = fixture();
  f.add();
  f.change(
    f.target,
    "CREATE TRIGGER fail_import BEFORE INSERT ON tool_action_requests WHEN NEW.request_id='after-snapshot' BEGIN SELECT RAISE(ABORT,'injected import failure'); END",
  );
  expect(() => importSurvivingReservations(f.staging, f.source, f.digest(), true)).toThrow('injected import failure');
  const db = new Database(f.target, { readonly: true });
  try {
    expect(db.prepare('SELECT COUNT(*) AS n FROM tool_action_requests').get()).toEqual({ n: 1 });
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='recovery_reservation_imports'").get(),
    ).toBeUndefined();
  } finally {
    db.close();
  }
});
it('refuses a repeated import if an imported reservation disappeared', () => {
  const f = fixture();
  f.add();
  const digest = f.digest();
  importSurvivingReservations(f.staging, f.source, digest, true);
  f.change(f.target, "DELETE FROM tool_action_requests WHERE request_id='after-snapshot'");
  expect(() => importSurvivingReservations(f.staging, f.source, digest, true)).toThrow('disappeared');
});
it('refuses staged state as its own surviving evidence', () => {
  const f = fixture();
  expect(() => importSurvivingReservations(f.staging, f.target, f.digest(), true)).toThrow('outside');
});
it.each(['audit', 'target'])('refuses repeated import with %s drift', (kind) => {
  const f = fixture();
  f.add();
  const digest = f.digest();
  importSurvivingReservations(f.staging, f.source, digest, true);
  if (kind === 'audit') f.change(f.target, "UPDATE recovery_reservation_imports SET report_json='{}'");
  else
    f.change(f.target, "INSERT INTO tool_action_requests VALUES ('session','unexpected','2026-01-03T00:00:00.000Z')");
  expect(() => importSurvivingReservations(f.staging, f.source, digest, true)).toThrow('drift');
});
it.each(["request_id='invalid/request'", "created_at='2026-02-30T00:00:00.000Z'"])(
  'refuses malformed ledger field %s',
  (assignment) => {
    const f = fixture();
    f.change(f.source, `UPDATE tool_action_requests SET ${assignment}`);
    expect(() => f.digest()).toThrow('Malformed');
  },
);
it.skipIf(process.platform === 'win32').each(['symlink', 'hardlink', 'public'])(
  'refuses unsafe %s surviving databases',
  (kind) => {
    const f = fixture();
    const digest = f.digest();
    let source = f.source;
    if (kind === 'symlink') {
      source = path.join(path.dirname(f.source), 'alias.db');
      fs.symlinkSync(f.source, source);
    }
    if (kind === 'hardlink') fs.linkSync(f.source, path.join(path.dirname(f.source), 'alias.db'));
    if (kind === 'public') fs.chmodSync(f.source, 0o644);
    expect(() => importSurvivingReservations(f.staging, source, digest, true)).toThrow();
  },
);
