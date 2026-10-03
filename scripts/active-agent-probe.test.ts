import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { activeAgentProbe } from './active-agent-probe.js';

async function execute(script: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script]);
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function fixture(
  test: (input: Parameters<typeof activeAgentProbe>[0]) => Promise<void>,
  peerReachable = false,
): Promise<void> {
  // Use two ephemeral ports on the standard loopback address. macOS does not
  // configure 127.0.0.2 by default. Live VM probes still use distinct IPs.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-active-probe-'));
  const ownFile = path.join(root, 'own-private.txt');
  fs.writeFileSync(ownFile, 'own-marker');
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.end('own-marker');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const peer = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.end('unrelated');
  });
  await new Promise<void>((resolve, reject) => {
    peer.once('error', reject);
    peer.listen(0, '127.0.0.1', resolve);
  });
  const peerPort = (peer.address() as net.AddressInfo).port;
  if (!peerReachable) await new Promise<void>((resolve) => peer.close(() => resolve()));
  try {
    await test({
      ownAddress: '127.0.0.1',
      peerAddress: '127.0.0.1',
      peerPort,
      port: (server.address() as net.AddressInfo).port,
      ownFile,
      ownMarker: 'own-marker',
      peerFile: path.join(root, 'peer-private.txt'),
      peerHostFile: path.join(root, 'unmounted', 'private.txt'),
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (peerReachable) await new Promise<void>((resolve) => peer.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('active agent guest probe', () => {
  it('passes isolated filesystem and TCP probes with a working own endpoint', async () => {
    await fixture(async (input) => {
      const result = await execute(activeAgentProbe(input));
      expect(result).toMatchObject({ code: 0, stdout: 'area51-active-agent-isolation-ok\n', stderr: '' });
      expect(fs.readFileSync(input.ownFile, 'utf8')).toBe('own-marker');
      expect(fs.readFileSync(input.peerFile, 'utf8')).toBe('cross-agent-overwrite');
    });
  });

  it('rejects a deliberately exposed peer file', async () => {
    await fixture(async (input) => {
      fs.mkdirSync(path.dirname(input.peerHostFile));
      fs.writeFileSync(input.peerHostFile, 'peer-marker');
      const result = await execute(activeAgentProbe(input));
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('peer host private file readable');
      expect(result.stdout).not.toContain('isolation-ok');
    });
  });

  it('rejects a reachable peer even when its response is not the expected marker', async () => {
    await fixture(async (input) => {
      const result = await execute(activeAgentProbe(input));
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('raw TCP reached active peer');
    }, true);
  });

  it('does not interpret a dead own endpoint as successful isolation', async () => {
    await fixture(async (input) => {
      const result = await execute(activeAgentProbe({ ...input, port: input.peerPort!, peerPort: input.port }));
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('own listening TCP endpoint positive control failed');
    });
  });

  it('rejects ambiguous addresses and invalid ports', () => {
    const input = {
      ownAddress: '10.0.0.2',
      peerAddress: '10.0.1.2',
      port: 18451,
      ownFile: '/workspace/a',
      ownMarker: 'a',
      peerFile: '/workspace/b',
      peerHostFile: '/host/b',
    };
    expect(() => activeAgentProbe({ ...input, peerAddress: input.ownAddress })).toThrow('distinct IPv4');
    expect(() => activeAgentProbe({ ...input, port: 65536 })).toThrow('invalid probe port');
  });
});
