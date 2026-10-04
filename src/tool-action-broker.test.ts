import { describe, expect, it, vi } from 'vitest';

import { ToolActionBroker, type ToolAuditEvent, type ToolResult } from './tool-action-broker.js';

function pendingId(result: ToolResult): string {
  if (result.status !== 'pending') throw new Error('Expected pending approval');
  return result.approvalId;
}

function fixture() {
  let now = 1000;
  const read = vi.fn(async () => 'record');
  const send = vi.fn(async (args) => args);
  const events: ToolAuditEvent[] = [];
  const policy = { reader: { read: 'allow', send: 'deny' }, writer: { read: 'allow', send: 'approval' } } as const;
  const broker = new ToolActionBroker({
    policy,
    actions: { read: { execute: read }, send: { execute: send } },
    approvers: ['owner'],
    now: () => now,
    approvalTtlMs: 100,
    maxPending: 2,
    audit: (event) => events.push(event),
  });
  return {
    broker,
    read,
    send,
    events,
    policy,
    advance: () => {
      now += 100;
    },
  };
}

describe('host tool action broker', () => {
  it('dispatches an allowed registered action', async () => {
    const f = fixture();
    expect(await f.broker.bindAgent('reader')('read', {})).toEqual({ status: 'executed', value: 'record' });
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.events.map((e) => e.status)).toEqual(['dispatching', 'executed']);
  });

  it.each([
    ['reader', 'send'],
    ['unknown', 'read'],
    ['reader', 'unknown'],
    ['reader', 'constructor'],
    ['reader', '__proto__'],
  ])('denies %s/%s before side effects', async (agent, action) => {
    const f = fixture();
    expect(await f.broker.bindAgent(agent)(action, {})).toEqual({ status: 'denied' });
    expect(f.read).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it('does not trust an agentId or permission carried in arguments', async () => {
    const f = fixture();
    expect(await f.broker.bindAgent('reader')('send', { agentId: 'writer', permission: 'allow' })).toEqual({
      status: 'denied',
    });
    expect(f.send).not.toHaveBeenCalled();
  });

  it('holds a write until an authorized approval and freezes its exact JSON arguments', async () => {
    const f = fixture();
    const args = { recipient: 'original', body: { text: 'reviewed' } };
    const id = pendingId(await f.broker.bindAgent('writer')('send', args));
    args.recipient = 'attacker';
    args.body.text = 'changed';
    expect(f.send).not.toHaveBeenCalled();
    expect(await f.broker.resolve(id, 'intruder', true)).toEqual({ status: 'denied' });
    expect(f.send).not.toHaveBeenCalled();
    expect(await f.broker.resolve(id, 'owner', true)).toEqual({
      status: 'executed',
      value: { recipient: 'original', body: { text: 'reviewed' } },
    });
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it('consumes approval before concurrent execution and rejects replay', async () => {
    const f = fixture();
    const id = pendingId(await f.broker.bindAgent('writer')('send', {}));
    const results = await Promise.all([f.broker.resolve(id, 'owner', true), f.broker.resolve(id, 'owner', true)]);
    expect(results.map((r) => r.status)).toEqual(['executed', 'denied']);
    expect(await f.broker.resolve(id, 'owner', true)).toEqual({ status: 'denied' });
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it('does not convert an approval into a standing permission', async () => {
    const f = fixture();
    const write = f.broker.bindAgent('writer');
    await f.broker.resolve(pendingId(await write('send', { body: 'one' })), 'owner', true);
    expect((await write('send', { body: 'two' })).status).toBe('pending');
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it('expires at the exact deadline without dispatching', async () => {
    const f = fixture();
    const id = pendingId(await f.broker.bindAgent('writer')('send', {}));
    f.advance();
    expect(await f.broker.resolve(id, 'owner', true)).toEqual({ status: 'expired' });
    expect(f.send).not.toHaveBeenCalled();
  });

  it('denies rejected, cancelled and unknown approvals', async () => {
    const f = fixture();
    const write = f.broker.bindAgent('writer');
    expect(await f.broker.resolve(pendingId(await write('send', {})), 'owner', false)).toEqual({ status: 'denied' });
    const id = pendingId(await write('send', {}));
    f.broker.cancelPending();
    expect(await f.broker.resolve(id, 'owner', true)).toEqual({ status: 'denied' });
    expect(await f.broker.resolve('unknown', 'owner', true)).toEqual({ status: 'denied' });
    expect(f.send).not.toHaveBeenCalled();
  });

  it('bounds pending state and reclaims expired requests', async () => {
    const f = fixture();
    const write = f.broker.bindAgent('writer');
    await write('send', {});
    await write('send', {});
    expect(await write('send', {})).toEqual({ status: 'denied' });
    f.advance();
    expect((await write('send', {})).status).toBe('pending');
    expect(f.events.filter((e) => e.status === 'expired')).toHaveLength(2);
    expect(f.send).not.toHaveBeenCalled();
  });

  it('snapshots trusted configuration', async () => {
    const f = fixture();
    Object.assign(f.policy.reader, { send: 'allow' });
    expect(await f.broker.bindAgent('reader')('send', {})).toEqual({ status: 'denied' });
    expect(f.send).not.toHaveBeenCalled();
  });

  it('rejects oversized and non-JSON arguments', async () => {
    const f = fixture();
    for (const args of [{ body: 'x'.repeat(65_536) }, { body: 1n }])
      expect(await f.broker.bindAgent('writer')('send', args)).toEqual({ status: 'denied' });
    expect(f.send).not.toHaveBeenCalled();
  });

  it('fails closed when the audit sink fails before dispatch', async () => {
    const execute = vi.fn(async () => true);
    const broker = new ToolActionBroker({
      policy: { a: { send: 'allow' } },
      actions: { send: { execute } },
      approvers: [],
      audit: () => {
        throw new Error('audit offline');
      },
    });
    await expect(broker.bindAgent('a')('send', {})).rejects.toThrow('audit offline');
    expect(execute).not.toHaveBeenCalled();
  });

  it('redacts handler errors and never retries an ambiguous side effect', async () => {
    const execute = vi.fn(async () => {
      throw new Error('secret-token');
    });
    const events: ToolAuditEvent[] = [];
    const broker = new ToolActionBroker({
      policy: { a: { send: 'approval' } },
      actions: { send: { execute } },
      approvers: ['owner'],
      audit: (e) => events.push(e),
    });
    const id = pendingId(await broker.bindAgent('a')('send', { body: 'private-body' }));
    expect(await broker.resolve(id, 'owner', true)).toEqual({ status: 'failed' });
    expect(await broker.resolve(id, 'owner', true)).toEqual({ status: 'denied' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(events)).not.toMatch(/secret-token|private-body/);
  });
});
