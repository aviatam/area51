/** Live VM MCP -> production DB bridge -> session broker -> real GitHub write.
 * The host dispatch worker is SIGKILLed after upstream acceptance but before its
 * response. A pre-write snapshot is restored with surviving reservations and
 * redelivery is denied. This is NOT a full host reboot or live admin channel. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { getRegisteredMigrations, runMigrations } from '../src/db/migrations/index.js';
import '../src/modules/tool-actions/index.js';
import type { IncusRuntimePlan } from '../src/incus-runtime.js';
import { syncIncusVmOutbound } from '../src/incus-vm-session-bridge.js';
import { enforceRecoveryGate } from '../src/recovery-gate.js';
import { prepareRestoredState } from '../src/recovery-reconciliation.js';
import { importSurvivingReservations, inspectSurvivingReservations } from '../src/recovery-reservations.js';
import { createSnapshot, restoreSnapshot } from '../src/recovery-snapshot.js';
import { SessionToolActions } from '../src/session-tool-actions.js';
import { loadToolConfiguration } from '../src/tool-action-config.js';

const primary = { id: 'mvp-primary-session', agent_group_id: 'primary' };
const peer = { id: 'mvp-peer-session', agent_group_id: 'peer' };
interface Task {
  database: string;
  config: string;
  request: Record<string, unknown>;
  peerRequest: Record<string, unknown>;
}
function serviceFor(task: Task, audit?: (event: unknown) => void) {
  const db = new Database(task.database, { fileMustExist: true });
  const service = new SessionToolActions({
    configuration: () => loadToolConfiguration(task.config),
    approvers: () => ['fixture:admin'],
    reserve: (session, id) =>
      db
        .prepare('INSERT OR IGNORE INTO tool_action_requests VALUES (?,?,?)')
        .run(session.id, id, new Date().toISOString()).changes === 1,
    approval: async (_session, _id, preview) => {
      assert.deepEqual(JSON.parse(preview), {
        agentGroupId: 'primary',
        tool: 'mvp_write',
        args: task.request.args,
      });
      return true;
    },
    audit,
  });
  return {
    service,
    close: () => {
      service.cancel();
      db.close();
    },
  };
}

async function worker(taskFile: string) {
  const task: Task = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
  const runtime = serviceFor(task, (event) => process.send?.({ kind: 'audit', event }));
  assert.equal((await runtime.service.request(peer, task.peerRequest)).status, 'denied');
  assert.equal((await runtime.service.request(primary, { ...task.request, agentId: 'peer' })).status, 'denied');
  const pending = await runtime.service.request(primary, task.request);
  assert.equal(pending.status, 'pending');
  if (pending.status !== 'pending') throw new Error('Missing pending approval');
  assert.equal((await runtime.service.resolve(primary, pending.approvalId, 'primary', true)).status, 'denied');
  assert.equal(
    (await runtime.service.resolve({ ...primary, id: 'wrong' }, pending.approvalId, 'fixture:admin', true)).status,
    'denied',
  );
  process.once('message', (message) => {
    assert.deepEqual(message, { approve: true });
    void runtime.service
      .resolve(primary, pending.approvalId, 'fixture:admin', true)
      .then((result) => {
        process.send?.({ kind: 'unexpected-result', result });
        runtime.close();
        process.disconnect?.();
      })
      .catch(() => process.exit(1));
  });
  process.send?.({ kind: 'pending' });
}

export async function mvpLiveGithubProof(input: {
  primary: IncusRuntimePlan;
  primaryDirectory: string;
  peer: IncusRuntimePlan;
  peerDirectory: string;
  runGuest: (plan: IncusRuntimePlan, command: string, args: string[]) => Promise<string>;
}) {
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  const token = process.env.GITHUB_TOKEN;
  assert.equal(repo, 'aviatam/area51', 'Restrict live mutation to project repository');
  assert(sha && /^[a-f0-9]{40}$/.test(sha));
  assert(token, 'Temporary checks:write Actions token required');
  const trial = process.env.AREA51_E2E_TRIAL;
  const name = `area51-mvp-${process.env.GITHUB_RUN_ID}-${trial}-${randomUUID()}`;
  const args = { name, head_sha: sha, status: 'completed', conclusion: 'neutral' };
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'area51-mvp-live-')));
  const install = path.join(root, 'install');
  const hostConfig = path.join(root, 'private-config');
  fs.mkdirSync(path.join(install, 'data'), { recursive: true });
  fs.mkdirSync(hostConfig, { mode: 0o700 });
  const source = path.join(install, 'data', 'v2.db');
  const config = path.join(hostConfig, 'tools.json');
  const taskFile = path.join(root, 'task.json');
  const relayCredential = randomBytes(32).toString('hex');
  const audit: Array<{ status: string }> = [];
  let dispatches = 0;
  let child: ChildProcess | undefined;
  let workerOutput = '';
  let workerResult = false;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const base = `https://api.github.com/repos/${repo}`;
  async function observations() {
    const response = await fetch(
      `${base}/commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}&filter=all&per_page=100`,
      { headers, redirect: 'error', signal: AbortSignal.timeout(15000) },
    );
    assert.equal(response.status, 200, 'Upstream observation failed');
    const body = (await response.json()) as {
      total_count: number;
      check_runs: Array<{ id: number; name: string; head_sha: string; conclusion: string; html_url: string }>;
    };
    assert.equal(body.total_count, body.check_runs.length, 'Truncated upstream evidence');
    return body.check_runs;
  }
  let acceptedResolve: () => void;
  let acceptedReject: (error: Error) => void;
  const accepted = new Promise<void>((resolve, reject) => {
    acceptedResolve = resolve;
    acceptedReject = reject;
  });
  // Attach a handler before dispatch, even if an earlier assertion fails.
  void accepted.catch(() => {});
  const proxy = http.createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/neutral-check');
      assert.equal(request.headers.authorization, `Bearer ${relayCredential}`);
      let raw = '';
      for await (const chunk of request) {
        raw += chunk;
        assert(raw.length <= 4096);
      }
      assert.deepEqual(JSON.parse(raw), args, 'Only exact neutral probe mutation authorized');
      dispatches++;
      assert.equal(dispatches, 1, 'Duplicate dispatch attempted');
      const upstream = await fetch(`${base}/check-runs`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(args),
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      assert.equal(upstream.status, 201, 'Neutral upstream check was not accepted');
      await upstream.json();
      acceptedResolve();
      // Deliberately never deliver the response: simulate accepted-but-unknown.
      // The controller will kill the worker, leaving its request reserved.
    })().catch((error: Error) => {
      acceptedReject(error);
      response.writeHead(500);
      response.end();
    });
  });
  try {
    const db = new Database(source);
    try {
      runMigrations(db, getRegisteredMigrations());
      db.exec(
        "INSERT INTO agent_groups VALUES ('primary','Primary','primary',NULL,'2026-01-01T00:00:00.000Z'); INSERT INTO agent_groups VALUES ('peer','Peer','peer',NULL,'2026-01-01T00:00:00.000Z')",
      );
      for (const session of [primary, peer])
        db.prepare(
          "INSERT INTO sessions (id,agent_group_id,status,container_status,last_active,created_at) VALUES (?,?,'active','stopped',?,?)",
        ).run(session.id, session.agent_group_id, new Date().toISOString(), new Date().toISOString());
    } finally {
      db.close();
    }
    fs.chmodSync(source, 0o600);
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    const address = proxy.address();
    assert(address && typeof address !== 'string');
    fs.writeFileSync(
      config,
      JSON.stringify({
        schema: 'area51.tool-actions.v1',
        approvalTtlMs: 60000,
        actions: {
          mvp_write: {
            url: `http://127.0.0.1:${address.port}/neutral-check`,
            token: relayCredential,
            arguments: { name: 'string', head_sha: 'string', status: 'string', conclusion: 'string' },
            required: Object.keys(args),
          },
        },
        policy: { primary: { mvp_write: 'approval' }, peer: { mvp_write: 'deny' } },
      }),
      { mode: 0o600 },
    );
    const captured = createSnapshot({
      install,
      hostConfig,
      output: path.join(root, 'snapshot'),
      commit: sha,
      offlineAcknowledged: true,
    });
    const requests: Record<string, unknown>[] = [];
    for (const [plan, directory] of [
      [input.primary, input.primaryDirectory],
      [input.peer, input.peerDirectory],
    ] as const) {
      const guest = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { toolAction } from '/app/src/mcp-tools/tool-actions.ts';
assert.equal(fs.existsSync(${JSON.stringify(config)}), false);
assert.equal(process.env.GITHUB_TOKEN, undefined);
assert.notEqual((await toolAction.handler({tool:'mvp_write',args:${JSON.stringify(args)}})).isError,true);
console.log('area51-mvp-request-submitted');`;
      assert.equal((await input.runGuest(plan, 'bun', ['-e', guest])).trim(), 'area51-mvp-request-submitted');
      syncIncusVmOutbound(plan, directory);
      const out = new Database(path.join(directory, 'outbound.db'), { readonly: true });
      try {
        const matching = (
          out.prepare("SELECT content FROM messages_out WHERE kind='system' ORDER BY seq").all() as Array<{
            content: string;
          }>
        )
          .map((row) => JSON.parse(row.content))
          .filter((row) => row.tool === 'mvp_write' && row.args?.name === name);
        assert.equal(matching.length, 1, 'Exactly one fresh MCP request per guest');
        requests.push(matching[0]);
      } finally {
        out.close();
      }
    }
    const task: Task = { database: source, config, request: requests[0], peerRequest: requests[1] };
    fs.writeFileSync(taskFile, JSON.stringify(task), { mode: 0o600 });
    assert.deepEqual(await observations(), []);
    child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), 'worker', taskFile], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      // Worker needs no GitHub credential; it can only reach the exact-request proxy.
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'GITHUB_TOKEN')),
    });
    const exited = once(child, 'exit');
    child.stdout?.on('data', (data) => {
      workerOutput += data.toString();
    });
    child.stderr?.on('data', (data) => {
      workerOutput += data.toString();
    });
    const pending = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Worker pending approval timeout')), 20000);
      child!.once('error', reject);
      child!.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('Worker exited before approval'));
      });
      child!.on('message', (message: { kind: string; event?: { status: string } }) => {
        if (message.kind === 'audit' && message.event) audit.push(message.event);
        if (message.kind === 'unexpected-result') workerResult = true;
        if (message.kind === 'pending') {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    await pending;
    assert.equal(dispatches, 0, 'No write before approval');
    assert.deepEqual(await observations(), []);
    child.send({ approve: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        accepted,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Upstream acceptance timeout')), 20000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    assert.equal(child.kill('SIGKILL'), true);
    const [code, signal] = await exited;
    assert.equal(code, null);
    assert.equal(signal, 'SIGKILL');
    assert.equal(workerResult, false, 'Worker must die before receiving dispatch result');
    assert.equal(audit.filter((row) => row.status === 'dispatching').length, 1);
    assert.equal(audit.filter((row) => row.status === 'executed').length, 0);
    const beforeRestore = await observations();
    assert.equal(beforeRestore.length, 1);
    assert.equal(beforeRestore[0].head_sha, sha);
    assert.equal(beforeRestore[0].conclusion, 'neutral');
    const staging = path.join(root, 'restored');
    restoreSnapshot(path.join(root, 'snapshot'), captured.manifestSha256, staging);
    const target = path.join(staging, 'install', 'data', 'v2.db');
    const baseline = new Database(target, { readonly: true });
    try {
      assert.equal((baseline.prepare('SELECT COUNT(*) AS n FROM tool_action_requests').get() as { n: number }).n, 0);
    } finally {
      baseline.close();
    }
    const inspected = inspectSurvivingReservations(source, true);
    const imported = importSurvivingReservations(staging, source, inspected.sourceLedgerSha256, true);
    assert.equal(imported.importedReservations, 2);
    const prepared = prepareRestoredState(staging, true);
    assert.equal(prepared.activationAllowed, false);
    assert.throws(() => enforceRecoveryGate(path.join(staging, 'install')), /Restored installation is held/);
    // Call only the service seam, NOT the held host. Demonstrate reservation
    // refusal even if the same outbox item is manually redelivered to it.
    const restarted = serviceFor({ ...task, database: target });
    try {
      assert.equal((await restarted.service.request(primary, task.request)).status, 'denied');
    } finally {
      restarted.close();
    }
    const records = await observations();
    assert.equal(records.length, 1, 'Restored redelivery must not create another upstream check');
    assert.equal(records[0].id, beforeRestore[0].id);
    assert.equal(dispatches, 1);
    assert(!workerOutput.includes(token) && !workerOutput.includes(relayCredential), 'Worker leaked credential');
    return {
      schema: 'area51.mvp_live_github.v1',
      tested_commit: sha,
      measured_at: new Date().toISOString(),
      workflow_run_id: process.env.GITHUB_RUN_ID,
      trial,
      real_api: true,
      guest_mcp_tool: true,
      vm_database_bridge: true,
      production_session_broker: true,
      guest_has_github_credential: false,
      approval_transport: 'host-fixture',
      actual_admin_channel_tested: false,
      llm_tested: false,
      no_write_before_approval: true,
      peer_write_denied: true,
      identity_override_denied: true,
      agent_approval_denied: true,
      wrong_session_approval_denied: true,
      upstream_accepted_before_crash: true,
      worker_received_result_before_crash: false,
      killed_process: 'dedicated-session-dispatch-worker',
      signal: 'SIGKILL',
      full_host_killed: false,
      pre_write_snapshot_restored: true,
      surviving_reservations_imported: imported.importedReservations,
      restored_redelivery_denied: true,
      recovery_hold_enforced: true,
      activation_allowed: false,
      automatic_external_reconciliation: false,
      host_reboot_tested: false,
      upstream_write_count: records.length,
      upstream_records: records.map((row) => ({
        id: row.id,
        name: row.name,
        url: row.html_url,
        head_sha: row.head_sha,
        conclusion: row.conclusion,
      })),
      audit,
    };
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'exit');
      child.kill('SIGKILL');
      await closed;
    }
    proxy.closeAllConnections();
    if (proxy.listening) {
      proxy.close();
      await once(proxy, 'close');
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) &&
  process.argv[2] === 'worker'
) {
  await worker(process.argv[3]);
}
