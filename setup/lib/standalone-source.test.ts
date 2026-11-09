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

it.skipIf(process.platform === 'win32')('requires an accessible explicit registry without adding upstream remotes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-source-test-'));
  const helper = path.resolve('setup/lib/channels-remote.sh');
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const resolve = (remote = '', branch = 'channels') =>
    execFileSync('bash', ['-c', 'source "$1"; resolve_channels_remote "$2"', 'bash', helper, branch], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AREA51_CHANNELS_REMOTE: remote },
    }).trim();
  try {
    git('init');
    git('remote', 'add', 'upstream', 'https://github.com/nanocoai/nanoclaw.git');
    git('remote', 'add', 'spoof', 'https://evil.example/aviatam/area51.git');
    expect(() => resolve()).toThrow(/No registry remote configured/);
    expect(git('remote')).not.toContain('area51-source');
    expect(git('remote', 'get-url', 'upstream')).toBe('https://github.com/nanocoai/nanoclaw.git');
    git('remote', 'add', 'registry', root);
    expect(() => resolve('registry')).toThrow(/absent or inaccessible/);
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');
    git('branch', 'channels');
    expect(resolve('registry')).toBe('registry');
    expect(() => resolve('registry', 'providers')).toThrow(/absent or inaccessible/);
    git('branch', 'providers');
    expect(resolve('registry', 'providers')).toBe('registry');
    expect(() => resolve('registry', 'main')).toThrow(/Unsupported registry branch/);
    expect(() => resolve('missing')).toThrow(/No registry remote configured/);
    expect(() => resolve('registry; echo unsafe')).toThrow(/name is invalid/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
