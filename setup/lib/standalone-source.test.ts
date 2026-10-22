import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { emit } from './diagnostics.js';

it('does not transmit inherited setup diagnostics', () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  try {
    emit('setup_started', { status: 'success' });
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it.skipIf(process.platform === 'win32')(
  'preserves a NanoClaw upstream and resolves an Area51-owned source instead',
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-source-test-'));
    const helper = path.resolve('setup/lib/channels-remote.sh');
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const resolve = () =>
      execFileSync('bash', ['-c', 'source "$1"; resolve_channels_remote', 'bash', helper], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, AREA51_CHANNELS_REMOTE: '' },
      }).trim();
    try {
      git('init');
      git('remote', 'add', 'upstream', 'https://github.com/nanocoai/nanoclaw.git');
      git('remote', 'add', 'spoof', 'https://evil.example/aviatam/area51.git');
      expect(resolve()).toBe('area51-source');
      expect(git('remote', 'get-url', 'upstream')).toBe('https://github.com/nanocoai/nanoclaw.git');
      expect(git('remote', 'get-url', 'area51-source')).toBe('https://github.com/aviatam/area51.git');
      expect(resolve()).toBe('area51-source');
      git('remote', 'set-url', 'area51-source', 'https://example.com/wrong.git');
      expect(() => resolve()).toThrow();
      expect(git('remote', 'get-url', 'area51-source')).toBe('https://example.com/wrong.git');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
