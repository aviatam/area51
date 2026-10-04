import { afterEach, beforeEach, expect, it } from 'bun:test';
import { closeSessionDb, initTestSessionDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { toolAction } from './tool-actions.js';
beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());
it('submits a session-channel request without an agent identity or credential', async () => {
  expect((await toolAction.handler({ tool: 'send', args: { text: 'reviewed' } })).isError).not.toBe(true);
  const content = JSON.parse(getUndeliveredMessages()[0].content);
  expect(content).toMatchObject({ action: 'tool_action', tool: 'send', args: { text: 'reviewed' } });
  expect(Object.keys(content).sort()).toEqual(['action', 'args', 'requestId', 'tool']);
  expect(content.requestId).toMatch(/^[0-9a-f-]{36}$/);
});
it('rejects identity spoofing, malformed and oversized arguments', async () => {
  for (const args of [
    { tool: 'send', args: {}, agentId: 'other' },
    { tool: 'send', args: [] },
    { tool: 'send', args: { text: 'x'.repeat(65537) } },
  ])
    expect((await toolAction.handler(args)).isError).toBe(true);
  expect(getUndeliveredMessages()).toHaveLength(0);
});
