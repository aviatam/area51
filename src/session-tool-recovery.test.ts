import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-tool-recovery-'));
  const children: ChildProcess[] = [];
  const received: string[] = [];
  let upstreamSeen: () => void = () => {};
  const server = http.createServer((req) => {
    received.push(req.url!);
    upstreamSeen();
    // Intentionally never acknowledge: the write may have happened while
    // the caller cannot know its outcome. Kill that caller below.
    req.resume();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const runner = path.join(root, 'runner.mts');
  const serviceUrl = pathToFileURL(path.resolve('src/session-tool-actions.ts')).href;
  const configUrl = pathToFileURL(path.resolve('src/tool-action-config.ts')).href;
  fs.writeFileSync(
    runner,
    `
import Database from ${JSON.stringify(pathToFileURL(path.resolve('node_modules/better-sqlite3/lib/index.js')).href)};
import { SessionToolActions } from ${JSON.stringify(serviceUrl)};
import { parseToolConfiguration } from ${JSON.stringify(configUrl)};
const db = new Database(${JSON.stringify(path.join(root, 'ledger.db'))});
db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL');
db.exec('CREATE TABLE IF NOT EXISTS requests (session TEXT, id TEXT, PRIMARY KEY(session,id))');
const config = parseToolConfiguration(JSON.stringify({schema:'area51.tool-actions.v1',
actions:{write:{url:${JSON.stringify(`http://127.0.0.1:${address.port}/write`)},token:'synthetic-recovery-credential',arguments:{}}},
policy:{agent:{write:process.argv[2] === 'pending' ? 'approval' : 'allow'}}}));
const service = new SessionToolActions({configuration:()=>config,approvers:()=>['admin'],
reserve:(s,id)=>db.prepare('INSERT OR IGNORE INTO requests VALUES (?,?)').run(s.id,id).changes===1,
approval:async(_s,id)=>{console.log(JSON.stringify({approvalId:id})); return true;}});
const session = {id:'session',agent_group_id:'agent'};
if(process.argv[2] === 'resolve') {
 console.log(JSON.stringify(await service.resolve(session,process.argv[3],'admin',true)));
} else {
 const result = await service.request(session,{action:'tool_action',tool:'write',args:{},requestId:'write-1'});
 console.log(JSON.stringify(result));
 if(process.argv[2] === 'pending') { setInterval(()=>{},1000); await new Promise(()=>{}); }
}
db.close();
`,
  );
  const start = (mode: string, id?: string) => {
    const child = spawn(process.execPath, ['--import', 'tsx', runner, mode, ...(id ? [id] : [])], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    return child;
  };
  cleanups.push(async () => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'close');
      }
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    start,
    received,
    waitForUpstream: () =>
      new Promise<void>((resolve) => {
        upstreamSeen = resolve;
      }),
  };
}

async function output(child: ChildProcess): Promise<string> {
  let stdout = '',
    stderr = '';
  child.stdout!.on('data', (chunk) => (stdout += chunk.toString()));
  child.stderr!.on('data', (chunk) => (stderr += chunk.toString()));
  const [code] = await once(child, 'close');
  if (code !== 0) throw new Error(`Recovery child failed: ${stderr}`);
  return stdout.trim();
}

it('kills a real process after upstream dispatch and prevents duplicate dispatch after restart', async () => {
  const f = await harness();
  const seen = f.waitForUpstream();
  const first = f.start('dispatch');
  await Promise.race([
    seen,
    once(first, 'close').then(() => {
      throw new Error('Child exited before dispatch');
    }),
  ]);
  first.kill('SIGKILL');
  await once(first, 'close');
  expect(JSON.parse(await output(f.start('dispatch')))).toEqual({ status: 'denied' });
  expect(f.received).toEqual(['/write']);
}, 20_000);

it('kills a process with pending approval and denies both its stale approval and redelivered request', async () => {
  const f = await harness();
  const first = f.start('pending');
  const approvalId = await new Promise<string>((resolve, reject) => {
    let text = '';
    first.stdout!.on('data', (chunk) => {
      text += chunk.toString();
      if (text.includes('\n')) resolve(JSON.parse(text.split('\n')[0]).approvalId);
    });
    first.on('close', () => reject(new Error('Child exited before pending approval')));
  });
  first.kill('SIGKILL');
  await once(first, 'close');
  expect(JSON.parse(await output(f.start('resolve', approvalId)))).toEqual({ status: 'denied' });
  expect(JSON.parse(await output(f.start('dispatch')))).toEqual({ status: 'denied' });
  expect(f.received).toEqual([]);
}, 20_000);
