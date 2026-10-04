import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionToolActions } from './session-tool-actions.js';
import { parseToolConfiguration } from './tool-action-config.js';

const session = { id: 'session-a', agent_group_id: 'agent-a' };
function setup() {
  let now = 1000;
  let admins = ['slack:admin'];
  const execute = vi.fn().mockResolvedValue({ httpStatus: 200 });
  let config = {
    revision: 'v1',
    policy: { 'agent-a': { send: 'approval' as const, read: 'allow' as const }, 'agent-b': { send: 'deny' as const } },
    actions: { send: { execute }, read: { execute } },
    approvalTtlMs: 60_000,
  };
  const reserved = new Set<string>();
  const approval = vi.fn().mockResolvedValue(true);
  const ports = {
    configuration: () => config,
    approvers: () => admins,
    reserve: (s: typeof session, id: string) => {
      const key = `${s.id}:${id}`;
      if (reserved.has(key)) return false;
      reserved.add(key);
      return true;
    },
    approval,
    now: () => now,
  };
  const service = new SessionToolActions(ports);
  const request = (id = 'request-1', tool = 'send', args = { text: 'reviewed' }) =>
    service.request(session, { action: 'tool_action', tool, args, requestId: id });
  return {
    service,
    request,
    execute,
    approval,
    ports,
    advance: () => {
      now += 60_000;
    },
    revoke: () => {
      admins = [];
    },
    changeConfig: () => {
      config = { ...config, revision: 'v2' };
    },
  };
}

it('binds identity to the session and rejects supplied identity fields or peer policy', async () => {
  const f = setup();
  expect(
    await f.service.request(session, {
      action: 'tool_action',
      tool: 'read',
      args: {},
      requestId: 'x',
      agentId: 'agent-b',
    }),
  ).toEqual({ status: 'denied' });
  expect(
    await f.service.request(
      { id: 'peer', agent_group_id: 'agent-b' },
      { action: 'tool_action', tool: 'send', args: {}, requestId: 'x' },
    ),
  ).toEqual({ status: 'denied' });
  expect(f.execute).not.toHaveBeenCalled();
});

it('approves the immutable exact snapshot once under concurrent resolution', async () => {
  const f = setup();
  const args = { text: 'reviewed' };
  const pending = f.request('x', 'send', args);
  args.text = 'changed';
  const result = await pending;
  if (result.status !== 'pending') throw new Error('Expected approval');
  expect(f.approval.mock.calls[0][2]).toBe('{"tool":"send","args":{"text":"reviewed"}}');
  expect(await f.service.resolve({ ...session, id: 'other-session' }, result.approvalId, 'slack:admin', true)).toEqual({
    status: 'denied',
  });
  const results = await Promise.all([
    f.service.resolve(session, result.approvalId, 'slack:admin', true),
    f.service.resolve(session, result.approvalId, 'slack:admin', true),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual(['denied', 'executed']);
  expect(f.execute).toHaveBeenCalledExactlyOnceWith({ text: 'reviewed' });
});

it.each(['expiry', 'role', 'config', 'restart', 'reject'])('blocks approval after %s', async (change) => {
  const f = setup();
  const result = await f.request();
  if (result.status !== 'pending') throw new Error('Expected approval');
  if (change === 'expiry') f.advance();
  if (change === 'role') f.revoke();
  if (change === 'config') f.changeConfig();
  if (change === 'restart') f.service.cancel();
  const resolved = await f.service.resolve(session, result.approvalId, 'slack:admin', change !== 'reject');
  expect(resolved.status).not.toBe('executed');
  expect(f.execute).not.toHaveBeenCalled();
});

it('fails closed on unavailable approval delivery and a persisted duplicate after restart', async () => {
  const f = setup();
  f.approval.mockResolvedValue(false);
  expect(await f.request()).toEqual({ status: 'denied' });
  const restarted = new SessionToolActions(f.ports);
  expect(
    await restarted.request(session, { action: 'tool_action', tool: 'read', args: {}, requestId: 'request-1' }),
  ).toEqual({ status: 'denied' });
  expect(f.execute).not.toHaveBeenCalled();
});

it('does not retry ambiguous upstream failure when the outbox is redelivered', async () => {
  const f = setup();
  f.execute.mockRejectedValue(new Error('secret upstream response'));
  expect(await f.request('read-1', 'read')).toEqual({ status: 'failed' });
  expect(await f.request('read-1', 'read')).toEqual({ status: 'denied' });
  expect(f.execute).toHaveBeenCalledTimes(1);
});

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
});

it('uses fixed host credentials and sends exactly one approved POST to an actual upstream', async () => {
  const received: unknown[] = [];
  const token = 'synthetic-host-only-credential';
  const server = createServer(async (req, res) => {
    expect(req.headers.authorization).toBe(`Bearer ${token}`);
    let raw = '';
    for await (const chunk of req) raw += chunk;
    received.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ credential: token }));
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing listener');
  const raw = JSON.stringify({
    schema: 'area51.tool-actions.v1',
    actions: {
      send: { url: `http://127.0.0.1:${address.port}/send`, token, arguments: { text: 'string' }, required: ['text'] },
    },
    policy: { 'agent-a': { send: 'approval' }, 'agent-b': { send: 'deny' } },
  });
  const f = setup();
  const service = new SessionToolActions({ ...f.ports, configuration: () => parseToolConfiguration(raw) });
  expect(
    await service.request(session, {
      action: 'tool_action',
      requestId: 'bad',
      tool: 'send',
      args: { text: 'hello', url: 'https://attacker.invalid' },
    }),
  ).toEqual({ status: 'denied' });
  const pending = await service.request(session, {
    action: 'tool_action',
    requestId: 'real',
    tool: 'send',
    args: { text: 'reviewed' },
  });
  if (pending.status !== 'pending') throw new Error('Expected approval');
  expect(received).toEqual([]);
  expect(await service.resolve(session, pending.approvalId, 'agent-a', true)).toEqual({ status: 'denied' });
  expect(await service.resolve(session, pending.approvalId, 'slack:admin', true)).toEqual({
    status: 'executed',
    value: { httpStatus: 200 },
  });
  expect(await service.resolve(session, pending.approvalId, 'slack:admin', true)).toEqual({ status: 'denied' });
  expect(received).toEqual([{ text: 'reviewed' }]);
});
