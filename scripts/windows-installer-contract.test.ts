import fs from 'fs';
import { spawnSync } from 'child_process';
import { describe, expect, it } from 'vitest';

const windowsInstaller = fs.readFileSync(new URL('../install-windows.ps1', import.meta.url), 'utf8');
const wslInstaller = fs.readFileSync(new URL('../install-wsl.sh', import.meta.url), 'utf8');

describe('Windows/WSL2 one-command installer contract', () => {
  it('uses the supported WSL2 installation and restart path', () => {
    expect(windowsInstaller).toContain('Windows 10 build 19041 or Windows 11');
    expect(windowsInstaller).toContain('wsl.exe --install -d $Distribution --no-launch');
    expect(windowsInstaller).toContain('wsl.exe --set-version $Distribution 2');
    expect(windowsInstaller).toContain('wsl.exe --terminate $Distribution');
    expect(windowsInstaller).toContain('install-wsl.sh');
  });

  it('fails closed on the WSL guest contract and delegates to existing setup', () => {
    expect(wslInstaller).toContain("grep -qi 'microsoft\\|wsl' /proc/version");
    expect(wslInstaller).toContain('[ "$(id -u)" -ne 0 ]');
    expect(wslInstaller).toContain('at least 4GB RAM must be assigned to WSL2');
    expect(wslInstaller).toContain('systemd=true');
    expect(wslInstaller).toContain('status --porcelain');
    expect(wslInstaller).toContain('bash area51.sh');
  });

  it('does not claim native Windows or Incus VM isolation', () => {
    expect(windowsInstaller).toContain('Runtime: Docker in WSL2');
    expect(windowsInstaller).toContain('Incus/KVM isolation remains Linux-host only');
    expect(wslInstaller).not.toContain('deploy.sh --mode production');
  });

  it.skipIf(process.platform !== 'win32')('executes the Windows plan without making changes', () => {
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'install-windows.ps1', '-Plan'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('PASS supported Windows build');
    expect(result.stdout).toContain('PLAN install Area51 in WSL2');
  });
});
