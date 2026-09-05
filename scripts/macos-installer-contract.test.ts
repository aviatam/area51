import fs from 'fs';
import { spawnSync } from 'child_process';
import { describe, expect, it } from 'vitest';

const installer = fs.readFileSync(new URL('../install-macos.sh', import.meta.url), 'utf8');

describe('macOS one-command installer contract', () => {
  it('checks the supported host before making changes', () => {
    expect(installer).toContain('[ "$(uname -s)" = Darwin ]');
    expect(installer).toContain('[ "$(id -u)" -ne 0 ]');
    expect(installer).toContain('arm64|x86_64');
    expect(installer).toContain('at least 4GB RAM is required');
    expect(installer.indexOf('prerequisite check failed')).toBeLessThan(
      installer.indexOf('Homebrew/install/HEAD/install.sh'),
    );
  });

  it('installs the prerequisites and delegates to the existing setup', () => {
    expect(installer).toContain('Homebrew/install/HEAD/install.sh');
    expect(installer).toContain('brew install git');
    expect(installer).toContain('status --porcelain');
    expect(installer).toContain('bash area51.sh');
  });

  it('states the supported runtime and does not claim Linux isolation', () => {
    expect(installer).toContain('Runtime: Docker Desktop; service: launchd');
    expect(installer).toContain('production Incus/KVM isolation');
    expect(installer).not.toContain('deploy.sh --mode production');
  });

  it.skipIf(process.platform !== 'darwin')('executes its plan without making installation changes', () => {
    const result = spawnSync('bash', ['install-macos.sh', '--plan'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('PASS macOS host');
    expect(result.stdout).toContain('PLAN install Area51');
    expect(result.stdout).not.toContain('Cloning into');
  });
});
