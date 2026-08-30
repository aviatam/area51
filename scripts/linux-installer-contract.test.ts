import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { describe, expect, it } from 'vitest';

const installer = fs.readFileSync(new URL('../install-linux.sh', import.meta.url), 'utf8');

describe('Linux one-command installer contract', () => {
  it('fails closed on platform, user, distro, KVM, and memory prerequisites', () => {
    expect(installer).toContain('[ "$(uname -s)" = Linux ]');
    expect(installer).toContain('[ "$(id -u)" -ne 0 ]');
    expect(installer).toContain('Ubuntu 22.04/24.04, Debian 12/13');
    expect(installer).toContain('KVM_DEVICE');
    expect(installer).toContain('at least 4GB RAM is required');
    expect(installer).toContain('exit 2');
  });

  it('pins and verifies the Incus repository before installing', () => {
    expect(installer).toContain('4EFC590696CB15B87C73A3AD82CC8797C838DCFD');
    expect(installer).toContain('https://pkgs.zabbly.com/incus/lts-7.0');
    expect(installer.indexOf('fingerprint mismatch')).toBeLessThan(
      installer.indexOf('apt-get install -y --no-install-recommends incus'),
    );
  });

  it('initializes Incus idempotently and delegates to fail-closed production deployment', () => {
    expect(installer).toContain('incus admin init --minimal');
    expect(installer).toContain('status --porcelain');
    expect(installer).toContain('deploy.sh --mode production');
    expect(installer).not.toContain('--mode contract');
  });

  it('executes the supported-host plan without making installation changes', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-linux-plan-'));
    const osRelease = path.join(fixture, 'os-release');
    const kvm = path.join(fixture, 'kvm');
    fs.writeFileSync(osRelease, 'ID=ubuntu\nVERSION_CODENAME=noble\n');
    fs.writeFileSync(kvm, 'test-device');
    const result = spawnSync('bash', ['install-linux.sh', '--plan'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        AREA51_OS_RELEASE_FILE: osRelease,
        AREA51_KVM_DEVICE: kvm,
        AREA51_PLAN_ALLOW_ROOT: '1',
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('supported distribution ubuntu/noble');
    expect(result.stdout).toContain('PLAN install Area51');
    expect(result.stdout).not.toContain('apt-get update');
  });
});
