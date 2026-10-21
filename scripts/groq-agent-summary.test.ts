import { expect, it } from 'vitest';
import { summarizeAgentMvp } from './groq-agent-summary.js';

it('requires measured runner, reboot recall, real result, denials and honest limits', () => {
  const marker = 'area51-memory-0123456789abcdef';
  const url = 'https://github.com/aviatam/area51/runs/1234';
  const record = {
    schema: 'area51.groq_agent_mvp.v1',
    tested_commit: 'abc',
    actual_runner_entry: '/app/src/index.ts',
    provider_skill_installed: true,
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
    full_host_recovery_tested: false,
    persistent_public_chat_service: false,
    production_activation_tested: false,
    upstream_writes: 1,
    conversation_turns: 4,
    check_url: url,
    transcript: [
      { user: `Remember ${marker}`, assistant: marker },
      { user: 'question', assistant: 'answer' },
      { user: 'Recall', assistant: marker },
      { user: 'Action', assistant: url },
    ],
  };
  expect(summarizeAgentMvp(record, 'abc')).toContain(url);
  for (const change of [
    { tested_commit: 'wrong' },
    { actual_stdio_mcp: false },
    { upstream_writes: 2 },
    { full_host_recovery_tested: true },
    { conversation_recalled_after_reboot: false },
    { transcript: [...record.transcript.slice(0, 2), { user: marker, assistant: marker }, record.transcript[3]] },
  ])
    expect(() => summarizeAgentMvp({ ...record, ...change }, 'abc')).toThrow();
});
