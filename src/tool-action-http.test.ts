import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, expect, it } from 'vitest';

import { ToolActionBroker, type ToolAuditEvent } from './tool-action-broker.js';
import { toolActionHttpHandler } from './tool-action-http.js';

const readerToken = 'reader-token-'.repeat(4);
const writerToken = 'writer-token-'.repeat(4);
const ownerToken = 'owner-token-'.repeat(4);
const syntheticCredential = 'synthetic-host-only-secret';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe('tool broker HTTP enforcement against a credentialed fixture', () => {
  it('blocks unauthorized dispatch, reviews the exact write and executes it once', async () => {
    const upstreamRequests: Array<{ path: string; body: string }> = [];
    const events: ToolAuditEvent[] = [];
    const upstream = createServer((req, res) => {
      void (async () => {
        if (req.headers.authorization !== `Bearer ${syntheticCredential}`) {
          res.writeHead(401);
          res.end();
          return;
        }
        let body = '';
        for await (const chunk of req) body += chunk.toString();
        upstreamRequests.push({ path: req.url!, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      })().catch(() => {
        res.writeHead(500);
        res.end();
      });
    });
    const upstreamUrl = await listen(upstream);
    let now = 1000;
    const broker = new ToolActionBroker({
      policy: { reader: { read: 'allow', send: 'deny' }, writer: { send: 'approval' } },
      actions: Object.fromEntries(
        ['read', 'send'].map((action) => [
          action,
          {
            execute: async (args: Record<string, unknown>) => {
              // Fixed endpoint and host-owned credential; guest args cannot replace either.
              const res = await fetch(`${upstreamUrl}/${action}`, {
                method: 'POST',
                headers: { authorization: `Bearer ${syntheticCredential}`, 'content-type': 'application/json' },
                body: JSON.stringify(args),
                signal: AbortSignal.timeout(3000),
              });
              if (!res.ok) throw new Error('upstream failed');
              return res.json();
            },
          },
        ]),
      ),
      approvers: ['owner'],
      approvalTtlMs: 100,
      now: () => now,
      audit: (e) => events.push(e),
    });
    const principals = [
      { token: readerToken, agentId: 'reader' },
      { token: writerToken, agentId: 'writer' },
      { token: ownerToken, approverId: 'owner' },
    ];
    const gateway = createServer(toolActionHttpHandler(broker, principals));
    try {
      const url = await listen(gateway);
      const post = async (token: string, route: string, body: unknown) => {
        const res = await fetch(url + route, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(3000),
        });
        return { code: res.status, body: (await res.json()) as Record<string, unknown> };
      };
      expect((await post('invalid', '/actions', { action: 'read', args: {} })).code).toBe(401);
      expect((await post(readerToken, '/actions', { action: 'send', args: { agentId: 'writer' } })).code).toBe(403);
      expect((await post(readerToken, '/actions', { action: 'read', args: {}, agentId: 'writer' })).code).toBe(400);
      expect((await post(ownerToken, '/actions', { action: 'read', args: {} })).code).toBe(403);
      expect(upstreamRequests).toHaveLength(0);
      expect((await post(readerToken, '/actions', { action: 'read', args: {} })).code).toBe(200);
      expect(upstreamRequests).toHaveLength(1);
      const args = { recipient: 'reviewed@example.test', body: 'reviewed text' };
      const pending = await post(writerToken, '/actions', { action: 'send', args });
      expect(pending.code).toBe(202);
      const route = `/approvals/${pending.body.approvalId}`;
      expect((await fetch(url + route, { headers: { authorization: `Bearer ${writerToken}` } })).status).toBe(405);
      const preview = await fetch(url + route, { headers: { authorization: `Bearer ${ownerToken}` } });
      expect(await preview.json()).toMatchObject({ agentId: 'writer', action: 'send', args });
      expect((await post(writerToken, route, { approve: true })).code).toBe(403);
      expect((await post(ownerToken, route, { approve: true, args: { recipient: 'attacker' } })).code).toBe(400);
      expect(upstreamRequests).toHaveLength(1);
      const results = await Promise.all([
        post(ownerToken, route, { approve: true }),
        post(ownerToken, route, { approve: true }),
      ]);
      expect(results.map((r) => r.code).sort()).toEqual([200, 403]);
      expect((await post(ownerToken, route, { approve: true })).code).toBe(403);
      expect(upstreamRequests).toEqual([
        { path: '/read', body: '{}' },
        { path: '/send', body: JSON.stringify(args) },
      ]);
      for (const resolution of ['reject', 'expire', 'cancel'] as const) {
        const next = await post(writerToken, '/actions', { action: 'send', args });
        const nextRoute = `/approvals/${next.body.approvalId}`;
        if (resolution === 'expire') now += 100;
        if (resolution === 'cancel') broker.cancelPending();
        expect((await post(ownerToken, nextRoute, { approve: resolution !== 'reject' })).code).toBe(403);
      }
      expect(upstreamRequests).toHaveLength(2);
      expect(JSON.stringify(events)).not.toContain(syntheticCredential);
      expect(JSON.stringify(events)).not.toContain('reviewed text');
    } finally {
      await close(gateway);
      await close(upstream);
    }
  });

  it('rejects overlapping identity tokens and dual-role identities', () => {
    const broker = new ToolActionBroker({ policy: {}, actions: {}, approvers: [] });
    expect(() =>
      toolActionHttpHandler(broker, [
        { token: readerToken, agentId: 'a' },
        { token: readerToken, approverId: 'owner' },
      ]),
    ).toThrow('Unique tokens');
    expect(() => toolActionHttpHandler(broker, [{ token: readerToken, agentId: 'a', approverId: 'owner' }])).toThrow(
      'Unique tokens',
    );
  });
});
