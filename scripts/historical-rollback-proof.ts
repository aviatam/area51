/** Disposable hosted proof. Never activates a restore or removes its holds. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSnapshot, restoreSnapshot } from '../src/recovery-snapshot.js';

const previous = 'c3dd1e8f9ceeb0b459d2b324d05a6f66dd884356';
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Disposable GitHub runner required');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'Hosted runner required');
const repository = process.cwd();
const git = (args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
const candidate = git(['rev-parse', 'HEAD']);
assert.match(candidate, /^[a-f0-9]{40}$/);
assert.notEqual(candidate, previous);
git(['merge-base', '--is-ancestor', previous, candidate]);
const previousCheckout = fs.realpathSync(process.argv[2] ?? '');
assert.equal(execFileSync('git', ['-C', previousCheckout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), previous);
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'area51-historical-rollback-')));
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const digestFile = (file: string) => sha256(fs.readFileSync(file));

function archive(commit: string, name: string): string {
  // State roots must never be overwritten by source extraction.
  assert.equal(git(['ls-tree', '--name-only', commit, 'data', 'store', 'groups', '.env']), '');
  const file = path.join(work, name + '.tar');
  execFileSync('git', ['archive', '--format=tar', '--output', file, commit], { cwd: repository });
  return file;
}
function extract(file: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  execFileSync('tar', ['-xf', file, '-C', destination]);
}
function verifySource(commit: string, destination: string): void {
  const entries = execFileSync('git', ['ls-tree', '-rz', '--full-tree', commit], { cwd: repository })
    .toString()
    .split('\0')
    .filter(Boolean);
  for (const entry of entries) {
    const match = /^(\d+) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
    assert(match, 'Only blob source entries supported');
    const [, mode, expected, relative] = match;
    const file = path.join(destination, relative);
    const stat = fs.lstatSync(file);
    const bytes = mode === '120000' ? Buffer.from(fs.readlinkSync(file)) : fs.readFileSync(file);
    if (mode !== '120000') {
      assert(stat.isFile());
      assert.equal(!!(stat.mode & 0o100), mode === '100755');
    }
    const measured = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    assert.equal(measured, expected, `Historical source mismatch: ${relative}`);
  }
}

try {
  const oldArchive = archive(previous, 'previous-source');
  const oldArchiveDigest = digestFile(oldArchive);
  const source = path.join(work, 'previous-install');
  extract(oldArchive, source);
  verifySource(previous, source);
  const oldLockDigest = digestFile(path.join(source, 'pnpm-lock.yaml'));
  assert.equal(oldLockDigest, digestFile(path.join(previousCheckout, 'pnpm-lock.yaml')));
  // Dependencies were independently installed from this historical lock in CI.
  // They are not bundled by the host-state snapshot.
  fs.symlinkSync(path.join(previousCheckout, 'node_modules'), path.join(source, 'node_modules'), 'dir');
  const configuration = path.join(work, 'private-config');
  fs.mkdirSync(configuration, { mode: 0o700 });
  fs.writeFileSync(path.join(configuration, 'tool-actions.json'), '{"token":"synthetic-private-token"}', {
    mode: 0o600,
  });

  const helper = path.join(work, 'database-exercise.mts');
  fs.writeFileSync(
    helper,
    `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [mode, code, install] = process.argv.slice(2);
const load = (file) => import(pathToFileURL(path.join(code,file)).href);
const {initDb,closeDb}=await load('src/db/connection.ts');
const {runMigrations}=await load('src/db/migrations/index.ts');
await load('src/modules/index.ts');
const db=initDb(path.join(install,'data','v2.db'));
try {
  runMigrations(db);
  if(mode==='seed') {
    db.exec("INSERT INTO agent_groups VALUES ('agent','Historical','agent',NULL,'2026-01-01T00:00:00.000Z'); INSERT INTO sessions (id,agent_group_id,status,container_status,last_active,created_at) VALUES ('session','agent','active','stopped','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'); INSERT INTO users VALUES ('admin','slack','Synthetic administrator','2026-01-01T00:00:00.000Z'); INSERT INTO user_roles VALUES ('admin','owner',NULL,NULL,'2026-01-01T00:00:00.000Z'); INSERT INTO pending_approvals (approval_id,session_id,request_id,action,payload,created_at) VALUES ('pending','session','request','tool_action','{}','2026-01-01T00:00:00.000Z'); INSERT INTO tool_action_requests VALUES ('session','uncertain','2026-01-01T00:00:00.000Z')");
    const session=path.join(install,'data','v2-sessions','agent','session');
    fs.mkdirSync(session,{recursive:true});
    const {ensureSchema}=await load('src/db/session-db.ts');
    ensureSchema(path.join(session,'inbound.db'),'inbound');
    ensureSchema(path.join(session,'outbound.db'),'outbound');
    const {default:Database}=await load('node_modules/better-sqlite3/lib/index.js');
    const inbound=new Database(path.join(session,'inbound.db'));
    try {inbound.exec("INSERT INTO messages_in (id,seq,kind,timestamp,content) VALUES ('pending-message',2,'message','2026-01-01T00:00:00.000Z','synthetic pending input'),('scheduled-task',4,'task','2026-01-01T00:00:00.000Z','synthetic task')");} finally {inbound.close();}
    const outbound=new Database(path.join(session,'outbound.db'));
    try {outbound.exec("INSERT INTO messages_out (id,seq,kind,timestamp,content) VALUES ('undelivered',1,'message','2026-01-01T00:00:00.000Z','synthetic pending output'); INSERT INTO session_state VALUES ('provider-session','synthetic-session-id','2026-01-01T00:00:00.000Z')");} finally {outbound.close();}
    fs.writeFileSync(path.join(session,'provider.json'),'{"synthetic":"historical provider state"}');
  } else if(mode==='upgrade-failure') {
    db.exec("UPDATE agent_groups SET name='Committed candidate change'");
    assert.throws(()=>runMigrations(db,[{version:999,name:'historical-proof-injected-failure',up(connection){connection.exec("UPDATE sessions SET status='closed'; CREATE TABLE incomplete_upgrade (id TEXT)");throw new Error('Injected midway migration failure');}}]),/Injected midway migration failure/);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='incomplete_upgrade'").get(),undefined);
    assert.equal(db.prepare('SELECT status FROM sessions').get().status,'active');
  }
  assert.deepEqual(db.pragma('integrity_check'),[{integrity_check:'ok'}]);
  assert.deepEqual(db.pragma('foreign_key_check'),[]);
  const rows={};
  for(const table of ['agent_groups','sessions','users','user_roles','pending_approvals','tool_action_requests','schema_version'])
    rows[table]=db.prepare('SELECT * FROM '+table).all();
  console.log('PROOF_ROWS='+JSON.stringify(rows));
} finally {closeDb();}
`,
    { mode: 0o600 },
  );
  const runDatabase = (mode: string, code: string, install: string) => {
    const output = execFileSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(path.join(code, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href,
        helper,
        mode,
        code,
        install,
      ],
      {
        cwd: install,
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const row = output.split('\n').find((line) => line.startsWith('PROOF_ROWS='));
    assert(row, 'Database observation missing');
    return JSON.parse(row.slice('PROOF_ROWS='.length));
  };
  const baseline = runDatabase('seed', source, source);
  const version = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).version;
  fs.writeFileSync(
    path.join(source, 'data', 'upgrade-state.json'),
    JSON.stringify({ version, via: 'synthetic-proof-setup', updatedAt: '2026-01-01T00:00:00.000Z' }),
  );
  fs.mkdirSync(path.join(source, 'groups', 'agent'), { recursive: true });
  fs.writeFileSync(path.join(source, 'groups', 'agent', 'CLAUDE.md'), 'Historical synthetic instructions');
  fs.writeFileSync(path.join(source, '.env'), 'AREA51_RUNTIME_BACKEND=incus\nSYNTHETIC_CHANNEL_TOKEN=fixture\n');
  const snapshot = path.join(work, 'snapshot');
  const captured = createSnapshot({
    install: source,
    hostConfig: configuration,
    output: snapshot,
    commit: previous,
    offlineAcknowledged: true,
  });
  const upgraded = path.join(work, 'failed-upgrade');
  extract(archive(candidate, 'candidate-source'), upgraded);
  fs.symlinkSync(path.join(repository, 'node_modules'), path.join(upgraded, 'node_modules'), 'dir');
  for (const name of ['data', 'groups', '.env'])
    fs.cpSync(path.join(source, name), path.join(upgraded, name), { recursive: true });
  const failedRows = runDatabase('upgrade-failure', upgraded, upgraded);
  assert.notDeepEqual(failedRows, baseline);

  const staging = path.join(work, 'restored');
  const restored = restoreSnapshot(snapshot, captured.manifestSha256, staging);
  assert.equal(restored.commit, previous);
  const install = path.join(staging, 'install');
  assert.equal(digestFile(oldArchive), oldArchiveDigest);
  extract(oldArchive, install);
  verifySource(previous, install);
  assert.equal(digestFile(path.join(install, 'pnpm-lock.yaml')), oldLockDigest);
  fs.symlinkSync(path.join(previousCheckout, 'node_modules'), path.join(install, 'node_modules'), 'dir');
  const privatePaths = [
    '.env',
    'groups/agent/CLAUDE.md',
    'data/upgrade-state.json',
    'data/v2-sessions/agent/session/inbound.db',
    'data/v2-sessions/agent/session/outbound.db',
    'data/v2-sessions/agent/session/provider.json',
  ];
  for (const relative of privatePaths)
    assert.equal(digestFile(path.join(install, relative)), digestFile(path.join(source, relative)));
  assert.equal(
    digestFile(path.join(staging, 'host-config', 'tool-actions.json')),
    digestFile(path.join(configuration, 'tool-actions.json')),
  );
  assert.deepEqual(runDatabase('verify', install, install), baseline);

  const heldFiles = ['data/v2.db', 'data/recovery-hold.json', ...privatePaths];
  const beforeBoot = heldFiles.map((relative) => digestFile(path.join(install, relative)));
  const entrypoint = spawnSync(
    process.execPath,
    [
      '--import',
      pathToFileURL(path.join(install, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href,
      path.join(install, 'src', 'index.ts'),
    ],
    {
      cwd: install,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { PATH: process.env.PATH, CI: 'true' },
    },
  );
  assert.equal(entrypoint.error, undefined);
  assert.equal(entrypoint.signal, null);
  assert.equal(entrypoint.status, 1);
  const log = entrypoint.stdout + entrypoint.stderr;
  assert(log.includes('Restored installation is held'), 'Historical entrypoint did not reach recovery hold');
  for (const forbidden of ['Central DB initialized', 'Central DB ready', 'Delivery polls started', 'Area51 running'])
    assert(!log.includes(forbidden));
  assert.deepEqual(
    heldFiles.map((relative) => digestFile(path.join(install, relative))),
    beforeBoot,
  );
  assert(fs.existsSync(path.join(staging, 'RESTORED.json')));
  assert(!fs.existsSync(path.join(install, 'data', 'area51.sock')));
  const report = {
    schema: 'area51.historical_rollback_proof.v1',
    tested_commit: candidate,
    previous_commit: previous,
    measured_at: new Date().toISOString(),
    synthetic_data: true,
    node_version: process.version,
    source_archive_sha256: oldArchiveDigest,
    historical_lockfile_sha256: oldLockDigest,
    exact_historical_source_restored: true,
    historical_locked_dependencies_installed: true,
    candidate_code_loaded_for_failed_upgrade: true,
    injected_midway_migration_failure: true,
    failed_migration_transaction_rolled_back: true,
    committed_candidate_change_undone_by_restore: true,
    historical_database_code_reopen_verified: true,
    database_integrity_verified: true,
    configuration_sessions_roles_approvals_reservations_preserved: true,
    actual_historical_entrypoint_reached_hold: true,
    held_boot_left_state_unchanged: true,
    full_running_historical_host_tested: false,
    supported_upgrade_command_tested: false,
    live_channels_tested: false,
    native_vm_containment_rerun: false,
    external_effects_reconciled: false,
    activation_allowed: false,
  };
  fs.mkdirSync('.area51/diagnostics', { recursive: true });
  fs.writeFileSync('.area51/diagnostics/historical-rollback-proof.json', JSON.stringify(report, null, 2) + '\n');
  console.log(
    'Historical rollback: exact source/locked dependencies, populated state restore and actual held entrypoint verified. Live activation remains blocked.',
  );
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
