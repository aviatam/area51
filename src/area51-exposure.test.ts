import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { exposeArea51, formatArea51ExposureReport, type CommandRunner } from './area51-exposure.js';

describe('exposeArea51', () => {
  it('exposes one report for an agent target with gate, runtime policy, verify, and findings', async () => {
    const dir = tempDir();
    writeFile(path.join(dir, 'CLAUDE.md'), 'You are a support agent.');
    writeFile(path.join(dir, 'security-policy.md'), 'Ask before high-risk actions.');
    writeFile(
      path.join(dir, '.area51', 'agent-gate', 'scenarios', 'approval.json'),
      JSON.stringify({ id: 'approval', expected: 'ask' }),
    );
    writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { verify: 'vitest run' }, dependencies: { zod: '4.0.0' } }),
    );

    const report = await exposeArea51({
      targetPath: dir,
      targetType: 'agent',
      env: { ANTHROPIC_API_KEY: 'test-key' },
      incusAvailable: true,
      runner: successfulRunner,
      now: new Date('2026-08-15T00:00:00.000Z'),
    });

    expect(report.schema).toBe('area51.exposure.v1');
    expect(report.target.type).toBe('agent');
    expect(report.agent_gate?.passed).toBe(true);
    expect(report.runtime_policy?.action).toBe('allow');
    expect(report.checks[0]).toMatchObject({ name: 'package verify', status: 'passed' });
    expect(report.findings.map((finding) => finding.surface)).toContain('runtime-policy');
    expect(formatArea51ExposureReport(report)).toContain('Area51 exposure:');
  });

  it('skips Agent Gate for a normal repo and explains that verification is missing', async () => {
    const dir = tempDir();
    writeFile(path.join(dir, 'README.md'), '# App');
    writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));

    const report = await exposeArea51({
      targetPath: dir,
      targetType: 'repo',
      runner: successfulRunner,
      now: new Date('2026-08-15T00:00:00.000Z'),
    });

    expect(report.agent_gate).toBeUndefined();
    expect(report.runtime_policy).toBeUndefined();
    expect(report.summary.status).toBe('warn');
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'agent-gate-not-applicable', severity: 'info' }),
        expect.objectContaining({ id: 'verify-skipped', severity: 'warning' }),
      ]),
    );
  });

  it('turns a failing verify script into a high finding without shell execution', async () => {
    const dir = tempDir();
    writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { verify: 'echo should-not-run-in-test' } }));
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = (command, args) => {
      calls.push({ command, args });
      return { status: 1, stdout: 'output', stderr: 'failure', error: undefined };
    };

    const report = await exposeArea51({
      targetPath: dir,
      targetType: 'repo',
      runner,
      now: new Date('2026-08-15T00:00:00.000Z'),
    });

    expect(calls).toEqual([{ command: 'pnpm', args: ['run', 'verify'] }]);
    expect(report.summary.status).toBe('fail');
    expect(report.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'verify-failed', severity: 'high' })]),
    );
  });
});

function successfulRunner() {
  return { status: 0, stdout: 'ok', stderr: '', error: undefined };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'area51-exposure-test-'));
}

function writeFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents + '\n');
}
