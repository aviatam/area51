import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import type { IncusRuntimePlan } from '../src/incus-runtime.js';
import { syncIncusVmOutbound } from '../src/incus-vm-session-bridge.js';
import { SessionToolActions } from '../src/session-tool-actions.js';
import { loadToolConfiguration } from '../src/tool-action-config.js';

/** Live non-root guest MCP -> guest outbox -> production VM DB bridge ->
 * session broker. Admin identity/decision transport is a host fixture; actual
 * channel authorization is tested separately by the host registry tests. */
export async function sessionToolVmProof(input: {
  primary: IncusRuntimePlan;
  primaryDirectory: string;
  peer: IncusRuntimePlan;
  peerDirectory: string;
  runGuest: (plan: IncusRuntimePlan, command: string, args: string[]) => Promise<string>;
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-session-tools-'));
  const configFile = path.join(root, 'host-private-tools.json');
  const credential = 'synthetic-private-session-tool-credential';
  const received: Array<{ path: string; args: unknown }> = [];
  let failure: Error | undefined;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health') {
      res.end('healthy');
      return;
    }
    try {
      assert.equal(req.headers.authorization, `Bearer ${credential}`);
      assert.equal(req.method, 'POST');
      let raw = '';
      for await (const chunk of req) raw += chunk;
      received.push({ path: req.url!, args: JSON.parse(raw) });
      res.end('private upstream content must not be relayed');
    } catch (error) {
      failure = error as Error;
      res.writeHead(403);
      res.end();
    }
  });
  const db = new Database(path.join(root, 'reservations.db'));
  db.exec('CREATE TABLE requests (session TEXT, id TEXT, PRIMARY KEY (session, id))');
  let approvalId = '';
  const service = new SessionToolActions({
    configuration: () => loadToolConfiguration(configFile),
    approvers: () => ['fixture:admin'],
    reserve: (session, id) =>
      db.prepare('INSERT OR IGNORE INTO requests VALUES (?, ?)').run(session.id, id).changes === 1,
    approval: async (_session, id, preview) => {
      approvalId = id;
      assert.equal(preview, '{"tool":"send","args":{"text":"reviewed-vm-write"}}');
      return true;
    },
  });
  try {
    server.listen(0, '0.0.0.0');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}`;
    assert.equal(await (await fetch(`${url}/health`)).text(), 'healthy');
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        schema: 'area51.tool-actions.v1',
        actions: {
          read: { url: `${url}/read`, token: credential, arguments: {}, required: [] },
          send: { url: `${url}/send`, token: credential, arguments: { text: 'string' }, required: ['text'] },
        },
        policy: { primary: { read: 'allow', send: 'approval' }, peer: { send: 'deny' } },
      }),
      { mode: 0o600 },
    );
    const guest = (peer: boolean) => `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { toolAction } from '/app/src/mcp-tools/tool-actions.ts';
assert.equal(fs.existsSync(${JSON.stringify(configFile)}), false, 'private host configuration leaked');
const direct = await new Promise(resolve => {
  const socket = net.connect({host: ${JSON.stringify(peer ? '10.252.0.1' : '10.251.0.1')},port:${address.port}});
  const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 3000);
  socket.on('connect',()=>{clearTimeout(timer);socket.destroy();resolve(true);});
  socket.on('error',()=>{clearTimeout(timer);resolve(false);});
});
assert.equal(direct,false,'guest reached direct tool backend');
const requests = ${JSON.stringify(
      peer
        ? [{ tool: 'send', args: { text: 'peer-denied' } }]
        : [
            { tool: 'read', args: {} },
            { tool: 'send', args: { text: 'reviewed-vm-write' } },
          ],
    )};
for (const request of requests) assert.notEqual((await toolAction.handler(request)).isError,true);
console.log('area51-session-tool-requests-submitted');
`;
    for (const [plan, directory, peer] of [
      [input.primary, input.primaryDirectory, false],
      [input.peer, input.peerDirectory, true],
    ] as const) {
      assert.equal(
        (await input.runGuest(plan, 'bun', ['-e', guest(peer)])).trim(),
        'area51-session-tool-requests-submitted',
      );
      syncIncusVmOutbound(plan, directory);
    }
    const session = { id: 'live-primary', agent_group_id: 'primary' };
    const readRows = (directory: string) => {
      const outbound = new Database(path.join(directory, 'outbound.db'), { readonly: true });
      try {
        return (
          outbound.prepare("SELECT content FROM messages_out WHERE kind = 'system' ORDER BY seq").all() as Array<{
            content: string;
          }>
        )
          .map((row) => JSON.parse(row.content))
          .filter((row) => row.action === 'tool_action');
      } finally {
        outbound.close();
      }
    };
    const primaryRequests = readRows(input.primaryDirectory);
    const peerRequests = readRows(input.peerDirectory);
    assert.equal(primaryRequests.length, 2);
    assert.equal(peerRequests.length, 1);
    assert.equal((await service.request(session, primaryRequests[0])).status, 'executed');
    assert.equal((await service.request(session, primaryRequests[1])).status, 'pending');
    assert.equal(
      (await service.request({ id: 'live-peer', agent_group_id: 'peer' }, peerRequests[0])).status,
      'denied',
    );
    assert.equal(received.length, 1);
    assert.equal((await service.resolve(session, approvalId, 'primary', true)).status, 'denied');
    assert.equal(
      (await service.resolve({ ...session, id: 'wrong-session' }, approvalId, 'fixture:admin', true)).status,
      'denied',
    );
    assert.equal((await service.resolve(session, approvalId, 'fixture:admin', true)).status, 'executed');
    assert.equal((await service.resolve(session, approvalId, 'fixture:admin', true)).status, 'denied');
    assert.equal((await service.request(session, primaryRequests[0])).status, 'denied');
    assert.equal((await service.request(session, primaryRequests[1])).status, 'denied');
    assert.deepEqual(received, [
      { path: '/read', args: {} },
      { path: '/send', args: { text: 'reviewed-vm-write' } },
    ]);
    if (failure) throw failure;
    return {
      schema: 'area51.vm_session_tools.v1',
      guest_mcp_tool: true,
      vm_database_bridge: true,
      host_session_broker: true,
      synthetic_credentials: true,
      approval_transport: 'host-fixture',
      private_config_unmounted: true,
      direct_backend_tcp_denied: true,
      exact_upstream_requests: received,
      peer_denied: true,
      agent_approval_denied: true,
      wrong_session_denied: true,
      replay_denied: true,
      outbox_redelivery_denied: true,
      actual_admin_channel_tested: false,
    };
  } finally {
    service.cancel();
    db.close();
    server.closeAllConnections();
    if (server.listening) {
      server.close();
      await once(server, 'close');
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
