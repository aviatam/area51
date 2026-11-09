import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('test network isolation', () => {
  it('propagates isolation to child Node processes', () => {
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import net from 'node:net';
      const socket = new net.Socket();
      try { socket.connect({host:'example.invalid',port:443}); process.exitCode=1; }
      catch(error) { if (!error.message.includes('External network disabled')) throw error; console.log('blocked'); }
      finally { socket.destroy(); }
    `,
      ],
      { encoding: 'utf8', timeout: 5000 },
    );
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.trim()).toBe('blocked');
  });
  it('rejects external fetch before a service request can leave', async () => {
    await expect(fetch('https://api.onecli.sh/v1/agents')).rejects.toThrow('External network disabled');
  });
  it('rejects external raw TCP connections synchronously', () => {
    const socket = new net.Socket();
    try {
      expect(() => socket.connect({ host: 'example.com', port: 443 })).toThrow('External network disabled');
    } finally {
      socket.destroy();
    }
  });
});
