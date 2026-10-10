/** Real SQLite recovery evidence; all credentials and data are synthetic. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getRegisteredMigrations, runMigrations } from '../src/db/migrations/index.js';
import '../src/modules/tool-actions/index.js';
import { createSnapshot, restoreSnapshot } from '../src/recovery-snapshot.js';
import { prepareRestoredState } from '../src/recovery-reconciliation.js';
import { enforceRecoveryGate } from '../src/recovery-gate.js';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-state-proof-'));
const install = path.join(work, 'install');
const config = path.join(work, 'config');
fs.mkdirSync(path.join(install, 'data'), { recursive: true });
fs.mkdirSync(path.join(install, 'groups', 'agent'), { recursive: true });
fs.mkdirSync(config);
const dbFile = path.join(install, 'data', 'v2.db');
const list = getRegisteredMigrations();
const reservationMigration = 'module:tool-actions:request-reservations';
assert(list.some((migration) => migration.name === reservationMigration));
let db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// Exercise the PR45 -> PR46 module-migration boundary with populated core state.
const previous = list.filter((migration) => migration.name !== reservationMigration);
runMigrations(db, previous);
db.exec(`INSERT INTO agent_groups VALUES ('agent','Original','agent',NULL,'2026-01-01');
  INSERT INTO sessions (id,agent_group_id,status,container_status,last_active,created_at)
    VALUES ('session','agent','active','stopped','2026-01-01','2026-01-01');
  INSERT INTO pending_approvals (approval_id,session_id,request_id,action,payload,created_at)
    VALUES ('pending','session','request','tool_action','{}','2026-01-01');
  INSERT INTO users VALUES ('admin','slack','Administrator','2026-01-01');
  INSERT INTO user_roles VALUES ('admin','owner',NULL,NULL,'2026-01-01');`);
const baselineRows = JSON.stringify({
  agents: db.prepare('SELECT * FROM agent_groups').all(),
  sessions: db.prepare('SELECT * FROM sessions').all(),
  approvals: db.prepare('SELECT * FROM pending_approvals').all(),
  roles: db.prepare('SELECT * FROM user_roles').all(),
});
db.close();
// Abrupt child exit leaves committed WAL frames rather than a clean checkpoint.
execFileSync(process.execPath, [
  '-e',
  `
  const Database = require('better-sqlite3');
  const db = new Database(process.argv[1]);
  db.pragma('journal_mode=WAL'); db.pragma('wal_autocheckpoint=0');
  db.exec("CREATE TABLE recovery_wal_fixture (value TEXT); INSERT INTO recovery_wal_fixture VALUES ('committed-before-crash')");
  process.exit(0);
`,
  dbFile,
]);
assert(fs.statSync(dbFile + '-wal').size > 0);
fs.writeFileSync(path.join(install, '.env'), 'SYNTHETIC_CHANNEL_TOKEN=fixture');
fs.writeFileSync(path.join(install, 'groups', 'agent', 'CLAUDE.md'), 'Preserved agent instructions');
fs.writeFileSync(path.join(config, 'tool-actions.json'), '{"token":"synthetic-private-token"}');
fs.writeFileSync(path.join(install, 'data', 'upgrade-state.json'), '{"version":"2.2.1","via":"fixture-previous"}');
const first = createSnapshot({
  install,
  hostConfig: config,
  output: path.join(work, 'previous'),
  commit: 'f9b7c12015e3d8530db026c91f38e00cb4e04544',
  offlineAcknowledged: true,
});
db = new Database(dbFile);
db.pragma('foreign_keys = ON');
runMigrations(db, list);
runMigrations(db, list);
assert.equal(
  (db.prepare('SELECT COUNT(*) AS n FROM schema_version WHERE name=?').get(reservationMigration) as { n: number }).n,
  1,
);
const rows = () =>
  JSON.stringify({
    agents: db.prepare('SELECT * FROM agent_groups').all(),
    sessions: db.prepare('SELECT * FROM sessions').all(),
    approvals: db.prepare('SELECT * FROM pending_approvals').all(),
    roles: db.prepare('SELECT * FROM user_roles').all(),
  });
assert.equal(rows(), baselineRows);
assert.throws(
  () =>
    runMigrations(db, [
      {
        version: 999,
        name: 'recovery-proof-failure',
        up(connection) {
          connection.exec("UPDATE agent_groups SET name='partial-upgrade'; CREATE TABLE incomplete_upgrade (id TEXT)");
          throw new Error('Injected migration failure');
        },
      },
    ]),
  /Injected migration failure/,
);
assert.equal(rows(), baselineRows);
assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='incomplete_upgrade'").get(), undefined);
db.prepare('INSERT INTO tool_action_requests VALUES (?,?,?)').run('session', 'already-dispatched', '2026-01-01');
db.close();
const second = createSnapshot({
  install,
  hostConfig: config,
  output: path.join(work, 'current'),
  commit: '02c3717b1ac06f5ab4b30711772cd73d05e8ceb3',
  offlineAcknowledged: true,
});
db = new Database(dbFile);
db.exec("UPDATE agent_groups SET name='newer-state'; DELETE FROM tool_action_requests");
db.close();
restoreSnapshot(path.join(work, 'previous'), first.manifestSha256, path.join(work, 'rollback'));
db = new Database(path.join(work, 'rollback', 'install', 'data', 'v2.db'));
assert.equal(rows(), baselineRows);
assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
assert.deepEqual(db.pragma('foreign_key_check'), []);
assert.deepEqual(db.prepare('SELECT * FROM recovery_wal_fixture').all(), [{ value: 'committed-before-crash' }]);
assert.equal(db.prepare('SELECT name FROM sqlite_master WHERE name=?').get('tool_action_requests'), undefined);
runMigrations(db, previous); // Older schema can reopen and repeat its migrations.
assert.equal(rows(), baselineRows);
db.close();
restoreSnapshot(path.join(work, 'current'), second.manifestSha256, path.join(work, 'recovered'));
db = new Database(path.join(work, 'recovered', 'install', 'data', 'v2.db'));
db.pragma('foreign_keys = ON');
runMigrations(db, list);
assert.equal(rows(), baselineRows);
assert.equal(
  db
    .prepare('INSERT OR IGNORE INTO tool_action_requests VALUES (?,?,?)')
    .run('session', 'already-dispatched', '2026-01-02').changes,
  0,
);
assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
assert.deepEqual(db.pragma('foreign_key_check'), []);
db.close();
assert.equal(
  fs.readFileSync(path.join(work, 'recovered', 'host-config', 'tool-actions.json'), 'utf8'),
  '{"token":"synthetic-private-token"}',
);
const sha = process.env.GITHUB_SHA ?? 'local';
const staging = path.join(work, 'recovered');
assert.throws(() => prepareRestoredState(staging, false), /offline acknowledgement/);
// An injected invalidation failure must roll back the durable audit AND deletion.
db = new Database(path.join(staging, 'install', 'data', 'v2.db'));
db.exec(
  "CREATE TRIGGER fail_invalidation BEFORE DELETE ON pending_approvals BEGIN SELECT RAISE(ABORT, 'injected invalidation failure'); END",
);
db.close();
assert.throws(() => prepareRestoredState(staging, true), /injected invalidation failure/);
db = new Database(path.join(staging, 'install', 'data', 'v2.db'));
assert.equal((db.prepare('SELECT COUNT(*) AS n FROM pending_approvals').get() as { n: number }).n, 1);
assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='recovery_preparation'").get(), undefined);
db.exec('DROP TRIGGER fail_invalidation');
db.close();
const preparation = prepareRestoredState(staging, true);
assert.equal(preparation.invalidatedApprovals.length, 1);
assert.equal(preparation.uncertainReservations.length, 1);
assert.equal(preparation.activationAllowed, false);
assert.equal(preparation.externalEffectsReconciled, false);
assert.deepEqual(prepareRestoredState(staging, true), preparation);
assert.match(preparation.centralStateSha256, /^[a-f0-9]{64}$/);
assert.match(preparation.payloadStateSha256, /^[a-f0-9]{64}$/);
const driftStaging = path.join(work, 'drift-check');
restoreSnapshot(path.join(work, 'current'), second.manifestSha256, driftStaging);
prepareRestoredState(driftStaging, true);
const driftDb = new Database(path.join(driftStaging, 'install', 'data', 'v2.db'));
driftDb.exec("INSERT INTO tool_action_requests VALUES ('session','after-preparation','2026-01-03')");
driftDb.close();
assert.throws(() => prepareRestoredState(driftStaging, true), /state changed/);
assert.throws(() => enforceRecoveryGate(path.join(driftStaging, 'install')), /Restored installation is held/);
assert.throws(() => enforceRecoveryGate(path.join(staging, 'install')), /Restored installation is held/);
db = new Database(path.join(staging, 'install', 'data', 'v2.db'));
assert.equal((db.prepare('SELECT COUNT(*) AS n FROM pending_approvals').get() as { n: number }).n, 0);
assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tool_action_requests').get() as { n: number }).n, 1);
assert.deepEqual(db.prepare('SELECT status FROM sessions').all(), [{ status: 'active' }]);
db.exec(
  "INSERT INTO pending_approvals (approval_id,session_id,request_id,action,payload,created_at) VALUES ('new','session','new','tool_action','{}','2026-01-02')",
);
db.close();
assert.throws(() => prepareRestoredState(staging, true), /Approvals appeared/);
const olderPreparation = prepareRestoredState(path.join(work, 'rollback'), true);
assert.equal(olderPreparation.reservationLedgerPresent, false);
assert.equal(olderPreparation.postSnapshotEffectsKnown, false);
const report = {
  schema: 'area51.host_state_recovery_proof.v1',
  tested_commit: sha,
  measured_at: new Date().toISOString(),
  migration_boundary: 'PR45-to-PR46-tool-reservations',
  real_sqlite: true,
  committed_wal_recovered: true,
  synthetic_data: true,
  populated_groups_sessions_approvals_roles_preserved: true,
  repeat_migrations_idempotent: true,
  failed_migration_transaction_rolled_back: true,
  previous_schema_restore_verified: true,
  current_schema_restore_verified: true,
  database_integrity_verified: true,
  durable_request_reservations_preserved: true,
  private_configuration_preserved: true,
  restored_approvals_invalidated_with_durable_audit: true,
  preparation_failure_transaction_rolled_back: true,
  repeated_preparation_idempotent: true,
  preparation_state_digest_bound: true,
  changed_reservation_after_preparation_refused: true,
  new_approval_after_preparation_refused: true,
  preparation_preserved_reservations_sessions_and_hold: true,
  older_missing_reservation_ledger_explicit: true,
  activation_allowed: false,
  incus_disks_restored: false,
  external_writes_reconciled: false,
  full_historical_code_boot_tested: false,
};
fs.mkdirSync('.area51/diagnostics', { recursive: true });
fs.writeFileSync('.area51/diagnostics/host-state-recovery-proof.json', JSON.stringify(report, null, 2) + '\n');
console.log(
  'Host-state recovery: populated SQLite migration, injected failure, previous/current restore and reservation checks passed.',
);
// Only this exact synthetic mkdtemp directory is removed. No real installation is touched.
fs.rmSync(work, { recursive: true, force: true });
