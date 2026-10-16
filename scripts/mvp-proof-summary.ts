import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function summarizeMvpProof(directory: string, sha: string): string {
  assert(/^[a-f0-9]{40}$/.test(sha));
  const ids = new Set<number>();
  const lines = [
    '# Area51 live MVP capability proof',
    '',
    `Candidate: \`${sha}\``,
    '',
    '| Trial | Observed GitHub action | Crash and restore |',
    '| --- | --- | --- |',
  ];
  for (let trial = 1; trial <= 3; trial++) {
    const report = JSON.parse(fs.readFileSync(path.join(directory, `mvp-live-github-trial-${trial}.json`), 'utf8'));
    assert.equal(report.schema, 'area51.mvp_live_github.v1');
    assert.equal(report.tested_commit, sha);
    assert.equal(report.trial, String(trial));
    for (const field of [
      'real_api',
      'guest_mcp_tool',
      'vm_database_bridge',
      'production_session_broker',
      'no_write_before_approval',
      'peer_write_denied',
      'identity_override_denied',
      'agent_approval_denied',
      'wrong_session_approval_denied',
      'upstream_accepted_before_crash',
      'pre_write_snapshot_restored',
      'restored_redelivery_denied',
      'recovery_hold_enforced',
    ])
      assert.equal(report[field], true, field);
    for (const field of [
      'guest_has_github_credential',
      'worker_received_result_before_crash',
      'actual_admin_channel_tested',
      'llm_tested',
      'full_host_killed',
      'activation_allowed',
      'automatic_external_reconciliation',
      'host_reboot_tested',
    ])
      assert.equal(report[field], false, field);
    assert.equal(report.signal, 'SIGKILL');
    assert.equal(report.approval_transport, 'host-fixture');
    assert.equal(report.upstream_write_count, 1);
    assert.equal(report.surviving_reservations_imported, 2);
    assert.equal(report.upstream_records.length, 1);
    const record = report.upstream_records[0];
    assert.equal(record.head_sha, sha);
    assert.equal(record.conclusion, 'neutral');
    assert(Number.isSafeInteger(record.id) && record.id > 0 && !ids.has(record.id));
    assert.equal(record.url, `https://github.com/aviatam/area51/runs/${record.id}`);
    ids.add(record.id);
    lines.push(
      `| ${trial} | [One neutral check](${record.url}) | SIGKILL before response; restored redelivery denied |`,
    );
  }
  lines.push(
    '',
    '## What was demonstrated',
    '',
    '- Three fresh VM-originated requests crossed the production DB bridge and broker.',
    '- Peer, spoofed identity, agent approval and wrong-session approval were denied.',
    '- No upstream write before host-fixture approval; exactly one per trial afterward.',
    '- Real dispatch worker killed after GitHub acceptance but before receiving its response.',
    '- Pre-write snapshot restored, surviving request IDs imported, replay denied and recovery hold retained.',
    '',
    '## Limits — not GA or a customer pilot',
    '',
    'Deterministic guest workload; fixture administrator, not a signed-in human channel. Only the dedicated dispatch worker was killed, not the whole Area51 host or Linux machine. GitHub writes are harmless neutral checks, not business orders or payments. Recovery stays held; no safe activation or automatic upstream reconciliation is claimed.',
    '',
  );
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const summary = summarizeMvpProof(process.argv[2] ?? '.area51/diagnostics', process.env.GITHUB_SHA ?? '');
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  fs.writeFileSync(path.resolve('.area51/diagnostics/mvp-live-summary.md'), summary, { mode: 0o600 });
  console.log(summary);
}
