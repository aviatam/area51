/** Offline replay suppression only. Reservations do not prove external outcomes. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { validateHeldRestore } from './recovery-reconciliation.js';

interface Reservation {
  session_id: string;
  request_id: string;
  created_at: string;
}
function privateDatabase(file: string): string {
  const canonical = path.resolve(file);
  if (fs.realpathSync(canonical) !== canonical) throw new Error('Canonical surviving database required');
  const stat = fs.lstatSync(canonical);
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0)
    throw new Error('Private regular surviving database required');
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = `${canonical}${suffix}`;
    let state: fs.Stats;
    try {
      state = fs.lstatSync(sidecar);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!state.isFile() || state.nlink !== 1 || (state.mode & 0o077) !== 0)
      throw new Error('Private regular surviving SQLite sidecars required');
  }
  return canonical;
}
function integrity(db: Database.Database): void {
  if (
    JSON.stringify(db.pragma('integrity_check')) !== JSON.stringify([{ integrity_check: 'ok' }]) ||
    (db.pragma('foreign_key_check') as unknown[]).length
  )
    throw new Error('Reservation database integrity check failed');
}
function ledger(db: Database.Database): Reservation[] {
  const rows = db
    .prepare(
      'SELECT session_id, request_id, created_at FROM tool_action_requests ORDER BY session_id, request_id LIMIT 50001',
    )
    .all() as Reservation[];
  if (rows.length > 50000) throw new Error('Reservation ledger exceeds supported bound');
  const keys = new Set<string>();
  for (const row of rows) {
    if (
      typeof row.session_id !== 'string' ||
      !row.session_id ||
      row.session_id.length > 256 ||
      typeof row.request_id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(row.request_id) ||
      typeof row.created_at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.created_at) ||
      !Number.isFinite(Date.parse(row.created_at)) ||
      new Date(row.created_at).toISOString() !== row.created_at
    )
      throw new Error('Malformed reservation ledger');
    const key = JSON.stringify([row.session_id, row.request_id]);
    if (keys.has(key)) throw new Error('Duplicate reservation identity');
    keys.add(key);
  }
  return rows;
}
const digest = (rows: Reservation[]) => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
function readSurvivingLedger(file: string, offline: boolean) {
  if (!offline) throw new Error('Explicit offline acknowledgement required');
  const canonical = privateDatabase(file);
  const db = new Database(canonical, { readonly: true, fileMustExist: true });
  try {
    return db.transaction(() => {
      integrity(db);
      const rows = ledger(db);
      return { canonical, rows, sha256: digest(rows) };
    })();
  } finally {
    db.close();
  }
}

/** Prints no request identifiers. The digest binds logical rows, including WAL
 * state observed by SQLite, rather than hashing only the main database file. */
export function inspectSurvivingReservations(file: string, offline: boolean) {
  const source = readSurvivingLedger(file, offline);
  return {
    schema: 'area51.surviving-reservations.v1',
    sourceLedgerSha256: source.sha256,
    reservations: source.rows.length,
    externalEffectsReconciled: false,
    activationAllowed: false,
  };
}

export function importSurvivingReservations(
  staging: string,
  sourceFile: string,
  expectedDigest: string,
  offline: boolean,
) {
  if (!/^[a-f0-9]{64}$/.test(expectedDigest)) throw new Error('Expected surviving ledger digest required');
  const { root, hold, file } = validateHeldRestore(staging, offline);
  const canonical = privateDatabase(sourceFile);
  const relative = path.relative(root, canonical);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)))
    throw new Error('Surviving database must be outside the staged restore');
  const source = readSurvivingLedger(canonical, offline);
  if (source.sha256 !== expectedDigest) throw new Error('Surviving reservation ledger digest mismatch');
  const db = new Database(file, { fileMustExist: true });
  try {
    db.pragma('foreign_keys=ON');
    return db
      .transaction(() => {
        integrity(db);
        const prepared = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='recovery_preparation'")
          .get();
        if (prepared) throw new Error('Import reservations before offline preparation; keep held');
        ledger(db); // Missing/older ledger schemas fail before any audit creation.
        const session = db.prepare('SELECT id FROM sessions WHERE id=?');
        const existing = db.prepare('SELECT created_at FROM tool_action_requests WHERE session_id=? AND request_id=?');
        for (const row of source.rows) {
          if (!session.get(row.session_id))
            throw new Error('Surviving reservation refers to a session absent from restore');
          const old = existing.get(row.session_id, row.request_id) as { created_at: string } | undefined;
          if (old && old.created_at !== row.created_at)
            throw new Error('Conflicting reservation provenance; keep held');
        }
        db.exec(
          'CREATE TABLE IF NOT EXISTS recovery_reservation_imports (manifest_sha256 TEXT NOT NULL, source_digest TEXT NOT NULL, report_json TEXT NOT NULL, PRIMARY KEY(manifest_sha256,source_digest))',
        );
        const prior = db
          .prepare('SELECT report_json FROM recovery_reservation_imports WHERE manifest_sha256=? AND source_digest=?')
          .get(hold.manifestSha256, source.sha256) as { report_json: string } | undefined;
        if (prior) {
          for (const row of source.rows)
            if (!existing.get(row.session_id, row.request_id))
              throw new Error('Imported reservation disappeared; keep held');
          return JSON.parse(prior.report_json);
        }
        let imported = 0;
        const insert = db.prepare(
          'INSERT OR IGNORE INTO tool_action_requests (session_id,request_id,created_at) VALUES (?,?,?)',
        );
        for (const row of source.rows) imported += insert.run(row.session_id, row.request_id, row.created_at).changes;
        const rows = ledger(db); // Enforce union bound; transaction rolls back on excess.
        const report = {
          schema: 'area51.recovery-reservation-import.v1',
          manifestSha256: hold.manifestSha256,
          commit: hold.commit,
          importedAt: new Date().toISOString(),
          sourceLedgerSha256: source.sha256,
          sourceReservations: source.rows.length,
          importedReservations: imported,
          preservedReservations: rows.length,
          externalEffectsReconciled: false,
          postSnapshotEffectsKnown: false,
          activationAllowed: false,
        };
        db.prepare('INSERT INTO recovery_reservation_imports VALUES (?,?,?)').run(
          hold.manifestSha256,
          source.sha256,
          JSON.stringify(report),
        );
        return report;
      })
      .immediate();
  } finally {
    db.close();
  }
}
