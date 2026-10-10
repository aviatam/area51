import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { getRegisteredMigrations, runMigrations } from './db/migrations/index.js';
import './modules/tool-actions/index.js';
import { INBOUND_SCHEMA } from './db/schema.js';
import { createSnapshot, restoreSnapshot } from './recovery-snapshot.js';
import { enforceRecoveryGate } from './recovery-gate.js';
import { prepareRestoredState } from './recovery-reconciliation.js';

const fixtures: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of fixtures.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function populatedRestore(older = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'area51-prepared-drift-')));
  fixtures.push(root);
  const install = path.join(root, 'source');
  const config = path.join(root, 'config');
  const session = path.join(install, 'data', 'v2-sessions', 'agent', 'session');
  fs.mkdirSync(session, { recursive: true });
  fs.mkdirSync(config);
  const db = new Database(path.join(install, 'data', 'v2.db'));
  try {
    runMigrations(
      db,
      getRegisteredMigrations().filter((m) => !older || m.name !== 'module:tool-actions:request-reservations'),
    );
    db.exec(`INSERT INTO agent_groups VALUES ('agent','Original','agent',NULL,'2026-01-01');
      INSERT INTO sessions (id,agent_group_id,status,container_status,last_active,created_at)
        VALUES ('session','agent','active','stopped','2026-01-01','2026-01-01');
      INSERT INTO pending_approvals (approval_id,session_id,request_id,action,payload,created_at)
        VALUES ('approval','session','request','tool_action','{}','2026-01-01');`);
    if (!older) db.exec("INSERT INTO tool_action_requests VALUES ('session','uncertain','2026-01-01')");
  } finally {
    db.close();
  }
  const inbound = new Database(path.join(session, 'inbound.db'));
  inbound.exec(INBOUND_SCHEMA);
  inbound.exec(`INSERT INTO messages_in (id,seq,kind,timestamp,content) VALUES
    ('queued',2,'message','2026-01-01','pending input'),
    ('scheduled',4,'task','2026-01-01','scheduled input');`);
  inbound.close();
  fs.writeFileSync(path.join(session, 'provider.json'), '{"synthetic":"state"}');
  fs.writeFileSync(path.join(config, 'tool-actions.json'), '{"token":"synthetic-private-token"}');
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
  const file = path.join(staging, 'install', 'data', 'v2.db');
  const change = (sql: string) => {
    const db = new Database(file);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
  };
  return { staging, file, change, session: path.join(staging, 'install', 'data', 'v2-sessions', 'agent', 'session') };
}

it('binds populated preparation to logical database and private payload without activating or consuming queued work', () => {
  const f = populatedRestore();
  const before = fs.readFileSync(path.join(f.session, 'inbound.db'));
  const report = prepareRestoredState(f.staging, true);
  expect(report).toMatchObject({
    schema: 'area51.recovery-preparation.v2',
    activationAllowed: false,
    externalEffectsReconciled: false,
    sessionQueuesReconciled: false,
  });
  expect(report.invalidatedApprovals).toHaveLength(1);
  expect(report.uncertainReservations).toHaveLength(1);
  expect(report.centralStateSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(report.payloadStateSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(prepareRestoredState(f.staging, true)).toEqual(report);
  expect(fs.readFileSync(path.join(f.session, 'inbound.db'))).toEqual(before);
  expect(() => enforceRecoveryGate(path.join(f.staging, 'install'))).toThrow('Restored installation is held');
});

it.each([
  "INSERT INTO tool_action_requests VALUES ('session','post-snapshot','2026-01-02')",
  'DELETE FROM tool_action_requests',
  "UPDATE tool_action_requests SET created_at='2026-01-02'",
  "UPDATE sessions SET status='closed'",
  "UPDATE agent_groups SET name='changed'",
  'CREATE TABLE unexpected_state (id TEXT)',
])('refuses stale preparation after central drift: %s', (sql) => {
  const f = populatedRestore();
  const previous = prepareRestoredState(f.staging, true);
  f.change(sql);
  expect(() => prepareRestoredState(f.staging, true)).toThrow('state changed');
  const db = new Database(f.file, { readonly: true });
  try {
    const audit = db.prepare('SELECT report_json FROM recovery_preparation').get() as { report_json: string };
    expect(JSON.parse(audit.report_json)).toEqual(previous);
  } finally {
    db.close();
  }
  expect(() => enforceRecoveryGate(path.join(f.staging, 'install'))).toThrow('Restored installation is held');
});

it.each(['queue', 'task', 'provider', 'config', 'addition', 'deletion'])('refuses %s payload drift', (kind) => {
  const f = populatedRestore();
  prepareRestoredState(f.staging, true);
  if (kind === 'queue' || kind === 'task') {
    const db = new Database(path.join(f.session, 'inbound.db'));
    db.prepare('UPDATE messages_in SET content=? WHERE id=?').run('changed', kind === 'queue' ? 'queued' : 'scheduled');
    db.close();
  } else if (kind === 'provider') fs.writeFileSync(path.join(f.session, 'provider.json'), '{"changed":true}');
  else if (kind === 'config')
    fs.writeFileSync(path.join(f.staging, 'host-config', 'tool-actions.json'), '{"changed":true}');
  else if (kind === 'addition') fs.writeFileSync(path.join(f.session, 'new-work.json'), '{}', { mode: 0o600 });
  else fs.unlinkSync(path.join(f.session, 'provider.json'));
  expect(() => prepareRestoredState(f.staging, true)).toThrow('state changed');
});

it('rejects unbound legacy audit records rather than silently refreshing them', () => {
  const f = populatedRestore();
  const report = prepareRestoredState(f.staging, true);
  f.change(
    `UPDATE recovery_preparation SET report_json='${JSON.stringify({ ...report, schema: 'area51.recovery-preparation.v1' })}'`,
  );
  expect(() => prepareRestoredState(f.staging, true)).toThrow('lacks drift binding');
});

it('keeps older missing-ledger restores explicitly uncertain and held', () => {
  const f = populatedRestore(true);
  expect(prepareRestoredState(f.staging, true)).toMatchObject({
    reservationLedgerPresent: false,
    postSnapshotEffectsKnown: false,
    activationAllowed: false,
  });
  expect(() => enforceRecoveryGate(path.join(f.staging, 'install'))).toThrow('Restored installation is held');
});

it('rolls back approval invalidation and audit creation when payload changes during preparation', () => {
  const f = populatedRestore();
  const original = fs.openSync;
  let reads = 0;
  vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
    const result = original(...args);
    if (args[0] === path.join(f.session, 'provider.json') && ++reads === 1)
      fs.writeFileSync(path.join(f.session, 'new-work.json'), '{}', { mode: 0o600 });
    return result;
  });
  expect(() => prepareRestoredState(f.staging, true)).toThrow('changed during preparation');
  const db = new Database(f.file, { readonly: true });
  try {
    expect(db.prepare('SELECT COUNT(*) AS n FROM pending_approvals').get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='recovery_preparation'").get()).toBeUndefined();
  } finally {
    db.close();
  }
});

it.skipIf(process.platform === 'win32').each(['symlink', 'hardlink', 'public'])(
  'rejects unsafe %s payloads',
  (kind) => {
    const f = populatedRestore();
    const provider = path.join(f.session, 'provider.json');
    if (kind === 'symlink') fs.symlinkSync(provider, path.join(f.session, 'alias'));
    else if (kind === 'hardlink') fs.linkSync(provider, path.join(f.session, 'alias'));
    else fs.chmodSync(provider, 0o644);
    expect(() => prepareRestoredState(f.staging, true)).toThrow(/private|regular/i);
  },
);

it('requires an explicit offline acknowledgement before accessing state', () => {
  expect(() => prepareRestoredState('/does-not-exist', false)).toThrow('offline acknowledgement');
});
it.each(['corrupt', 'mismatched', 'activation-edited'])(
  'refuses %s restore provenance before opening a database',
  (kind) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'area51-reconcile-test-')));
    try {
      fs.mkdirSync(path.join(root, 'install', 'data'), { recursive: true });
      const common = { commit: 'a'.repeat(40), manifestSha256: 'b'.repeat(64), activationAllowed: false };
      fs.writeFileSync(
        path.join(root, 'RESTORED.json'),
        JSON.stringify({ ...common, schema: 'area51.host-state-restored.v1' }),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(root, 'install', 'data', 'recovery-hold.json'),
        kind === 'corrupt'
          ? '{'
          : JSON.stringify({
              ...common,
              schema: 'area51.recovery-hold.v1',
              ...(kind === 'mismatched' ? { commit: 'c'.repeat(40) } : { activationAllowed: true }),
            }),
        { mode: 0o600 },
      );
      expect(() => prepareRestoredState(root, true)).toThrow();
      expect(fs.existsSync(path.join(root, 'install', 'data', 'v2.db'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
