import { expect, it } from 'vitest';
import { summarizeGroqVm } from './groq-vm-summary.js';
const sha = 'a'.repeat(40);
function records(): Array<Record<string, unknown>> {
  return [1, 2, 3].map((trial) => ({
    schema: 'area51.groq_vm_proof.v1',
    tested_commit: sha,
    trial,
    model: 'openai/gpt-oss-20b',
    model_calls: 1,
    upstream_writes: 1,
    real_groq_api: true,
    guest_mcp_tool: true,
    production_vm_db_bridge: true,
    host_session_broker: true,
    guest_provider_and_github_env_absent: true,
    model_gateway_bad_token_denied: true,
    model_gateway_replay_denied: true,
    peer_action_denied: true,
    spoofed_identity_denied: true,
    outbox_redelivery_denied: true,
    actual_human_approval_tested: false,
    full_agent_provider_install_tested: false,
    full_host_recovery_tested: false,
    production_activation_tested: false,
    inference_location: 'remote-groq',
    orchestration_location: 'non-root-incus-vm-guest',
    provider_credential_location: 'host-only',
    check_id: 100 + trial,
    check_url: `https://github.com/aviatam/area51/runs/${100 + trial}`,
  }));
}
it('summarizes all three exact-source bounded VM proofs', () => {
  const summary = summarizeGroqVm(records(), sha);
  expect(summary).toContain('/runs/101');
  expect(summary).toContain('/runs/103');
  expect(summary).toContain('not an installed general-purpose provider');
});
it.each(['tested_commit', 'trial', 'upstream_writes', 'real_groq_api', 'production_activation_tested', 'check_url'])(
  'rejects tampered evidence %s',
  (field) => {
    const rows = records();
    rows[0][field] = 'tampered';
    expect(() => summarizeGroqVm(rows, sha)).toThrow();
  },
);
it('rejects missing trials and duplicate upstream IDs', () => {
  expect(() => summarizeGroqVm(records().slice(0, 2), sha)).toThrow();
  const rows = records();
  rows[1].check_id = rows[0].check_id;
  rows[1].check_url = rows[0].check_url;
  expect(() => summarizeGroqVm(rows, sha)).toThrow();
});
