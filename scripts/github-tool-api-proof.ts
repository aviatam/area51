/** Real GitHub API proof. Creates exactly one neutral probe check on this
 * candidate commit, using a temporary repository-scoped Actions credential.
 * The admin decision is a host fixture, not a signed-in channel claim. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SessionToolActions } from '../src/session-tool-actions.js';
import { loadToolConfiguration } from '../src/tool-action-config.js';

const repo = process.env.GITHUB_REPOSITORY;
const sha = process.env.AREA51_TEST_HEAD_SHA;
const token = process.env.GITHUB_TOKEN;
assert.equal(repo, 'aviatam/area51', 'Live proof is restricted to the project repository');
assert(sha && /^[0-9a-f]{40}$/.test(sha), 'Candidate commit required');
assert(token, 'Temporary repository-scoped Actions credential required');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-github-tools-'));
const configurationFile = path.join(root, 'private-config.json');
const db = new Database(path.join(root, 'ledger.db'));
db.exec('CREATE TABLE requests (session TEXT, id TEXT, PRIMARY KEY(session,id))');
const name = `area51-tool-probe-${process.env.GITHUB_RUN_ID}-${randomUUID()}`;
const base = `https://api.github.com/repos/${repo}`;
const session = { id: 'github-primary-session', agent_group_id: 'github-primary' };
const peer = { id: 'github-peer-session', agent_group_id: 'github-peer' };
const args = { name, head_sha: sha, status: 'completed', conclusion: 'neutral' };
const readId = 'allowed-read';
let preview = '';
let admins = ['fixture:admin'];
const audit: Array<{ sessionId: string; requestId: string; approvalId?: string; action: string; status: string }> = [];
const service = new SessionToolActions({
  configuration: () => loadToolConfiguration(configurationFile),
  approvers: () => admins,
  reserve: (s, id) => db.prepare('INSERT OR IGNORE INTO requests VALUES (?, ?)').run(s.id, id).changes === 1,
  approval: async (_s, _id, value) => {
    preview = value;
    return true;
  },
  audit: (event) => audit.push(event),
});
async function observations(): Promise<
  Array<{
    id: number;
    name: string;
    head_sha: string;
    status: string;
    conclusion: string;
    app: { slug: string };
    html_url: string;
  }>
> {
  const response = await fetch(
    `${base}/commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}&filter=all&per_page=100`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    },
  );
  assert.equal(response.status, 200, 'Cannot inspect upstream check records');
  const body = (await response.json()) as { total_count: number; check_runs: Awaited<ReturnType<typeof observations>> };
  assert.equal(body.total_count, body.check_runs.length, 'Upstream result must not be truncated');
  return body.check_runs;
}
async function request(requestId: string, tool: string, parameters: Record<string, unknown>, actor = session) {
  return service.request(actor, { action: 'tool_action', requestId, tool, args: parameters });
}
try {
  fs.writeFileSync(
    configurationFile,
    JSON.stringify({
      schema: 'area51.tool-actions.v1',
      approvalTtlMs: 20000,
      actions: {
        read: { url: base, method: 'GET', token, arguments: {}, required: [] },
        write: {
          url: `${base}/check-runs`,
          token,
          arguments: { name: 'string', head_sha: 'string', status: 'string', conclusion: 'string' },
          required: ['name', 'head_sha', 'status', 'conclusion'],
        },
      },
      policy: {
        'github-primary': { read: 'allow', write: 'approval' },
        'github-peer': { read: 'allow', write: 'deny' },
      },
    }),
    { mode: 0o600 },
  );
  assert.deepEqual(await observations(), []);
  assert.deepEqual(await request(readId, 'read', {}), { status: 'executed', value: { httpStatus: 200 } });
  assert.equal((await request('denied-peer', 'write', args, peer)).status, 'denied');
  assert.equal(
    (
      await service.request(session, {
        action: 'tool_action',
        requestId: 'spoof',
        tool: 'write',
        args,
        agentId: 'github-peer',
      })
    ).status,
    'denied',
  );
  const approved = await request('approved-write', 'write', { ...args });
  assert.equal(approved.status, 'pending');
  if (approved.status !== 'pending') throw new Error('Expected pending request');
  assert.equal(preview, JSON.stringify({ agentGroupId: session.agent_group_id, tool: 'write', args }));
  assert.equal((await service.resolve(session, approved.approvalId, 'github-primary', true)).status, 'denied');
  assert.equal(
    (await service.resolve({ ...session, id: 'wrong-session' }, approved.approvalId, 'fixture:admin', true)).status,
    'denied',
  );
  assert.deepEqual(await observations(), []);
  const results = await Promise.all([
    service.resolve(session, approved.approvalId, 'fixture:admin', true),
    service.resolve(session, approved.approvalId, 'fixture:admin', true),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['denied', 'executed']);
  assert.equal((await service.resolve(session, approved.approvalId, 'fixture:admin', true)).status, 'denied');
  assert.equal((await request('approved-write', 'write', args)).status, 'denied');
  const expired = await request('expired-write', 'write', args);
  assert.equal(expired.status, 'pending');
  if (expired.status !== 'pending') throw new Error('Expected pending expiry');
  await new Promise((resolve) => setTimeout(resolve, 20100));
  assert.equal((await service.resolve(session, expired.approvalId, 'fixture:admin', true)).status, 'expired');
  const revoked = await request('revoked-write', 'write', args);
  assert.equal(revoked.status, 'pending');
  if (revoked.status !== 'pending') throw new Error('Expected pending revocation');
  admins = [];
  assert.equal((await service.resolve(session, revoked.approvalId, 'fixture:admin', true)).status, 'denied');
  const records = await observations();
  assert.equal(records.length, 1, 'Exactly one approved write must exist upstream');
  assert.equal(records[0].name, name);
  assert.equal(records[0].head_sha, sha);
  assert.equal(records[0].status, 'completed');
  assert.equal(records[0].conclusion, 'neutral');
  assert.equal(audit.filter((event) => event.status === 'dispatching' && event.action === 'write').length, 1);
  assert.equal(audit.filter((event) => event.status === 'dispatching' && event.action === 'read').length, 1);
  const report = {
    schema: 'area51.github_tool_api.v1',
    tested_commit: sha,
    measured_at: new Date().toISOString(),
    workflow_run_id: process.env.GITHUB_RUN_ID,
    repository: repo,
    real_api: true,
    credential_source: 'temporary-repository-scoped-github-actions-token',
    approval_transport: 'host-fixture',
    actual_admin_channel_tested: false,
    actual_vm_in_this_job: false,
    allowed_read: true,
    peer_write_denied: true,
    identity_override_denied: true,
    agent_approval_denied: true,
    wrong_session_denied: true,
    exact_write_approved: true,
    concurrent_approval_single_dispatch: true,
    replay_denied: true,
    durable_redelivery_denied: true,
    wall_clock_expiry_denied: true,
    role_revocation_denied: true,
    upstream_records: records.map((row) => ({
      id: row.id,
      name: row.name,
      head_sha: row.head_sha,
      status: row.status,
      conclusion: row.conclusion,
      application: row.app.slug,
      url: row.html_url,
    })),
    audit,
  };
  const target = path.resolve('.area51/diagnostics');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'github-tool-api-proof.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(
    'Real GitHub API: one allowed read and exactly one neutral approved check; denied, pending, replayed, expired and revoked writes did not dispatch.',
  );
} finally {
  service.cancel();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
