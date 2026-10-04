import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { ToolActionBroker, type ToolAuditEvent } from '../src/tool-action-broker.js';
import { toolActionHttpHandler } from '../src/tool-action-http.js';

export type BrokerAgent = 'primary' | 'peer';

/** Shared by the local fixture test and hosted VM trials. All credentials are
 * synthetic. The owner token and upstream credential never enter guest code. */
export class ToolBrokerVmFixture {
  private readonly primaryToken = randomBytes(32).toString('hex');
  private readonly peerToken = randomBytes(32).toString('hex');
  private readonly ownerToken = randomBytes(32).toString('hex');
  private readonly credential = randomBytes(32).toString('hex');
  private readonly servers: Server[] = [];
  private readonly observations: Array<{ action: string; args: unknown }> = [];
  private readonly events: ToolAuditEvent[] = [];
  private clockOffset = 0;
  private backendUrl = '';
  private controlUrl = '';
  private readonly relayUrls = new Map<BrokerAgent, string>();
  private readonly broker: ToolActionBroker;

  constructor(private readonly onFailure: (error: Error) => void) {
    this.broker = new ToolActionBroker({
      policy: { primary: { read: 'allow', send: 'approval' }, peer: { read: 'allow', send: 'deny' } },
      actions: Object.fromEntries(
        ['read', 'send'].map((action) => [
          action,
          {
            execute: async (args: Record<string, unknown>) => {
              const response = await fetch(`${this.backendUrl}/${action}`, {
                method: 'POST',
                headers: { authorization: `Bearer ${this.credential}`, 'content-type': 'application/json' },
                body: JSON.stringify(args),
                signal: AbortSignal.timeout(5000),
              });
              if (!response.ok) throw new Error('Fixture backend failed');
              return response.json();
            },
          },
        ]),
      ),
      approvers: ['owner'],
      now: () => Date.now() + this.clockOffset,
      approvalTtlMs: 60_000,
      audit: (event) => this.events.push(event),
    });
  }

  async startControl(): Promise<void> {
    const server = this.track(
      createServer(toolActionHttpHandler(this.broker, [{ token: this.ownerToken, approverId: 'owner' }])),
    );
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    this.controlUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  /** The host binds each relay to exactly ONE VM identity. Even the peer's
   * valid token is rejected at the primary VM's relay, and vice versa. */
  startRelay(agent: BrokerAgent, address: string, port: number, backendPort?: number): Server {
    if (agent === 'primary') {
      if (backendPort === undefined) throw new Error('Backend port required');
      this.backendUrl = `http://${address}:${backendPort}`;
      const backend = this.track(
        createServer((request, response) => {
          void (async () => {
            if (request.headers.authorization !== `Bearer ${this.credential}`) {
              this.onFailure(new Error('Direct unauthenticated backend request arrived'));
              response.writeHead(401);
              response.end();
              return;
            }
            let body = '';
            for await (const chunk of request) body += chunk.toString();
            if (request.url !== '/read' && request.url !== '/send') throw new Error('Unexpected fixture path');
            this.observations.push({ action: request.url.slice(1), args: JSON.parse(body) });
            response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
            response.end(JSON.stringify({ marker: 'host-tool-service-ok' }));
          })().catch((error) => {
            this.onFailure(error);
            response.writeHead(500);
            response.end();
          });
        }),
      );
      backend.once('listening', () => {
        this.backendUrl = `http://${address}:${(backend.address() as AddressInfo).port}`;
      });
      backend.listen(backendPort, address);
    }
    const token = agent === 'primary' ? this.primaryToken : this.peerToken;
    const handler = toolActionHttpHandler(this.broker, [{ token, agentId: agent }]);
    const relay = this.track(
      createServer((request, response) => {
        if (request.method === 'GET' && request.url === '/health') {
          response.writeHead(200, { connection: 'close' });
          response.end('area51-relay-ok\n');
          return;
        }
        handler(request, response);
      }),
    );
    this.relayUrls.set(agent, `http://${address}:${port}`);
    relay.once('listening', () => {
      this.relayUrls.set(agent, `http://${address}:${(relay.address() as AddressInfo).port}`);
    });
    relay.listen(port, address);
    return relay;
  }

  guestProbe(agent: BrokerAgent, checkDirectEgress = true): string {
    return guestToolProbe({
      agent,
      url: this.relayUrls.get(agent)!,
      token: agent === 'primary' ? this.primaryToken : this.peerToken,
      wrongToken: agent === 'primary' ? this.peerToken : this.primaryToken,
      backendUrl: this.backendUrl,
      checkDirectEgress,
    });
  }

  async verifyApprovals(primary: unknown, peer: unknown): Promise<Record<string, unknown>> {
    assert.deepEqual(peer, { agent: 'peer', read: true, denied: true, identity_bound: true });
    const result = primary as {
      agent?: string;
      approvalId?: string;
      read?: boolean;
      identity_bound?: boolean;
      guest_approval_denied?: boolean;
      extraApprovalId?: string;
    };
    assert.equal(result.agent, 'primary');
    assert.equal(result.read, true);
    assert.equal(result.identity_bound, true);
    assert.equal(result.guest_approval_denied, true);
    assert.equal(typeof result.approvalId, 'string');
    assert.equal(typeof result.extraApprovalId, 'string');
    assert.equal(this.observations.length, 2, 'Pending/denied calls reached upstream');
    const route = `/approvals/${result.approvalId}`;
    const preview = await fetch(this.controlUrl + route, {
      headers: { authorization: `Bearer ${this.ownerToken}` },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(preview.status, 200);
    assert.deepEqual(((await preview.json()) as { args: unknown }).args, {
      recipient: 'reviewed@example.test',
      body: 'reviewed VM write',
    });
    const modified = await this.ownerPost(route, { approve: true, args: { body: 'changed' } });
    assert.equal(modified, 400);
    assert.equal(this.observations.length, 2);
    const decisions = await Promise.all([
      this.ownerPost(route, { approve: true }),
      this.ownerPost(route, { approve: true }),
    ]);
    assert.deepEqual(decisions.sort(), [200, 403]);
    assert.equal(await this.ownerPost(route, { approve: true }), 403);
    // Injected host clock advances past the TTL; guest cannot change it.
    this.clockOffset += 60_000;
    assert.equal(await this.ownerPost(`/approvals/${result.extraApprovalId}`, { approve: true }), 403);
    assert.deepEqual(this.observations, [
      { action: 'read', args: { agent: 'primary' } },
      { action: 'read', args: { agent: 'peer' } },
      { action: 'send', args: { recipient: 'reviewed@example.test', body: 'reviewed VM write' } },
    ]);
    assert(!JSON.stringify(this.events).includes(this.credential));
    return {
      schema: 'area51.vm_tool_broker.v1',
      synthetic_credentials: true,
      upstream_actions: this.observations.map((item) => item.action),
      upstream_count: this.observations.length,
      per_relay_identity_bound: true,
      per_agent_permissions_passed: true,
      guest_cannot_approve: true,
      exact_approval_passed: true,
      concurrent_and_replay_blocked: true,
      expired_approval_blocked: true,
      expiry_clock: 'host-injected-test-clock',
      audit_contains_credential: false,
    };
  }

  async close(): Promise<void> {
    this.broker.cancelPending();
    await Promise.all(
      this.servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  }

  private async ownerPost(route: string, body: unknown): Promise<number> {
    const response = await fetch(this.controlUrl + route, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.ownerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    await response.text();
    return response.status;
  }

  private track(server: Server): Server {
    this.servers.push(server);
    server.on('error', this.onFailure);
    server.on('connection', (socket) =>
      socket.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ECONNRESET') this.onFailure(error);
      }),
    );
    server.on('clientError', (error: NodeJS.ErrnoException, socket) => {
      if (error.code !== 'ECONNRESET') this.onFailure(error);
      socket.destroy();
    });
    return server;
  }
}

export function guestToolProbe(input: {
  agent: BrokerAgent;
  url: string;
  token: string;
  wrongToken: string;
  backendUrl: string;
  checkDirectEgress: boolean;
}): string {
  return `
import net from 'node:net';
const input = ${JSON.stringify(input)};
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const post = async (route, body, token = input.token) => {
  const response = await fetch(input.url + route, {method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
  return {code:response.status, body:await response.json()};
};
assert((await post('/actions',{action:'read',args:{agent:input.agent}})).code===200,'allowed read failed');
assert((await post('/actions',{action:'read',args:{}},input.wrongToken)).code===401,'peer token accepted at wrong relay');
assert((await post('/actions',{action:'read',args:{},agentId:'primary'})).code===400,'guest identity override accepted');
if (input.checkDirectEgress) {
  const backend = new URL(input.backendUrl);
  const tcpReached = await new Promise(resolve => {
    const socket = net.connect({host:backend.hostname,port:Number(backend.port)});
    let done=false;
    const finish = value => { if(done) return; done=true; clearTimeout(timer); socket.destroy(); resolve(value); };
    const timer = setTimeout(() => finish(false),3000);
    socket.on('connect', () => finish(true)); socket.on('error', () => finish(false));
  });
  assert(!tcpReached,'guest reached direct tool backend over raw TCP');
  let reached=false;
  try { await fetch(input.backendUrl+'/read',{signal:AbortSignal.timeout(3000)}); reached=true; } catch {}
  assert(!reached,'guest reached direct tool backend');
}
const write=await post('/actions',{action:'send',args:{recipient:'reviewed@example.test',body:'reviewed VM write'}});
if(input.agent==='peer') {
  assert(write.code===403,'reader dispatched write');
  console.log(JSON.stringify({agent:input.agent,read:true,denied:true,identity_bound:true}));
} else {
  assert(write.code===202 && typeof write.body.approvalId==='string','write was not held');
  assert((await post('/approvals/'+write.body.approvalId,{approve:true})).code===403,'guest approved its own write');
  const extra=await post('/actions',{action:'send',args:{body:'expires'}});
  assert(extra.code===202,'expiry request not held');
  console.log(JSON.stringify({agent:input.agent,read:true,identity_bound:true,guest_approval_denied:true,approvalId:write.body.approvalId,extraApprovalId:extra.body.approvalId}));
}
`;
}
