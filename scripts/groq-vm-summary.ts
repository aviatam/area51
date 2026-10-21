import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function summarizeGroqVm(records: Array<Record<string, unknown>>, sha: string): string {
  assert.match(sha, /^[a-f0-9]{40}$/);
  assert.equal(records.length, 3);
  const ids = new Set();
  for (const [i, r] of records.entries()) {
    assert.equal(r.schema, 'area51.groq_vm_proof.v1');
    assert.equal(r.tested_commit, sha);
    assert.equal(r.trial, i + 1);
    assert.equal(r.model, 'openai/gpt-oss-20b');
    assert.equal(r.model_calls, 1);
    assert.equal(r.upstream_writes, 1);
    for (const field of [
      'real_groq_api',
      'guest_mcp_tool',
      'production_vm_db_bridge',
      'host_session_broker',
      'guest_provider_and_github_env_absent',
      'model_gateway_bad_token_denied',
      'model_gateway_replay_denied',
      'peer_action_denied',
      'spoofed_identity_denied',
      'outbox_redelivery_denied',
    ])
      assert.equal(r[field], true, field);
    for (const field of [
      'actual_human_approval_tested',
      'full_agent_provider_install_tested',
      'full_host_recovery_tested',
      'production_activation_tested',
    ])
      assert.equal(r[field], false, field);
    assert.equal(r.inference_location, 'remote-groq');
    assert.equal(r.orchestration_location, 'non-root-incus-vm-guest');
    assert.equal(r.provider_credential_location, 'host-only');
    assert(typeof r.check_id === 'number' && Number.isSafeInteger(r.check_id) && r.check_id > 0);
    assert.equal(r.check_url, `https://github.com/aviatam/area51/runs/${r.check_id}`);
    assert(!ids.has(r.check_id));
    ids.add(r.check_id);
  }
  return `# Groq-backed VM agent proof\n\nTested commit: ${sha}\n\n| Trial | Real GitHub check | VM → model gateway → MCP → broker |\n| --- | --- | --- |\n${records.map((r) => `| ${r.trial} | [Neutral check](${r.check_url}) | Passed |`).join('\n')}\n\nThree fresh non-root VM drivers called a real Groq model via a host-only credential gateway and submitted the model-proposed title through the production MCP tool, VM DB bridge and session broker. Peer identity, spoofing, model-gateway replay and outbox redelivery were denied.\n\nInference is remote at Groq. This is a bounded guest proof driver, not an installed general-purpose provider, full chat product, human approval test, full-host recovery or production activation.\n`;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const directory = '.area51/diagnostics';
  const records = [1, 2, 3].map((i) => JSON.parse(fs.readFileSync(`${directory}/groq-vm-trial-${i}.json`, 'utf8')));
  const summary = summarizeGroqVm(records, process.env.GITHUB_SHA!);
  fs.writeFileSync(`${directory}/groq-vm-summary.md`, summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}
