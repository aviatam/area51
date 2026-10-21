import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import './index.js';
import { createProvider } from './factory.js';
import { initTestSessionDb, closeSessionDb } from '../db/connection.js';

afterEach(() => closeSessionDb());

test('registered provider invokes the actual stdio MCP server and consumes the host system result', async () => {
  const { inbound } = initTestSessionDb();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'groq-mcp-'));
  const source = path.resolve(import.meta.dir, '..');
  const observation = path.join(root, 'outbox.json');
  const child = path.join(root, 'mcp.ts');
  fs.writeFileSync(
    child,
    `
import fs from 'node:fs';
import {initTestSessionDb} from ${JSON.stringify(path.join(source, 'db/connection.ts'))};
const {outbound}=initTestSessionDb();
await import(${JSON.stringify(path.join(source, 'mcp-tools/index.ts'))});
setInterval(()=>fs.writeFileSync(${JSON.stringify(observation)},JSON.stringify(outbound.prepare('SELECT content FROM messages_out').all())),25);
`,
  );
  let modelCalls = 0;
  const server = createServer((_request, response) => {
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
          : { role: 'assistant', content: '<message to="e2e">executed</message>' },
      ),
    );
  });
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
      .run(new Date().toISOString(), JSON.stringify({ text: `Tool request ${content.requestId}: executed.` }));
    observed = true;
  }, 50);
  try {
    const { port } = server.address() as { port: number };
    const provider = createProvider('groq', {
      env: {
        ...process.env,
        AREA51_GROQ_RELAY_URL: `http://127.0.0.1:${port}/groq-demo/propose`,
        AREA51_GROQ_RELAY_TOKEN: 'synthetic',
        AREA51_GROQ_HISTORY_PATH: path.join(root, 'history.json'),
      },
      mcpServers: { area51: { command: process.execPath, args: ['run', child] } },
    });
    const query = provider.query({ prompt: 'Perform the demo action', cwd: root });
    let completed = false;
    for await (const event of query.events) {
      if (event.type === 'error') throw new Error(event.message);
      if (event.type === 'result') {
        completed = true;
        expect(event.text).toContain('executed');
        query.end();
      }
    }
    expect(completed && observed).toBe(true);
    expect(modelCalls).toBe(2);
  } finally {
    clearInterval(timer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 10000);

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
