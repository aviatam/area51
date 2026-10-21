import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import './index.js';
import { createProvider } from './factory.js';
import { initTestSessionDb, closeSessionDb } from '../db/connection.js';
import { buildSystemPromptAddendum } from '../destinations.js';
import { MEMORY_SESSION_HOOK } from '../memory/session-hook.js';

const live = process.env.AREA51_LIVE_GROQ_CONTRACT === '1';

afterEach(() => closeSessionDb());

async function exerciseMcp(emptyFinal: boolean, useLive: boolean) {
  const { inbound } = initTestSessionDb();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'groq-mcp-'));
  const source = path.resolve(import.meta.dir, '..');
  fs.cpSync(path.join(source, 'memory/templates'), path.join(root, 'memory'), { recursive: true });
  inbound
    .prepare(
      "INSERT INTO destinations (name,display_name,type,channel_type,platform_id) VALUES ('e2e','E2E channel','channel','test','e2e-platform')",
    )
    .run();
  const observation = path.join(root, 'outbox.json');
  const resultUrl = `https://example.invalid/area51-contract/${randomUUID()}`;
  const child = path.join(root, 'mcp.ts');
  fs.writeFileSync(
    child,
    `
import fs from 'node:fs';
import {initTestSessionDb} from ${JSON.stringify(path.join(source, 'db/connection.ts'))};
if(process.env.GROQ_API_KEY!==undefined || process.env.GITHUB_TOKEN!==undefined)throw Error('Host credentials entered MCP child');
const {outbound}=initTestSessionDb();
await import(${JSON.stringify(path.join(source, 'mcp-tools/index.ts'))});
setInterval(()=>fs.writeFileSync(${JSON.stringify(observation)},JSON.stringify(outbound.prepare('SELECT content FROM messages_out').all())),25);
`,
  );
  let modelCalls = 0;
  const diagnostics: unknown[] = [];
  const fake = (_request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => {
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify(
        ++modelCalls === 1
          ? {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'synthetic-call',
                  type: 'function',
                  function: {
                    name: 'area51__tool_action',
                    arguments: JSON.stringify({ tool: 'groq_mvp_check', args: { title: 'Area51 MVP live demo' } }),
                  },
                },
              ],
            }
          : { role: 'assistant', content: emptyFinal ? '' : `<message to="e2e">executed ${resultUrl}</message>` },
      ),
    );
  };
  let handler = fake;
  if (useLive) {
    if (!process.env.GROQ_API_KEY) throw new Error('Host Groq credential required');
    const { groqAgentGateway } = await import('../../../../scripts/groq-agent-gateway.ts');
    handler = groqAgentGateway({
      token: 'synthetic',
      key: process.env.GROQ_API_KEY,
      budget: 4,
      record: (event) => diagnostics.push(event),
    }) as typeof fake;
  }
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  let observed = false;
  const timer = setInterval(() => {
    if (observed || !fs.existsSync(observation)) return;
    const rows = JSON.parse(fs.readFileSync(observation, 'utf8')) as Array<{ content: string }>;
    if (!rows.length) return;
    const content = JSON.parse(rows[0].content);
    expect(content.tool).toBe('groq_mvp_check');
    inbound
      .prepare("INSERT INTO messages_in (id,seq,kind,timestamp,content) VALUES ('host-result',1,'system',?,?)")
      .run(
        new Date().toISOString(),
        JSON.stringify({ text: `Tool request ${content.requestId}: executed. Public check: ${resultUrl}` }),
      );
    observed = true;
  }, 50);
  try {
    const { port } = server.address() as { port: number };
    const provider = createProvider('groq', {
      env: {
        ...process.env,
        PATH: '/usr/bin:/bin',
        AREA51_GROQ_RELAY_URL: `http://127.0.0.1:${port}/groq-demo/propose`,
        AREA51_GROQ_RELAY_TOKEN: 'synthetic',
        AREA51_GROQ_HISTORY_PATH: path.join(root, 'history.json'),
      },
      mcpServers: { area51: { command: 'bun', args: ['run', child] } },
    });
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const query = provider.query({
      prompt:
        'Call area51__tool_action with tool groq_mvp_check and args {"title":"Area51 MVP live demo"}. Wait for the host result, then reply to e2e with the actual status and exact public check URL supplied by the host. Do not invent a URL.',
      cwd: root,
      systemContext: { instructions: buildSystemPromptAddendum('Area51') },
    });
    let completed = false;
    for await (const event of query.events) {
      if (event.type === 'error') throw new Error(event.message);
      if (event.type === 'result') {
        completed = true;
        expect(event.text).toContain(resultUrl);
        if (emptyFinal) expect(event.text).toContain('Host confirmation: executed.');
        query.end();
      }
    }
    expect(completed && observed).toBe(true);
    if (!useLive) expect(modelCalls).toBe(2);
    expect(JSON.parse(fs.readFileSync(observation, 'utf8')).length).toBe(1);
  } finally {
    if (useLive) console.log('Groq contract metadata:', JSON.stringify(diagnostics));
    clearInterval(timer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test(
  'registered provider invokes the actual stdio MCP server and consumes the host system result',
  () => exerciseMcp(false, live),
  live ? 120000 : 10000,
);
test(
  'empty final model output delivers the correlated host confirmation without another MCP call',
  () => exerciseMcp(true, false),
  10000,
);

test('real provider barrel registers Groq and persists queued exchanges for continuation', async () => {
  initTestSessionDb();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'groq-provider-'));
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const server = createServer((request, response) => {
    void (async () => {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      requests.push(JSON.parse(raw));
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ role: 'assistant', content: '<message to="e2e">hello</message>' }));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const provider = createProvider('groq', {
      env: {
        AREA51_GROQ_RELAY_URL: `http://127.0.0.1:${address.port}/groq-demo/propose`,
        AREA51_GROQ_RELAY_TOKEN: 'synthetic-token',
        AREA51_GROQ_HISTORY_PATH: path.join(root, 'history.json'),
      },
    });
    const query = provider.query({ prompt: 'Remember nonce-123', cwd: root });
    let continuation = '';
    let results = 0;
    for await (const event of query.events) {
      if (event.type === 'error') throw new Error(event.message);
      if (event.type === 'init') continuation = event.continuation;
      if (event.type === 'result' && ++results === 1) query.push('Second message');
      else if (event.type === 'result') query.end();
    }
    expect(results).toBe(2);
    const resumed = provider.query({ prompt: 'Recall', cwd: root, continuation });
    for await (const event of resumed.events) {
      if (event.type === 'error') throw new Error(event.message);
      if (event.type === 'result') resumed.end();
    }
    expect(requests.length).toBe(3);
    expect(requests[2].messages.some((message) => message.content === 'Remember nonce-123')).toBe(true);
    expect(requests[2].messages.some((message) => message.content === 'Second message')).toBe(true);
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'history.json'), 'utf8'));
    saved.interrupted = true;
    fs.writeFileSync(path.join(root, 'history.json'), JSON.stringify(saved));
    const blocked = provider.query({ prompt: 'retry', cwd: root, continuation });
    const errors = [];
    for await (const event of blocked.events) if (event.type === 'error') errors.push(event);
    expect(errors.length).toBe(1);
    expect(requests.length).toBe(3);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
