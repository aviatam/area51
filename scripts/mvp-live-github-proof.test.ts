/** Controller regression only: simulated guest/remote API, REAL dispatch child,
 * SIGKILL, SQLite snapshot/import and redelivery. Hosted VM proof is separate. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import type { IncusRuntimePlan } from '../src/incus-runtime.js';
import { mvpLiveGithubProof } from './mvp-live-github-proof.js';

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
function fixture(rejectWrite = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-mvp-controller-'));
  directories.push(root);
  const primaryDirectory = path.join(root, 'primary');
  const peerDirectory = path.join(root, 'peer');
  for (const directory of [primaryDirectory, peerDirectory]) {
    fs.mkdirSync(directory);
    const db = new Database(path.join(directory, 'outbound.db'));
    db.exec('CREATE TABLE messages_out (seq INTEGER PRIMARY KEY, kind TEXT, content TEXT)');
    db.close();
  }
  vi.stubEnv('GITHUB_REPOSITORY', 'aviatam/area51');
  vi.stubEnv('GITHUB_SHA', 'a'.repeat(40));
  vi.stubEnv('GITHUB_TOKEN', 'synthetic-test-only');
  vi.stubEnv('GITHUB_RUN_ID', '123');
  vi.stubEnv('AREA51_E2E_TRIAL', '1');
  const records: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith('/check-runs')) {
        if (rejectWrite) return new Response('{}', { status: 403 });
        const args = JSON.parse(options!.body as string);
        records.push({ ...args, id: 1, html_url: 'https://example.test/synthetic-check' });
        return new Response('{}', { status: 201 });
      }
      return new Response(JSON.stringify({ total_count: records.length, check_runs: records }));
    }),
  );
  let request = 0;
  const primary = { instanceName: 'primary' } as unknown as IncusRuntimePlan;
  const peer = { instanceName: 'peer' } as unknown as IncusRuntimePlan;
  const runGuest = async (plan: IncusRuntimePlan, _command: string, args: string[]) => {
    const match = args[1].match(/tool:'mvp_write',args:(\{[^\n]+\})\}\)/);
    if (!match) throw new Error('Missing generated tool arguments');
    const directory = plan === primary ? primaryDirectory : peerDirectory;
    const db = new Database(path.join(directory, 'outbound.db'));
    try {
      db.prepare('INSERT INTO messages_out VALUES (?, ?, ?)').run(
        ++request,
        'system',
        JSON.stringify({
          action: 'tool_action',
          requestId: `mvp-${request}`,
          tool: 'mvp_write',
          args: JSON.parse(match[1]),
        }),
      );
    } finally {
      db.close();
    }
    return 'area51-mvp-request-submitted';
  };
  return { input: { primary, peer, primaryDirectory, peerDirectory, runGuest }, records };
}

// The production VM bridge is exercised on hosted VMs. This regression supplies
// already-synced host outboxes; it must not execute Incus on the test machine.
vi.mock('../src/incus-vm-session-bridge.js', () => ({ syncIncusVmOutbound: vi.fn() }));

it('kills the dispatch worker before response, restores lost IDs and refuses redelivery', async () => {
  const f = fixture();
  const report = await mvpLiveGithubProof(f.input);
  expect(report).toMatchObject({
    upstream_write_count: 1,
    surviving_reservations_imported: 2,
    signal: 'SIGKILL',
    worker_received_result_before_crash: false,
    restored_redelivery_denied: true,
    recovery_hold_enforced: true,
    activation_allowed: false,
    full_host_killed: false,
    host_reboot_tested: false,
    actual_admin_channel_tested: false,
    llm_tested: false,
  });
  expect(f.records).toHaveLength(1);
}, 30000);

it('fails the proof when the upstream rejects the authorized write', async () => {
  const f = fixture(true);
  await expect(mvpLiveGithubProof(f.input)).rejects.toThrow('Neutral upstream check was not accepted');
  expect(f.records).toHaveLength(0);
}, 30000);
