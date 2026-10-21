/** Live MVP controller: real runner entry, production VM bridge and session broker. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { RequestListener } from 'node:http';
import Database from 'better-sqlite3';
import { spawnIncusExec } from '../src/incus-adapter.js';
import type { IncusRuntimePlan } from '../src/incus-runtime.js';
import { syncIncusVmInbound, syncIncusVmOutbound } from '../src/incus-vm-session-bridge.js';
import { insertMessage, openInboundDb } from '../src/db/session-db.js';
import { SessionToolActions } from '../src/session-tool-actions.js';
import { groqAgentGateway, MODEL } from './groq-agent-gateway.js';

export function prepareGroqAgentMvp(groupDirectory: string): void {
  if (process.env.AREA51_GROQ_AGENT_MVP !== '1') return;
  fs.writeFileSync(
    path.join(groupDirectory, 'container.json'),
    JSON.stringify({
      provider: 'groq',
      model: MODEL,
      assistantName: 'Area51',
      groupName: 'MVP',
      agentGroupId: 'primary',
      mcpServers: {},
    }),
  );
  // The containment fixture mounts the group read-only. Preseed the standard
  // scaffold before provisioning, preserving the production runner startup.
  fs.cpSync('container/agent-runner/src/memory/templates', path.join(groupDirectory, 'memory'), { recursive: true });
}

export async function groqAgentMvp(input: {
  primary: IncusRuntimePlan;
  primaryDirectory: string;
  peer: IncusRuntimePlan;
  peerDirectory: string;
  runGuest: (plan: IncusRuntimePlan, command: string, args: string[]) => Promise<string>;
  runIncus: (args: string[]) => string;
  setModelHandler: (handler?: RequestListener) => void;
}) {
  const sha = process.env.GITHUB_SHA!;
  const repo = process.env.GITHUB_REPOSITORY!;
  const run = process.env.GITHUB_RUN_ID!;
  assert.equal(repo, 'aviatam/area51');
  assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1', 'Refuse retries of a live write');
  assert(
    (process.env.GITHUB_EVENT_NAME === 'push' && process.env.GITHUB_REF === 'refs/heads/test/groq-agent-mvp') ||
      (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
        process.env.GITHUB_ACTOR === 'aviatam' &&
        process.env.GITHUB_TRIGGERING_ACTOR === 'aviatam'),
  );
  const key = process.env.GROQ_API_KEY;
  const githubToken = process.env.GITHUB_TOKEN;
  assert(key && githubToken, 'Host credentials required');
  const prompt =
    process.env.AREA51_GROQ_PROMPT ||
    'Explain in one short sentence why an isolated AI agent should use host-approved tools.';
  assert(prompt.trim() && prompt.length <= 1000, 'Synthetic demo prompt must be 1–1000 characters');
  const relayToken = randomBytes(32).toString('hex');
  const marker = `area51-memory-${randomBytes(8).toString('hex')}`;
  const name = `area51-agent-mvp-${run}`;
  const headers = {
    authorization: `Bearer ${githubToken}`,
    accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const base = `https://api.github.com/repos/${repo}`;
  const modelEvents: Array<{ status: number; modelCall: number }> = [];
  const transcript: Array<{ user: string; assistant: string }> = [];
  const seen = new Set<string>();
  const hostState = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-mvp-host-'));
  const reservations = new Database(path.join(hostState, 'reservations.db'));
  reservations.exec('CREATE TABLE requests (session TEXT, id TEXT, PRIMARY KEY (session,id))');
  let writes = 0;
  let checkUrl = '';
  let requestContent: Record<string, unknown> | undefined;
  let runner: ChildProcess | undefined;
  let runnerError = false;
  const runnerLogs: string[] = [];
  const primary = { id: 'groq-mvp-primary', agent_group_id: 'primary' };
  const config = {
    revision: 'groq-agent-mvp-v1',
    approvalTtlMs: 60000,
    policy: { primary: { groq_mvp_check: 'allow' as const }, peer: { groq_mvp_check: 'deny' as const } },
    actions: {
      groq_mvp_check: {
        validate: (args: Record<string, unknown>) =>
          Object.keys(args).join(',') === 'title' && args.title === 'Area51 MVP live demo',
        execute: async () => {
          assert.equal(++writes, 1, 'Only one external write is permitted');
          const response = await fetch(`${base}/check-runs`, {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            redirect: 'error',
            signal: AbortSignal.timeout(15000),
            body: JSON.stringify({
              name,
              head_sha: sha,
              status: 'completed',
              conclusion: 'neutral',
              output: {
                title: 'Area51 MVP live demo',
                summary:
                  'Normal Groq provider → actual runner → MCP → production VM DB bridge → host broker. Multi-turn conversation and same-VM reboot verified separately in this run.',
              },
            }),
          });
          assert.equal(response.status, 201, 'External write failed or uncertain; never retry');
          const check = (await response.json()) as { html_url: string; head_sha: string };
          assert.equal(check.head_sha, sha);
          assert.match(check.html_url, /^https:\/\/github\.com\/aviatam\/area51\/runs\/[0-9]+$/);
          checkUrl = check.html_url;
          return { checkUrl };
        },
      },
    },
  };
  const service = new SessionToolActions({
    configuration: () => config,
    approvers: () => [],
    reserve: (session, id) =>
      reservations.prepare('INSERT OR IGNORE INTO requests VALUES (?,?)').run(session.id, id).changes === 1,
    approval: async () => {
      throw new Error('Bounded MVP must not request an additional human approval');
    },
  });
  function start() {
    runnerError = false;
    runner = spawnIncusExec(
      input.primary,
      'bun',
      ['run', '/app/src/index.ts'],
      {
        HOME: '/home/node',
        AREA51_GROQ_RELAY_URL: 'http://10.251.0.1:10255/groq-demo/propose',
        AREA51_GROQ_RELAY_TOKEN: relayToken,
      },
      { user: '1000', group: '1000' },
    );
    runner.stderr?.on('data', (chunk) => {
      if (runnerLogs.length < 100) runnerLogs.push(String(chunk));
    });
    runner.on('error', () => {
      runnerError = true;
    });
  }
  async function stop() {
    if (!runner) return;
    // Kill the guest entry, not just the local Incus client, before reboot/cleanup.
    try {
      if (runner.exitCode === null)
        await input.runGuest(input.primary, 'bash', ['-lc', "pkill -f '^bun run /app/src/index.ts$' || test $? -eq 1"]);
    } finally {
      runner.kill();
      runner = undefined;
    }
  }
  function send(text: string, kind: 'chat' | 'system' = 'chat') {
    const db = openInboundDb(path.join(input.primaryDirectory, 'inbound.db'));
    try {
      insertMessage(db, {
        id: `groq-mvp-${randomBytes(12).toString('hex')}`,
        kind,
        timestamp: new Date().toISOString(),
        platformId: 'e2e-platform',
        channelType: 'test',
        threadId: 'e2e-thread',
        content: JSON.stringify({ text, sender_name: 'MVP user' }),
        processAfter: null,
        recurrence: null,
      });
    } finally {
      db.close();
    }
    syncIncusVmInbound(input.primary, input.primaryDirectory);
  }
  async function pump(): Promise<string[]> {
    syncIncusVmOutbound(input.primary, input.primaryDirectory);
    const db = new Database(path.join(input.primaryDirectory, 'outbound.db'), { readonly: true });
    const rows = db.prepare('SELECT id,kind,content FROM messages_out ORDER BY seq').all() as Array<{
      id: string;
      kind: string;
      content: string;
    }>;
    db.close();
    const replies: string[] = [];
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const content = JSON.parse(row.content);
      if (row.kind === 'system' && content.tool === 'groq_mvp_check') {
        requestContent = content;
        assert.equal((await service.request(primary, { ...content, agentId: 'peer' })).status, 'denied');
        const result = await service.request(primary, content);
        assert.equal(result.status, 'executed');
        assert.equal((await service.request(primary, content)).status, 'denied');
        send(`Tool request ${content.requestId}: ${result.status}. Public check: ${checkUrl}`, 'system');
      } else if (row.kind === 'chat') replies.push(content.text);
    }
    return replies;
  }
  async function turn(text: string) {
    send(text);
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      assert(!runnerError && runner && runner.exitCode === null, 'Normal agent runner exited');
      const replies = await pump();
      if (replies.length) {
        const reply = replies.join('\n');
        assert(reply?.trim(), 'Empty chat output');
        transcript.push({ user: text, assistant: reply });
        console.log(`Groq MVP: normal conversation turn ${transcript.length} completed`);
        return reply;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    // Persist safe runner log lines only. Provider errors never contain upstream content.
    fs.writeFileSync('.area51/diagnostics/groq-agent-runner.log', runnerLogs.join(''));
    throw new Error('Normal agent did not complete a turn; see redacted model status and runner diagnostics');
  }
  try {
    input.setModelHandler(
      groqAgentGateway({ token: relayToken, key, budget: 12, record: (event) => modelEvents.push(event) }),
    );
    await input.runGuest(input.primary, 'bun', [
      '-e',
      "if(process.getuid()!==1000 || process.env.GROQ_API_KEY!==undefined || process.env.GITHUB_TOKEN!==undefined) throw Error('Guest identity or credential boundary failed');console.log('guest-safe');",
    ]);
    // Mark only the earlier fixture's already-observed output as seen.
    await pump();
    const badToken = await input.runGuest(input.primary, 'bun', [
      '-e',
      "const r=await fetch('http://10.251.0.1:10255/groq-demo/propose',{method:'POST',headers:{authorization:'Bearer wrong'}});if(r.status!==401)throw Error('Expected identity denial');console.log('denied');",
    ]);
    assert.equal(badToken.trim(), 'denied');
    start();
    assert(
      (
        await turn(
          `Remember this exact marker for our conversation: ${marker}. Reply only with the marker, wrapped for destination e2e. Do not call a tool.`,
        )
      ).includes(marker),
    );
    await turn(`${prompt}\nAnswer briefly to destination e2e. Do not call any tool in this turn.`);
    const bootBefore = (await input.runGuest(input.primary, 'cat', ['/proc/sys/kernel/random/boot_id'])).trim();
    await stop();
    input.runIncus(['restart', input.primary.instance, '--project', input.primary.project]);
    let bootAfter = '';
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        bootAfter = (await input.runGuest(input.primary, 'cat', ['/proc/sys/kernel/random/boot_id'])).trim();
        break;
      } catch (_error) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    assert(bootAfter && bootBefore !== bootAfter, 'VM kernel must actually restart');
    start();
    const recalled = await turn(
      'What exact marker did I ask you to remember earlier? Reply with that marker only, wrapped for destination e2e. Do not call a tool.',
    );
    assert(recalled.includes(marker), 'Conversation did not survive VM reboot');
    const actionReply = await turn(
      'Now call area51__tool_action with tool groq_mvp_check and args {"title":"Area51 MVP live demo"}. Wait for the host result, then reply to e2e with the actual status and exact public check URL.',
    );
    assert.equal(writes, 1);
    assert(actionReply.includes(checkUrl) && checkUrl, 'Agent must report the actual external result');
    assert(requestContent);
    const peerCode = `import{toolAction}from'/app/src/mcp-tools/tool-actions.ts';await toolAction.handler({tool:'groq_mvp_check',args:{title:'Area51 MVP live demo'}});console.log('submitted');`;
    await input.runGuest(input.peer, 'bun', ['-e', peerCode]);
    syncIncusVmOutbound(input.peer, input.peerDirectory);
    const peerDb = new Database(path.join(input.peerDirectory, 'outbound.db'), { readonly: true });
    const peerRows = (
      peerDb.prepare("SELECT content FROM messages_out WHERE kind='system'").all() as Array<{ content: string }>
    )
      .map((row) => JSON.parse(row.content))
      .filter((content) => content.tool === 'groq_mvp_check');
    peerDb.close();
    assert.equal(peerRows.length, 1);
    assert.equal(
      (await service.request({ id: 'groq-mvp-peer', agent_group_id: 'peer' }, peerRows[0])).status,
      'denied',
    );
    assert.equal(writes, 1);
    const observation = await fetch(`${base}/commits/${sha}/check-runs?check_name=${name}&filter=all&per_page=100`, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(observation.status, 200);
    const checks = (await observation.json()) as {
      total_count: number;
      check_runs: Array<{ html_url: string; head_sha: string; conclusion: string }>;
    };
    assert.equal(checks.total_count, 1);
    assert.equal(checks.check_runs[0].html_url, checkUrl);
    assert.equal(checks.check_runs[0].head_sha, sha);
    assert.equal(checks.check_runs[0].conclusion, 'neutral');
    return {
      schema: 'area51.groq_agent_mvp.v1',
      tested_commit: sha,
      measured_at: new Date().toISOString(),
      model: MODEL,
      actual_runner_entry: '/app/src/index.ts',
      provider_skill_installed: true,
      conversation_turns: transcript.length,
      multi_turn_conversation: true,
      same_vm_kernel_reboot: true,
      conversation_recalled_after_reboot: true,
      actual_stdio_mcp: true,
      production_vm_db_bridge: true,
      host_session_broker: true,
      host_credentials_only: true,
      bad_gateway_token_denied: true,
      peer_action_denied: true,
      spoofed_identity_denied: true,
      outbox_replay_denied: true,
      additional_human_approval: false,
      upstream_writes: writes,
      check_url: checkUrl,
      model_events: modelEvents,
      transcript,
      full_host_recovery_tested: false,
      persistent_public_chat_service: false,
      production_activation_tested: false,
    };
  } finally {
    try {
      await stop();
    } finally {
      input.setModelHandler(undefined);
      service.cancel();
      reservations.close();
      fs.rmSync(hostState, { recursive: true, force: true });
      fs.writeFileSync('.area51/diagnostics/groq-agent-model-status.json', JSON.stringify(modelEvents, null, 2));
      fs.writeFileSync('.area51/diagnostics/groq-agent-progress.json', JSON.stringify({ transcript, writes }, null, 2));
      const safeLogs = [relayToken, key, githubToken].reduce(
        (logs, secret) => logs.replaceAll(secret, '[REDACTED]'),
        runnerLogs.join(''),
      );
      fs.writeFileSync('.area51/diagnostics/groq-agent-runner.log', safeLogs);
    }
  }
}
