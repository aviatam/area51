import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { loadToolConfiguration, parseToolConfiguration } from './tool-action-config.js';

const fixture = () => ({
  schema: 'area51.tool-actions.v1',
  actions: {
    send: {
      url: 'https://api.example.test/send',
      token: 'host-secret',
      arguments: { text: 'string' },
      required: ['text'],
    },
  },
  policy: { agent: { send: 'approval' } },
});

it('rejects URLs, fields and permissions outside the bounded contract', () => {
  for (const url of [
    'http://api.example.test/send',
    'https://user:secret@api.example.test',
    'https://api.example.test?token=x',
    'https://api.example.test#x',
  ]) {
    const config = fixture();
    config.actions.send.url = url;
    expect(() => parseToolConfiguration(JSON.stringify(config))).toThrow();
  }
  expect(() => parseToolConfiguration(JSON.stringify({ ...fixture(), unexpected: true }))).toThrow();
  expect(() =>
    parseToolConfiguration(JSON.stringify({ ...fixture(), policy: { agent: { missing: 'allow' } } })),
  ).toThrow();
});

it('rejects unknown arguments and misleading approval text before dispatch', () => {
  const config = parseToolConfiguration(JSON.stringify(fixture()));
  for (const args of [
    { text: 'ok', token: 'guest' },
    {},
    { text: 5 },
    { text: 'hidden\u202ereversed' },
    { text: '```spoofed```' },
  ])
    expect(config.actions.send.validate!(args)).toBe(false);
  expect(config.actions.send.validate!({ text: 'reviewed' })).toBe(true);
});

it('blocks redirects and cancels response bodies without leaking them', async () => {
  const cancel = vi.fn().mockResolvedValue(undefined);
  const send = vi.fn().mockResolvedValue({ ok: true, status: 204, body: { cancel } });
  const config = parseToolConfiguration(JSON.stringify(fixture()), send);
  expect(await config.actions.send.execute({ text: 'ok' })).toEqual({ httpStatus: 204 });
  expect(send.mock.calls[0][1]).toMatchObject({
    method: 'POST',
    redirect: 'error',
    headers: { authorization: 'Bearer host-secret' },
  });
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('supports a fixed GET destination without a guest-selected method, query or body', async () => {
  const send = vi.fn().mockResolvedValue({ ok: true, status: 200, body: null });
  const config = fixture();
  const raw = {
    ...config,
    actions: { read: { ...config.actions.send, method: 'GET', arguments: {}, required: [] } },
    policy: { agent: { read: 'allow' } },
  };
  const parsed = parseToolConfiguration(JSON.stringify(raw), send);
  expect(parsed.actions.read.validate!({})).toBe(true);
  expect(parsed.actions.read.validate!({ method: 'POST' })).toBe(false);
  await parsed.actions.read.execute({});
  expect(send.mock.calls[0][1]).toMatchObject({ method: 'GET', body: undefined, redirect: 'error' });
  expect(() =>
    parseToolConfiguration(
      JSON.stringify({ ...raw, actions: { read: { ...raw.actions.read, arguments: { query: 'string' } } } }),
    ),
  ).toThrow('no guest arguments');
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
it.skipIf(process.platform === 'win32')('requires a private regular host file and denies symbolic links', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-tools-'));
  dirs.push(dir);
  const file = path.join(dir, 'tools.json');
  expect(loadToolConfiguration(file)).toBeNull();
  fs.writeFileSync(file, JSON.stringify(fixture()), { mode: 0o600 });
  expect(loadToolConfiguration(file)?.policy.agent.send).toBe('approval');
  fs.chmodSync(file, 0o644);
  expect(() => loadToolConfiguration(file)).toThrow('private host-owned');
  fs.chmodSync(file, 0o600);
  const link = path.join(dir, 'link');
  fs.symlinkSync(file, link);
  expect(() => loadToolConfiguration(link)).toThrow('Cannot open');
});
