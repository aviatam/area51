import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function summarizeAgentMvp(report: Record<string, unknown>, sha: string): string {
  assert.equal(report.schema, 'area51.groq_agent_mvp.v1');
  assert.equal(report.tested_commit, sha);
  for (const key of [
    'provider_skill_installed',
    'multi_turn_conversation',
    'same_vm_kernel_reboot',
    'conversation_recalled_after_reboot',
    'actual_stdio_mcp',
    'production_vm_db_bridge',
    'host_session_broker',
    'host_credentials_only',
    'bad_gateway_token_denied',
    'peer_action_denied',
    'spoofed_identity_denied',
    'outbox_replay_denied',
  ])
    assert.equal(report[key], true, key);
  for (const key of [
    'additional_human_approval',
    'full_host_recovery_tested',
    'persistent_public_chat_service',
    'production_activation_tested',
  ])
    assert.equal(report[key], false, key);
  assert.equal(report.actual_runner_entry, '/app/src/index.ts');
  assert.equal(report.upstream_writes, 1);
  assert.equal(report.conversation_turns, 4);
  assert.match(String(report.check_url), /^https:\/\/github\.com\/aviatam\/area51\/runs\/[0-9]+$/);
  const transcript = report.transcript as Array<{ user: string; assistant: string }>;
  assert.equal(transcript.length, 4);
  assert(
    transcript.every(
      (turn) => typeof turn.user === 'string' && typeof turn.assistant === 'string' && turn.assistant.trim(),
    ),
  );
  const marker = transcript[0].user.match(/area51-memory-[0-9a-f]{16}/)?.[0];
  assert(marker && transcript[0].assistant.includes(marker) && transcript[2].assistant.includes(marker));
  assert(!transcript[2].user.includes(marker), 'Recall prompt must not supply the answer');
  assert(transcript[3].assistant.includes(String(report.check_url)));
  return `## Area51 working agent MVP\n\nCommit: \`${sha}\`\n\n| Capability | Result |\n| --- | --- |\n| Normal runner and installed Groq provider | ✅ Passed |\n| Multi-turn conversation | ✅ 4 turns |\n| Remember conversation after VM kernel reboot | ✅ Passed |\n| Real stdio MCP → VM bridge → host broker | ✅ Passed |\n| Provider and GitHub credentials on host | ✅ Passed |\n| Peer, spoof and duplicate denial | ✅ Passed |\n| Additional human approval | Disabled for this bounded action |\n\nReal external action: ${report.check_url}\n\n### Live conversation\n\n${transcript.map((turn, index) => `**Turn ${index + 1}**\n\nUser: ${turn.user.replaceAll('<', '&lt;')}\n\nAgent: ${turn.assistant.replaceAll('<', '&lt;')}\n`).join('\n')}\n\nThis MVP runs on an ephemeral GitHub runner. It is not a persistent public chat service or production activation. Full-host recovery is a separate proof.\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = '.area51/diagnostics';
  const report = JSON.parse(fs.readFileSync(path.join(directory, 'groq-agent-mvp.json'), 'utf8'));
  const summary = summarizeAgentMvp(report, process.env.GITHUB_SHA!);
  fs.writeFileSync(path.join(directory, 'groq-agent-summary.md'), summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}
