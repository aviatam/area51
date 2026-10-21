import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import './index.js';
import { createProvider } from './factory.js';
import { initTestSessionDb, closeSessionDb } from '../db/connection.js';

afterEach(() => closeSessionDb());

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
