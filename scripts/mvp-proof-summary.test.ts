import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { summarizeMvpProof } from './mvp-proof-summary.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(mutate?: (report: Record<string, unknown>) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-mvp-summary-'));
  roots.push(root);
  for (let trial = 1; trial <= 3; trial++) {
    const report: Record<string, unknown> = {
      schema: 'area51.mvp_live_github.v1',
      tested_commit: 'a'.repeat(40),
      trial: String(trial),
      real_api: true,
      guest_mcp_tool: true,
      vm_database_bridge: true,
      production_session_broker: true,
      no_write_before_approval: true,
      peer_write_denied: true,
      identity_override_denied: true,
      agent_approval_denied: true,
      wrong_session_approval_denied: true,
      upstream_accepted_before_crash: true,
      pre_write_snapshot_restored: true,
      restored_redelivery_denied: true,
      recovery_hold_enforced: true,
      guest_has_github_credential: false,
      worker_received_result_before_crash: false,
      actual_admin_channel_tested: false,
      llm_tested: false,
      full_host_killed: false,
      activation_allowed: false,
      automatic_external_reconciliation: false,
      host_reboot_tested: false,
      signal: 'SIGKILL',
      approval_transport: 'host-fixture',
      upstream_write_count: 1,
      surviving_reservations_imported: 2,
      upstream_records: [
        {
          id: trial,
          head_sha: 'a'.repeat(40),
          conclusion: 'neutral',
          url: `https://github.com/aviatam/area51/runs/${trial}`,
        },
      ],
    };
    if (trial === 2) mutate?.(report);
    fs.writeFileSync(path.join(root, `mvp-live-github-trial-${trial}.json`), JSON.stringify(report));
  }
  return root;
}
it('requires three exact-commit trials and includes live links and limitations', () => {
  const text = summarizeMvpProof(fixture(), 'a'.repeat(40));
  expect(text.match(/One neutral check/g)).toHaveLength(3);
  expect(text).toContain('Recovery stays held');
});
it.each(['tested_commit', 'real_api', 'activation_allowed', 'upstream_write_count', 'upstream_records'])(
  'rejects invalid %s evidence',
  (field) => {
    const root = fixture((report) => {
      report[field] = null;
    });
    expect(() => summarizeMvpProof(root, 'a'.repeat(40))).toThrow();
  },
);
