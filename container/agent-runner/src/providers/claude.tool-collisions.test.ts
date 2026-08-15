import { describe, it, expect } from 'bun:test';

import { SDK_DISALLOWED_TOOLS, TOOL_ALLOWLIST } from './claude.js';

// Built-in Claude Code tools whose NAME reads as the obvious way to do
// something Area51 already models differently. Leaving one of these
// available is a silent failure: the agent calls the built-in, gets a
// coherent-sounding refusal about a subsystem Area51 doesn't use, and
// reports that Area51 is broken.
//
// SendMessage is the regression this guards. It addresses Claude Code's own
// in-session subagents; an agent that had just created a Area51 agent group
// called it four times and read "No agent named 'growth' is currently
// addressable" as "the group was never provisioned".
const COLLIDES_WITH_AREA51_MCP: Array<[builtin: string, mcpEquivalent: string]> = [
  ['SendMessage', 'mcp__area51__send_message'],
  ['AskUserQuestion', 'mcp__area51__ask_user_question'],
];

describe('built-in tools that collide with Area51 MCP tools', () => {
  for (const [builtin, mcpEquivalent] of COLLIDES_WITH_AREA51_MCP) {
    it(`${builtin} is disallowed in favour of ${mcpEquivalent}`, () => {
      expect(SDK_DISALLOWED_TOOLS).toContain(builtin);
      expect(TOOL_ALLOWLIST).not.toContain(builtin);
    });
  }

  it('no tool is both allowlisted and disallowed', () => {
    const overlap = TOOL_ALLOWLIST.filter((t) => SDK_DISALLOWED_TOOLS.includes(t));
    expect(overlap).toEqual([]);
  });
});
