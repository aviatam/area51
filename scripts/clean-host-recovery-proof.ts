/** Synthetic root disk + custom volume + host-state transfer between CI runners. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { parse as parseYaml } from 'yaml';
import { getRegisteredMigrations, runMigrations } from '../src/db/migrations/index.js';
import '../src/modules/index.js';
import { createSnapshot, restoreSnapshot } from '../src/recovery-snapshot.js';
import { enforceRecoveryGate } from '../src/recovery-gate.js';
import { assertSeparateRecoveryRunners, identifyRecoveryRunner } from './recovery-runner-identity.js';

const runId = process.env.GITHUB_RUN_ID;
assert(runId && /^\d+$/.test(runId), 'Only a disposable GitHub runner may run this proof');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
const mode = process.argv[2];
assert(mode === 'export' || mode === 'restore');
const repo = process.cwd();
const bundleDir = path.resolve('.area51/recovery-transfer');
const volume = `area51-recovery-state-${runId}`;
const restoredVm = `area51-restored-${runId}`;
const incus = (args: string[]) =>
  execFileSync('incus', args, { encoding: 'utf8', timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
const runnerIdentity = identifyRecoveryRunner({
  machineId: fs.readFileSync('/etc/machine-id', 'utf8'),
  bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8'),
  hostname: os.hostname(),
  environment: process.env.RUNNER_ENVIRONMENT,
  job: process.env.GITHUB_JOB,
});
async function hash(file: string) {
  const digest = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
async function ready(instance: string) {
  for (let n = 0; n < 90; n++) {
    const probe = spawnSync('incus', ['exec', instance, '--', 'true'], { timeout: 10_000, stdio: 'ignore' });
    if (probe.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('Recovered guest did not become ready');
}
async function stopFromGuest(instance: string) {
  // The hosted VM's ACPI stop path can time out. A guest-initiated, flushed
  // systemd shutdown must actually reach Stopped; never force a backup through.
  incus(['exec', instance, '--', 'sh', '-c', 'nohup sh -c "sleep 1; sync; systemctl poweroff" >/dev/null 2>&1 &']);
  for (let n = 0; n < 90; n++) {
    const state = JSON.parse(incus(['list', instance, '--format', 'json']));
    assert.equal(state.length, 1);
    if (state[0].status === 'Stopped') return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('Guest-initiated shutdown did not reach Stopped; refusing backup');
}

if (mode === 'export') {
  assert.equal(runnerIdentity.job, 'vm-image');
  const vm = `area51-vm-image-smoke-${runId}`;
  const info = JSON.parse(incus(['list', vm, '--format', 'json']));
  assert.equal(info.length, 1);
  assert.equal(info[0].type, 'virtual-machine');
  const attached = parseYaml(incus(['config', 'show', vm, '--expanded'])).devices;
  assert.equal(attached['recovery-state'].source, volume);
  assert.equal(attached['recovery-state'].path, '/workspace/recovery-proof');
  const seed = `
    import fs from 'node:fs'; import { Database } from 'bun:sqlite';
    fs.writeFileSync('/etc/area51/recovery-root-marker','synthetic-root-disk-preserved');
    fs.mkdirSync('/workspace/recovery-proof/.claude',{recursive:true});
    fs.writeFileSync('/workspace/recovery-proof/.claude/provider-state.json','{"session":"synthetic-provider-session"}');
    const db=new Database('/workspace/recovery-proof/outbound.db');
    db.exec("CREATE TABLE pending_work (id TEXT PRIMARY KEY, payload TEXT); INSERT INTO pending_work VALUES ('restored-request','synthetic-pending-action')"); db.close();
    console.log('synthetic-recovery-state-seeded');
  `;
  assert.equal(incus(['exec', vm, '--', 'bun', '-e', seed]).trim(), 'synthetic-recovery-state-seeded');
  await stopFromGuest(vm);
  // The exported VM is networkless. Do not export permissive image NICs.
  incus(['config', 'device', 'add', vm, 'eth0', 'none']);
  const devices = parseYaml(incus(['config', 'show', vm, '--expanded'])).devices;
  assert(!Object.values(devices).some((device: any) => device.type === 'nic'));
  fs.mkdirSync(path.dirname(bundleDir), { recursive: true });
  fs.mkdirSync(bundleDir, { mode: 0o700 });
  incus(['export', vm, path.join(bundleDir, 'vm.tar.gz'), '--instance-only']);
  incus(['storage', 'volume', 'export', 'default', volume, path.join(bundleDir, 'volume.tar.gz'), '--volume-only']);
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'area51-recovery-source-')));
  const install = path.join(work, 'install');
  const config = path.join(work, 'config');
  fs.mkdirSync(path.join(install, 'data'), { recursive: true });
  fs.mkdirSync(config);
  const db = new Database(path.join(install, 'data', 'v2.db'));
  db.pragma('foreign_keys=ON');
  runMigrations(db, getRegisteredMigrations());
  db.exec(`INSERT INTO agent_groups VALUES ('recovery-agent','Recovery agent','recovery-agent',NULL,'2026-01-01');
    INSERT INTO sessions (id,agent_group_id,status,container_status,last_active,created_at)
      VALUES ('recovery-session','recovery-agent','active','stopped','2026-01-01','2026-01-01');
    INSERT INTO tool_action_requests VALUES ('recovery-session','already-dispatched','2026-01-01');
    INSERT INTO pending_approvals (approval_id,session_id,request_id,action,payload,created_at)
      VALUES ('stale-approval','recovery-session','pending-request','tool_action','{}','2026-01-01');`);
  db.close();
  fs.writeFileSync(path.join(config, 'tool-actions.json'), '{"synthetic_private_config":true}', { mode: 0o600 });
  fs.writeFileSync(path.join(install, '.env'), 'SYNTHETIC_CHANNEL_TOKEN=fixture', { mode: 0o600 });
  const snapshot = createSnapshot({
    install,
    hostConfig: config,
    output: path.join(bundleDir, 'host-state'),
    commit: process.env.GITHUB_SHA!,
    offlineAcknowledged: true,
  });
  const files: Record<string, string> = {};
  for (const name of ['vm.tar.gz', 'volume.tar.gz']) {
    assert(
      fs.statSync(path.join(bundleDir, name)).size <= 2 * 1024 ** 3,
      'Synthetic recovery artifact exceeds 2GiB per file',
    );
    files[name] = await hash(path.join(bundleDir, name));
  }
  fs.writeFileSync(
    path.join(bundleDir, 'bundle.json'),
    JSON.stringify(
      {
        schema: 'area51.clean_host_bundle.v2',
        runId,
        sourceRunnerIdentity: runnerIdentity,
        testedCommit: process.env.GITHUB_SHA,
        hostManifestSha256: snapshot.manifestSha256,
        volume,
        files,
        syntheticData: true,
        networklessExport: true,
        shutdownTransport: 'guest-systemd-poweroff',
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  fs.rmSync(work, { recursive: true, force: true });
  console.log('Synthetic recovery bundle exported with root disk, custom volume and verified host state.');
} else {
  const bundle = JSON.parse(fs.readFileSync(path.join(bundleDir, 'bundle.json'), 'utf8'));
  assert.equal(bundle.schema, 'area51.clean_host_bundle.v2');
  assert.equal(bundle.runId, runId);
  assert.equal(bundle.volume, volume);
  assert.equal(bundle.syntheticData, true);
  assert.equal(bundle.testedCommit, process.env.GITHUB_SHA);
  assertSeparateRecoveryRunners(bundle.sourceRunnerIdentity, runnerIdentity);
  assert.deepEqual(JSON.parse(incus(['list', '--format', 'json'])), []);
  for (const name of ['vm.tar.gz', 'volume.tar.gz'])
    assert.equal(await hash(path.join(bundleDir, name)), bundle.files[name], 'Archive integrity mismatch');
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'area51-recovery-target-')));
  const staging = path.join(work, 'staging');
  let vmImported = false;
  let volumeImported = false;
  try {
    restoreSnapshot(path.join(bundleDir, 'host-state'), bundle.hostManifestSha256, staging);
    const install = path.join(staging, 'install');
    assert.throws(() => enforceRecoveryGate(install), /Restored installation is held/);
    const boot = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '-e',
        `process.chdir(${JSON.stringify(install)}); import(${JSON.stringify(pathToFileURL(path.join(repo, 'src/index.ts')).href)});`,
      ],
      { cwd: repo, encoding: 'utf8', timeout: 30_000, env: { ...process.env, HOME: work } },
    );
    assert.equal(boot.status, 1);
    assert.match(boot.stdout + boot.stderr, /Restored installation is held/);
    assert(!fs.existsSync(path.join(install, 'data', 'circuit-breaker.json')), 'Gate ran too late in startup');
    const db = new Database(path.join(install, 'data', 'v2.db'));
    db.pragma('foreign_keys=ON');
    assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM pending_approvals').get() as { n: number }).n, 1);
    assert.equal(
      db
        .prepare('INSERT OR IGNORE INTO tool_action_requests VALUES (?,?,?)')
        .run('recovery-session', 'already-dispatched', '2026-01-02').changes,
      0,
    );
    db.close();
    assert.equal(fs.statSync(path.join(staging, 'host-config', 'tool-actions.json')).mode & 0o077, 0);
    incus(['storage', 'volume', 'import', 'default', path.join(bundleDir, 'volume.tar.gz'), volume]);
    volumeImported = true;
    incus(['import', path.join(bundleDir, 'vm.tar.gz'), restoredVm, '--storage', 'default']);
    vmImported = true;
    const before = JSON.parse(incus(['list', restoredVm, '--format', 'json']));
    assert.equal(before.length, 1);
    assert.equal(before[0].status, 'Stopped');
    const devices = parseYaml(incus(['config', 'show', restoredVm, '--expanded'])).devices;
    assert(!Object.values(devices).some((device: any) => device.type === 'nic'), 'Restored VM has a network device');
    incus(['start', restoredVm]);
    await ready(restoredVm);
    const verify = `
      import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import { Database } from 'bun:sqlite';
      assert.equal(fs.readFileSync('/etc/area51/recovery-root-marker','utf8'),'synthetic-root-disk-preserved');
      assert.equal(JSON.parse(fs.readFileSync('/workspace/recovery-proof/.claude/provider-state.json','utf8')).session,'synthetic-provider-session');
      const db=new Database('/workspace/recovery-proof/outbound.db');
      assert.deepEqual(db.query('SELECT * FROM pending_work').all(),[{id:'restored-request',payload:'synthetic-pending-action'}]); db.close();
      assert.equal(Object.values(os.networkInterfaces()).flat().filter(x=>x&&!x.internal).length,0);
      assert.equal(fs.existsSync(${JSON.stringify(path.join(staging, 'host-config', 'tool-actions.json'))}),false);
      assert.equal(fs.existsSync('/usr/local/bin/bun'),true); assert.equal(fs.existsSync('/app/src/index.ts'),true);
      console.log('clean-host-guest-state-verified');
    `;
    assert.equal(incus(['exec', restoredVm, '--', 'bun', '-e', verify]).trim(), 'clean-host-guest-state-verified');
    const report = {
      schema: 'area51.clean_host_recovery.v2',
      tested_commit: process.env.GITHUB_SHA,
      measured_at: new Date().toISOString(),
      source_runner_identity: bundle.sourceRunnerIdentity,
      target_runner_identity: runnerIdentity,
      image_machine_id_equal: bundle.sourceRunnerIdentity.machineId === runnerIdentity.machineId,
      distinct_boot_instances: true,
      distinct_runner_hostnames: true,
      physical_host_attested: false,
      separate_github_runner: true,
      original_instance_absent: true,
      archives_verified: true,
      root_disk_restored: true,
      custom_volume_restored: true,
      synthetic_provider_state_restored: true,
      guest_pending_work_preserved_not_dispatched: true,
      central_database_integrity_verified: true,
      durable_reservations_preserved: true,
      private_host_config_unmounted: true,
      host_startup_blocked_before_db_or_channels: true,
      restored_vm_networkless: true,
      actual_admin_channel_tested: false,
      external_provider_effects_reconciled: false,
      production_activation_tested: false,
      synthetic_data: true,
      source_shutdown_transport: bundle.shutdownTransport,
    };
    fs.mkdirSync('.area51/diagnostics', { recursive: true });
    fs.writeFileSync('.area51/diagnostics/clean-host-recovery.json', JSON.stringify(report, null, 2) + '\n');
    console.log('Clean-host restore verified on a different runner; host held and VM networkless.');
  } finally {
    if (vmImported) incus(['delete', restoredVm, '--force']);
    if (volumeImported) incus(['storage', 'volume', 'delete', 'default', volume]);
    fs.rmSync(work, { recursive: true, force: true });
  }
}
