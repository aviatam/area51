import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';

import { ToolActionBroker } from './tool-action-broker.js';

interface Principal {
  token: string;
  agentId?: string;
  approverId?: string;
}

/** Reference HTTP transport. Bind on loopback for the lab. Remote deployments
 * require TLS, credential lifecycle and a trusted VM-to-principal mapping.
 * An agent token can submit actions but cannot inspect or resolve approvals. */
export function toolActionHttpHandler(broker: ToolActionBroker, principals: Principal[]): RequestListener {
  const bindings = principals.map((principal) => ({ ...principal }));
  const tokens = new Set(bindings.map((p) => p.token));
  if (
    tokens.size !== bindings.length ||
    bindings.some((p) => p.token.length < 32 || Boolean(p.agentId) === Boolean(p.approverId))
  )
    throw new Error('Unique tokens and exactly one identity per principal required');
  return (request, response) => {
    void handle(request, response).catch(() => reply(response, 503, { error: 'broker unavailable' }));
  };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const bearer = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const candidate = Buffer.from(bearer);
    const principal = bindings.find((p) => {
      const expected = Buffer.from(p.token);
      return candidate.length === expected.length && timingSafeEqual(candidate, expected);
    });
    if (!principal) return reply(response, 401, { error: 'unauthorized' });
    const approvalPath = /^\/approvals\/([0-9a-f-]{36})$/.exec(request.url ?? '');
    if (request.method === 'GET' && approvalPath && principal.approverId) {
      const preview = broker.inspectApproval(approvalPath[1], principal.approverId);
      return reply(response, preview ? 200 : 404, preview ?? { error: 'approval unavailable' });
    }
    if (request.method !== 'POST') return reply(response, 405, { error: 'method not allowed' });
    if ((request.url !== '/actions' || !principal.agentId) && (!approvalPath || !principal.approverId))
      return reply(response, 403, { error: 'forbidden' });
    if (request.headers['content-type'] !== 'application/json') return reply(response, 415, { error: 'JSON required' });
    let body: Record<string, unknown>;
    try {
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 65_536) throw new Error('body too large');
        chunks.push(buffer);
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('object required');
    } catch {
      return reply(response, 400, { error: 'invalid request' });
    }
    if (request.url === '/actions' && principal.agentId) {
      if (
        Object.keys(body).sort().join(',') !== 'action,args' ||
        typeof body.action !== 'string' ||
        !body.args ||
        typeof body.args !== 'object' ||
        Array.isArray(body.args)
      )
        return reply(response, 400, { error: 'action and object args required' });
      const result = await broker.bindAgent(principal.agentId)(body.action, body.args as Record<string, unknown>);
      return reply(response, result.status === 'pending' ? 202 : result.status === 'executed' ? 200 : 403, result);
    }
    if (Object.keys(body).join(',') !== 'approve' || typeof body.approve !== 'boolean')
      return reply(response, 400, { error: 'boolean approval required' });
    const result = await broker.resolve(approvalPath![1], principal.approverId!, body.approve);
    return reply(response, result.status === 'executed' ? 200 : 403, result);
  }
}

function reply(response: ServerResponse, status: number, value: unknown): void {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}
