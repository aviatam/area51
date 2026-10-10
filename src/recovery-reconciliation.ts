/** Offline preparation only. Never releases a restore hold or dispatches work. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { RECOVERY_HOLD_FILE, enforceRecoveryGate } from './recovery-gate.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function privateFileDigest(file: string): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0)
      throw new Error('Private regular restored payload required');
    const measured = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let size = 0;
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      measured.update(buffer.subarray(0, count));
      size += count;
    }
    const after = fs.fstatSync(fd);
    if (before.size !== size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error('Restored payload changed during preparation');
    return measured.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

/** Logical central state: excludes only our audit table, not roles or reservations.
 * Sorting serialized rows avoids dependence on SQLite's unspecified row order. */
function centralStateDigest(db: Database.Database): string {
  const schema = db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name != 'recovery_preparation' ORDER BY type, name",
    )
    .all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
  const tables = schema.filter((entry) => entry.type === 'table');
  return hash(
    JSON.stringify({
      schema,
      rows: tables.map(({ name }) => ({
        name,
        rows: db
          .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
          .safeIntegers(true)
          .all()
          .map((row) =>
            JSON.stringify(row, (_key, value) =>
              typeof value === 'bigint' ? { sqliteInteger: value.toString() } : value,
            ),
          )
          .sort(),
      })),
    }),
  );
}

/** Inventory offline restore payload, including queues/provider state/config.
 * Central SQLite bytes/sidecars are excluded: its logical state is measured
 * within the transaction instead. This is drift detection, not quiescence or
 * external-effect attestation. No symlinks, hard links or public files allowed. */
function payloadStateDigest(root: string): string {
  const entries: Array<{ path: string; mode: number; digest?: string }> = [];
  const excluded = new Set([
    'install/data/v2.db',
    'install/data/v2.db-wal',
    'install/data/v2.db-shm',
    'install/data/v2.db-journal',
  ]);
  const visit = (relative: string) => {
    const file = path.join(root, relative);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return;
    if (fs.realpathSync(file) !== file || (stat.mode & 0o077) !== 0)
      throw new Error('Canonical private restored payload required');
    const name = relative.split(path.sep).join('/');
    if (stat.isDirectory()) {
      entries.push({ path: name, mode: stat.mode & 0o777 });
      for (const child of fs.readdirSync(file).sort()) visit(path.join(relative, child));
    } else {
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Private regular restored payload required');
      if (excluded.has(name)) return;
      entries.push({ path: name, mode: stat.mode & 0o777, digest: privateFileDigest(file) });
    }
  };
  for (const relative of [
    'install/data',
    'install/store',
    'install/groups',
    'install/.env',
    'host-config',
    'RESTORED.json',
  ])
    visit(relative);
  return hash(JSON.stringify(entries));
}

export function prepareRestoredState(staging: string, offlineAcknowledged: boolean) {
  if (!offlineAcknowledged) throw new Error('Explicit offline acknowledgement required');
  const root = path.resolve(staging);
  if (fs.realpathSync(root) !== root || root === path.parse(root).root)
    throw new Error('Canonical staging directory required');
  const regular = (file: string) => {
    if (fs.realpathSync(file) !== file) throw new Error('Canonical restored file required');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0)
      throw new Error('Private regular restored file required');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };
  const install = path.join(root, 'install');
  const hold = regular(path.join(install, 'data', RECOVERY_HOLD_FILE));
  const restored = regular(path.join(root, 'RESTORED.json'));
  if (
    hold.schema !== 'area51.recovery-hold.v1' ||
    restored.schema !== 'area51.host-state-restored.v1' ||
    hold.activationAllowed !== false ||
    restored.activationAllowed !== false ||
    !/^[a-f0-9]{64}$/.test(hold.manifestSha256) ||
    hold.manifestSha256 !== restored.manifestSha256 ||
    !/^[a-f0-9]{40}$/.test(hold.commit) ||
    hold.commit !== restored.commit
  )
    throw new Error('Matching held restore provenance required');
  const file = path.join(install, 'data', 'v2.db');
  if (fs.realpathSync(file) !== file) throw new Error('Canonical database required');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0)
    throw new Error('Private regular database required');
  const db = new Database(file, { fileMustExist: true });
  try {
    db.pragma('foreign_keys=ON');
    if (
      JSON.stringify(db.pragma('integrity_check')) !== JSON.stringify([{ integrity_check: 'ok' }]) ||
      (db.pragma('foreign_key_check') as unknown[]).length !== 0
    )
      throw new Error('Database integrity check failed');
    const report = db
      .transaction(() => {
        const payloadDigest = payloadStateDigest(root);
        db.exec(
          'CREATE TABLE IF NOT EXISTS recovery_preparation (manifest_sha256 TEXT PRIMARY KEY, report_json TEXT NOT NULL)',
        );
        const previous = db
          .prepare('SELECT report_json FROM recovery_preparation WHERE manifest_sha256=?')
          .get(hold.manifestSha256) as { report_json: string } | undefined;
        if (previous) {
          if ((db.prepare('SELECT COUNT(*) AS n FROM pending_approvals').get() as { n: number }).n !== 0)
            throw new Error('Approvals appeared after offline preparation; keep held');
          const saved = JSON.parse(previous.report_json);
          if (
            saved.schema !== 'area51.recovery-preparation.v2' ||
            saved.manifestSha256 !== hold.manifestSha256 ||
            saved.commit !== hold.commit ||
            saved.activationAllowed !== false ||
            saved.externalEffectsReconciled !== false ||
            saved.postSnapshotEffectsKnown !== false ||
            saved.sessionQueuesReconciled !== false ||
            saved.scheduledWorkReconciled !== false ||
            saved.centralStateSha256 !== centralStateDigest(db) ||
            saved.payloadStateSha256 !== payloadDigest
          )
            throw new Error('Prepared restore state changed or lacks drift binding; keep held');
          if (payloadStateDigest(root) !== payloadDigest)
            throw new Error('Restored payload changed during preparation');
          return saved;
        }
        const ledgerPresent = !!db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tool_action_requests'")
          .get();
        const result = {
          schema: 'area51.recovery-preparation.v2',
          manifestSha256: hold.manifestSha256,
          commit: hold.commit,
          preparedAt: new Date().toISOString(),
          invalidatedApprovals: db
            .prepare('SELECT approval_id, session_id, action FROM pending_approvals ORDER BY approval_id')
            .all(),
          reservationLedgerPresent: ledgerPresent,
          uncertainReservations: ledgerPresent
            ? db
                .prepare(
                  'SELECT session_id, request_id, created_at FROM tool_action_requests ORDER BY session_id, request_id',
                )
                .all()
            : [],
          restoredSessions: db.prepare('SELECT id, status, container_status FROM sessions ORDER BY id').all(),
          reservationsPreserved: true,
          activationAllowed: false,
          externalEffectsReconciled: false,
          postSnapshotEffectsKnown: false,
          sessionQueuesReconciled: false,
          scheduledWorkReconciled: false,
          centralStateSha256: '',
          payloadStateSha256: payloadDigest,
        };
        db.exec('DELETE FROM pending_approvals');
        result.centralStateSha256 = centralStateDigest(db);
        if (payloadStateDigest(root) !== payloadDigest) throw new Error('Restored payload changed during preparation');
        db.prepare('INSERT INTO recovery_preparation VALUES (?,?)').run(hold.manifestSha256, JSON.stringify(result));
        return result;
      })
      .immediate();
    // Assert the operation has not altered either hold marker.
    try {
      enforceRecoveryGate(install);
    } catch (error) {
      if ((error as Error).message.includes('Restored installation is held')) return report;
      throw error;
    }
    throw new Error('Restore hold unexpectedly missing');
  } finally {
    db.close();
  }
}
