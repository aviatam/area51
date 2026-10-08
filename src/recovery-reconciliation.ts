/** Offline preparation only. Never releases a restore hold or dispatches work. */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { RECOVERY_HOLD_FILE, enforceRecoveryGate } from './recovery-gate.js';

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
        db.exec(
          'CREATE TABLE IF NOT EXISTS recovery_preparation (manifest_sha256 TEXT PRIMARY KEY, report_json TEXT NOT NULL)',
        );
        const previous = db
          .prepare('SELECT report_json FROM recovery_preparation WHERE manifest_sha256=?')
          .get(hold.manifestSha256) as { report_json: string } | undefined;
        if (previous) {
          if ((db.prepare('SELECT COUNT(*) AS n FROM pending_approvals').get() as { n: number }).n !== 0)
            throw new Error('Approvals appeared after offline preparation; keep held');
          return JSON.parse(previous.report_json);
        }
        const ledgerPresent = !!db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tool_action_requests'")
          .get();
        const result = {
          schema: 'area51.recovery-preparation.v1',
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
        };
        db.prepare('INSERT INTO recovery_preparation VALUES (?,?)').run(hold.manifestSha256, JSON.stringify(result));
        db.exec('DELETE FROM pending_approvals');
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
