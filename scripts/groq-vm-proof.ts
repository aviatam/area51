/** Real Groq-backed guest orchestration over the existing primary VM relay.
 * Inference remains at Groq; provider and GitHub credentials stay on the host.
 * This is a bounded proof driver, not an installed general-purpose provider. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type { RequestListener } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { IncusRuntimePlan } from '../src/incus-runtime.js';
import { syncIncusVmOutbound } from '../src/incus-vm-session-bridge.js';
import { SessionToolActions } from '../src/session-tool-actions.js';
import { propose, type Context, type Proposal } from './mvp-groq-demo.js';

export function modelGateway(input: {
  token: string;
  prompt: string;
  generate: () => Promise<Proposal>;
  onFailure: () => void;
}): RequestListener {
  let used = false;
  return (request, response) => {
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(value));
    };
    void (async () => {
      if (request.method !== 'POST' || request.url !== '/groq-demo/propose') return reply(405, { error: 'route' });
      if (request.headers.authorization !== `Bearer ${input.token}`) return reply(401, { error: 'identity' });
      let raw = '';
      for await (const chunk of request) {
        raw += chunk.toString();
        if (Buffer.byteLength(raw) > 4096) return reply(413, { error: 'size' });
      }
      let body;
      try {
        body = JSON.parse(raw);
      } catch (error) {
        if (error instanceof SyntaxError) return reply(400, { error: 'json' });
        throw error;
      }
      if (!body || Object.keys(body).join(',') !== 'prompt' || body.prompt !== input.prompt)
        return reply(400, { error: 'request' });
      if (used) return reply(409, { error: 'consumed' });
      used = true; // Consume before awaiting Groq; no retry after ambiguity.
      return reply(200, await input.generate());
    })().catch(() => {
      input.onFailure();
      reply(502, { error: 'model unavailable' });
    });
  };
}

export async function groqVmProof(input: {
  primary: IncusRuntimePlan;
  primaryDirectory: string;
  peer: IncusRuntimePlan;
  peerDirectory: string;
  runGuest: (plan: IncusRuntimePlan, command: string, args: string[]) => Promise<string>;
  setModelHandler: (handler?: RequestListener) => void;
}) {
  const context: Context = {
    repo: process.env.GITHUB_REPOSITORY!,
    sha: process.env.GITHUB_SHA!,
    run: process.env.GITHUB_RUN_ID!,
    attempt: process.env.GITHUB_RUN_ATTEMPT!,
  };
  assert.equal(context.repo, 'aviatam/area51');
  assert.equal(context.attempt, '1');
  assert(
    (process.env.GITHUB_EVENT_NAME === 'push' && process.env.GITHUB_REF === 'refs/heads/test/groq-vm-proof') ||
      (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
        process.env.GITHUB_ACTOR === 'aviatam' &&
        process.env.GITHUB_TRIGGERING_ACTOR === 'aviatam'),
    'Only the bounded proof branch or an owner-started workflow may use live credentials',
  );
  const key = process.env.GROQ_API_KEY;
  const token = process.env.GITHUB_TOKEN;
  assert(key && token, 'Host-only Groq and temporary GitHub credentials required');
  const trial = process.env.AREA51_E2E_TRIAL!;
  assert.match(trial, /^[1-3]$/);
  const prompt = process.env.AREA51_GROQ_PROMPT || 'Demonstrate an Area51 action requested from an isolated VM';
  assert(prompt.trim() && prompt.length <= 2000);
  const relayToken = randomBytes(32).toString('hex');
  const name = `area51-groq-vm-${context.run}-${trial}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-groq-vm-'));
  const db = new Database(path.join(root, 'reservations.db'));
  db.exec('CREATE TABLE requests (session TEXT, id TEXT, PRIMARY KEY (session, id))');
  let proposal: Proposal | undefined;
  let modelCalls = 0;
  let modelFailed = false;
  let writes = 0;
  const upstreamHeaders = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const base = `https://api.github.com/repos/${context.repo}`;
  async function observations() {
    const response = await fetch(
      `${base}/commits/${context.sha}/check-runs?check_name=${name}&filter=all&per_page=100`,
      {
        headers: upstreamHeaders,
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      },
    );
    assert.equal(response.status, 200, 'GitHub observation failed');
    const body = (await response.json()) as {
      total_count: number;
      check_runs: Array<{ id: number; html_url: string; name: string; head_sha: string; conclusion: string }>;
    };
    assert.equal(body.total_count, body.check_runs.length);
    return body.check_runs;
  }
  const configuration = {
    revision: 'bounded-groq-vm-proof-v1',
    approvalTtlMs: 60000,
    policy: { primary: { groq_vm_check: 'allow' as const }, peer: { groq_vm_check: 'deny' as const } },
    actions: {
      groq_vm_check: {
        validate: (args: Record<string, unknown>) =>
          Boolean(proposal) && JSON.stringify(args) === JSON.stringify(proposal!.args),
        execute: async (args: Record<string, unknown>) => {
          assert.equal(++writes, 1, 'Duplicate dispatch');
          const response = await fetch(`${base}/check-runs`, {
            method: 'POST',
            headers: { ...upstreamHeaders, 'content-type': 'application/json' },
            redirect: 'error',
            signal: AbortSignal.timeout(15000),
            body: JSON.stringify({
              name,
              head_sha: context.sha,
              status: 'completed',
              conclusion: 'neutral',
              output: {
                title: args.title,
                summary:
                  'Groq host gateway → non-root VM agent → guest MCP → production DB bridge → host session broker.',
              },
            }),
          });
          assert.equal(response.status, 201, 'GitHub check failed; never retry ambiguous writes');
          await response.body?.cancel();
          return { httpStatus: 201 };
        },
      },
    },
  };
  const service = new SessionToolActions({
    configuration: () => configuration,
    approvers: () => [],
    reserve: (session, id) =>
      db.prepare('INSERT OR IGNORE INTO requests VALUES (?,?)').run(session.id, id).changes === 1,
    approval: async () => {
      throw new Error('This bounded demo must not request human approval');
    },
  });
  try {
    assert.equal((await observations()).length, 0, 'Prior upstream record: refuse replay');
    input.setModelHandler(
      modelGateway({
        token: relayToken,
        prompt,
        generate: async () => {
          modelCalls++;
          proposal = await propose(prompt, key, context);
          return proposal;
        },
        onFailure: () => {
          modelFailed = true;
        },
      }),
    );
    const guest = `
import assert from 'node:assert/strict';
import { toolAction } from '/app/src/mcp-tools/tool-actions.ts';
assert.equal(process.getuid(),1000);
assert(process.env.GROQ_API_KEY===undefined,'Groq credential must stay on the host');
assert(process.env.GITHUB_TOKEN===undefined,'GitHub credential must stay on the host');
const endpoint='http://10.251.0.1:10255/groq-demo/propose';
const headers={authorization:'Bearer '+${JSON.stringify(relayToken)},'content-type':'application/json'};
const body=JSON.stringify({prompt:${JSON.stringify(prompt)}});
const call=auth=>fetch(endpoint,{method:'POST',headers:{...headers,authorization:auth},body,signal:AbortSignal.timeout(55000)});
assert.equal((await call('Bearer wrong-token')).status,401);
const response=await call(headers.authorization);
assert.equal(response.status,200);
const proposal=await response.json();
assert.equal(proposal.tool,'create_neutral_check');
assert.equal(typeof proposal.args.title,'string');
assert.equal((await call(headers.authorization)).status,409);
assert.notEqual((await toolAction.handler({tool:'groq_vm_check',args:proposal.args})).isError,true);
console.log('area51-groq-vm-request-submitted');`;
    assert.equal(
      (await input.runGuest(input.primary, 'bun', ['-e', guest])).trim(),
      'area51-groq-vm-request-submitted',
    );
    assert(!modelFailed && proposal, 'Real model gateway failed');
    assert.equal(modelCalls, 1);
    // Same real model-proposed arguments, submitted by a different VM identity.
    const peerGuest = `import assert from 'node:assert/strict'; import {toolAction} from '/app/src/mcp-tools/tool-actions.ts';
assert.notEqual((await toolAction.handler({tool:'groq_vm_check',args:${JSON.stringify(proposal.args)}})).isError,true);
console.log('area51-groq-vm-peer-submitted');`;
    assert.equal((await input.runGuest(input.peer, 'bun', ['-e', peerGuest])).trim(), 'area51-groq-vm-peer-submitted');
    const requests: Record<string, unknown>[] = [];
    for (const [plan, directory] of [
      [input.primary, input.primaryDirectory],
      [input.peer, input.peerDirectory],
    ] as const) {
      syncIncusVmOutbound(plan, directory);
      const outbound = new Database(path.join(directory, 'outbound.db'), { readonly: true });
      try {
        const rows = (
          outbound.prepare("SELECT content FROM messages_out WHERE kind='system' ORDER BY seq").all() as Array<{
            content: string;
          }>
        )
          .map((r) => JSON.parse(r.content))
          .filter((r) => r.tool === 'groq_vm_check');
        assert.equal(rows.length, 1, 'Exactly one guest request required');
        requests.push(rows[0]);
      } finally {
        outbound.close();
      }
    }
    const primary = { id: 'groq-vm-primary', agent_group_id: 'primary' };
    assert.equal((await service.request({ id: 'groq-vm-peer', agent_group_id: 'peer' }, requests[1])).status, 'denied');
    assert.equal((await service.request(primary, { ...requests[0], agentId: 'peer' })).status, 'denied');
    assert.equal(writes, 0);
    assert.equal((await service.request(primary, requests[0])).status, 'executed');
    assert.equal((await service.request(primary, requests[0])).status, 'denied');
    assert.equal(writes, 1);
    const checks = await observations();
    assert.equal(checks.length, 1);
    assert.equal(checks[0].name, name);
    assert.equal(checks[0].head_sha, context.sha);
    assert.equal(checks[0].conclusion, 'neutral');
    assert.match(checks[0].html_url, /^https:\/\/github\.com\/aviatam\/area51\/runs\/[0-9]+$/);
    return {
      schema: 'area51.groq_vm_proof.v1',
      tested_commit: context.sha,
      trial: Number(trial),
      measured_at: new Date().toISOString(),
      real_groq_api: true,
      model: proposal.model,
      model_calls: modelCalls,
      inference_location: 'remote-groq',
      orchestration_location: 'non-root-incus-vm-guest',
      provider_credential_location: 'host-only',
      guest_mcp_tool: true,
      production_vm_db_bridge: true,
      host_session_broker: true,
      guest_provider_and_github_env_absent: true,
      model_gateway_bad_token_denied: true,
      model_gateway_replay_denied: true,
      peer_action_denied: true,
      spoofed_identity_denied: true,
      outbox_redelivery_denied: true,
      upstream_writes: writes,
      check_id: checks[0].id,
      check_url: checks[0].html_url,
      guest_title: proposal.args.title,
      actual_human_approval_tested: false,
      full_agent_provider_install_tested: false,
      full_host_recovery_tested: false,
      production_activation_tested: false,
    };
  } finally {
    input.setModelHandler(undefined);
    service.cancel();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
