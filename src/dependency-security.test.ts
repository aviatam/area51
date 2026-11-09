import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scanAgentGate } from './agent-gate.js';
import { interpretDependencyReport, stageDependencyFiles } from './dependency-security.js';
import { selectRuntimePolicy } from './runtime-policy.js';
import { buildIncusRuntimePlan } from './incus-runtime.js';
import { enforceIncusRuntimeDecision } from './incus-quarantine-policy.js';

const roots: string[] = [];
function temp() {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-security-test-'));
  roots.push(p);
  return p;
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
describe('native dependency security', () => {
  it('requires coverage for live preflight without an enable flag', async () => {
    vi.stubEnv('AREA51_DEPENDENCY_SECURITY', '');
    const root = temp();
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'A test agent.');
    const report = await scanAgentGate({
      groupDir: root,
      requiredSecrets: [],
      env: {},
      dependencySecurity: 'required',
    });
    expect(report.dependency_scan?.status).toBe('incomplete');
    expect(
      report.findings.some(
        (f) => f.id === (process.platform === 'linux' ? 'dependency-inventory-missing' : 'dependency-scan-incomplete'),
      ),
    ).toBe(true);
    expect(selectRuntimePolicy(report, { incusAvailable: false }).action).toBe('block');
  });
  it('reaches the scanner through the real Agent Gate and reports disabled coverage explicitly', async () => {
    vi.stubEnv('AREA51_DEPENDENCY_SECURITY', '');
    const root = temp();
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'A test agent.');
    const report = await scanAgentGate({ groupDir: root, requiredSecrets: [], env: {} });
    expect(report.dependency_scan?.status).toBe('disabled');
  });
  it('blocks an invalid scanner binary through the real preflight and policy', async () => {
    const root = temp();
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'A test agent.');
    fs.writeFileSync(path.join(root, 'Cargo.lock'), 'version=3\n');
    const binary = path.join(temp(), 'untrusted-scanner');
    fs.writeFileSync(binary, 'not the pinned scanner');
    vi.stubEnv('AREA51_DEPENDENCY_SECURITY', 'required');
    vi.stubEnv('AREA51_DEPENDENCY_SCANNER', binary);
    const report = await scanAgentGate({ groupDir: root, requiredSecrets: [], env: {}, quarantine: false });
    expect(report.dependency_scan?.status).toBe('incomplete');
    expect(report.findings.some((f) => f.id === 'dependency-scan-incomplete')).toBe(true);
    expect(selectRuntimePolicy(report, { incusAvailable: false, allowDockerFallback: false }).action).toBe('block');
  });
  it.each(['npm', 'PyPI', 'Maven', 'crates.io', 'Go', 'NuGet'])(
    'carries %s advisories to the actual quarantine adapter',
    async (ecosystem) => {
      const root = temp(),
        source = path.join(root, 'Cargo.lock');
      const parsed = interpretDependencyReport(
        {
          results: [
            {
              source: { path: source },
              packages: [
                {
                  package: { name: 'test-package', version: '1.0.0', ecosystem },
                  vulnerabilities: [{ id: 'GHSA-test-test-test' }],
                },
              ],
            },
          ],
        },
        root,
        ['Cargo.lock'],
      );
      const group = temp();
      fs.writeFileSync(path.join(group, 'AGENTS.md'), 'A test agent.');
      const report = await scanAgentGate({ groupDir: group, requiredSecrets: [], env: {}, quarantine: false });
      report.findings.push(...parsed.findings);
      const decision = selectRuntimePolicy(report, { profile: 'maximum', incusAvailable: true });
      expect(decision.action).toBe('quarantine');
      const plan = buildIncusRuntimePlan({
        agentGroupFolder: 'dependency-test',
        groupDir: group,
        instanceKind: 'vm',
        mounts: [],
        vmNetwork: {
          network: 'dependency-net',
          acl: 'dependency-acl',
          ipv4Cidr: '10.90.0.1/24',
          oneCliAddress: '10.90.0.1',
          oneCliPort: 10255,
        },
        vmDisks: {
          pool: 'default',
          volumes: [{ name: 'dependency-work', source: group, path: '/workspace', readonly: false, size: '1GiB' }],
        },
      });
      const executor = vi.fn((argv: string[]) =>
        argv[0] === 'list' ? JSON.stringify([{ name: plan.instance, status: 'Stopped' }]) : '',
      );
      enforceIncusRuntimeDecision(decision, plan, { executor });
      expect(executor).toHaveBeenCalledWith(['stop', plan.instance, '--force', '--project', plan.project]);
    },
  );
  it('retains local LiteLLM emergency detection even if the external feed has no entry', () => {
    const root = temp();
    const parsed = interpretDependencyReport(
      {
        results: [
          {
            source: { path: path.join(root, 'uv.lock') },
            packages: [{ package: { name: 'litellm', version: '1.107.0', ecosystem: 'PyPI' }, vulnerabilities: [] }],
          },
        ],
      },
      root,
      ['uv.lock'],
    );
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0].detail).toContain('Known malicious');
  });
  it('does not turn a malformed or partially missing inventory into a clean result', () => {
    const root = temp();
    expect(() => interpretDependencyReport({ results: [] }, root, ['uv.lock'])).toThrow();
    expect(() =>
      interpretDependencyReport(
        {
          results: [
            { source: { path: path.join(root, 'uv.lock') }, packages: [{ package: { name: 'x', ecosystem: 'PyPI' } }] },
          ],
        },
        root,
        ['uv.lock'],
      ),
    ).toThrow();
    expect(() =>
      interpretDependencyReport({ results: [{ source: { path: '/outside/uv.lock' }, packages: [] }] }, root, [
        'uv.lock',
      ]),
    ).toThrow();
  });
  it.skipIf(process.platform !== 'linux')(
    'stages nested dependency evidence but leaves agent ignore rules, code and environment files behind',
    () => {
      const root = temp(),
        destination = temp();
      fs.mkdirSync(path.join(root, 'nested'));
      fs.mkdirSync(path.join(root, 'node_modules'));
      fs.writeFileSync(path.join(root, 'nested', 'poetry.lock'), 'fixture');
      fs.writeFileSync(path.join(root, 'node_modules', 'Cargo.lock'), 'ignored');
      fs.writeFileSync(path.join(root, 'osv-scanner.toml'), '[[IgnoredVulns]]');
      fs.writeFileSync(path.join(root, '.env'), 'HOST_SECRET=never-copy');
      fs.writeFileSync(path.join(root, 'setup.py'), 'raise Exception("never execute")');
      const files = stageDependencyFiles(root, destination);
      expect(files.map((f) => f.path)).toEqual(['nested/poetry.lock']);
      expect(fs.readdirSync(destination)).toEqual(['nested']);
    },
  );
  it.skipIf(process.platform !== 'linux')('rejects a symlink inventory without following it', () => {
    const root = temp(),
      outside = temp();
    fs.writeFileSync(path.join(outside, 'secret'), 'secret');
    fs.symlinkSync(path.join(outside, 'secret'), path.join(root, 'uv.lock'));
    expect(() => stageDependencyFiles(root, temp())).toThrow('non-regular');
  });
  it.skipIf(process.platform !== 'linux')('rejects a directory swap before opening the child', () => {
    const root = temp(),
      outside = temp(),
      destination = temp();
    const nested = path.join(root, 'nested');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, 'uv.lock'), 'original');
    fs.writeFileSync(path.join(outside, 'uv.lock'), 'outside');
    const readdir = fs.readdirSync.bind(fs);
    let swapped = false;
    vi.spyOn(fs, 'readdirSync').mockImplementation(((directory: fs.PathLike, options: unknown) => {
      const entries = readdir(directory, options as never);
      if (!swapped && fs.statSync(directory).ino === fs.statSync(root).ino) {
        swapped = true;
        fs.renameSync(nested, nested + '-saved');
        fs.symlinkSync(outside, nested);
      }
      return entries;
    }) as typeof fs.readdirSync);
    expect(() => stageDependencyFiles(root, destination)).toThrow();
    expect(swapped).toBe(true);
    expect(fs.readdirSync(destination)).toEqual([]);
  });
  it.skipIf(process.platform !== 'linux')('keeps an opened directory anchored after its path is replaced', () => {
    const root = temp(),
      outside = temp(),
      destination = temp();
    const nested = path.join(root, 'nested');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, 'uv.lock'), 'original');
    fs.writeFileSync(path.join(outside, 'uv.lock'), 'outside');
    const inode = fs.statSync(nested).ino;
    const readdir = fs.readdirSync.bind(fs);
    let swapped = false;
    vi.spyOn(fs, 'readdirSync').mockImplementation(((directory: fs.PathLike, options: unknown) => {
      if (!swapped && fs.statSync(directory).ino === inode) {
        swapped = true;
        fs.renameSync(nested, nested + '-saved');
        fs.symlinkSync(outside, nested);
      }
      return readdir(directory, options as never);
    }) as typeof fs.readdirSync);
    expect(stageDependencyFiles(root, destination).map((f) => f.path)).toEqual(['nested/uv.lock']);
    expect(swapped).toBe(true);
    expect(fs.readFileSync(path.join(destination, 'nested', 'uv.lock'), 'utf8')).toBe('original');
  });
  it.skipIf(process.platform !== 'linux')('charges actual copied bytes when files grow after stat', () => {
    const root = temp(),
      destination = temp();
    for (let i = 0; i < 9; i++) fs.writeFileSync(path.join(root, `${i}.cdx.json`), 'x');
    const fstat = fs.fstatSync.bind(fs);
    vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number) => {
      const stat = fstat(fd);
      const source = fs.readlinkSync(`/proc/self/fd/${fd}`);
      if (source.endsWith('.cdx.json')) fs.writeFileSync(source, Buffer.alloc(1_900_000, 32));
      return stat;
    }) as typeof fs.fstatSync);
    expect(() => stageDependencyFiles(root, destination)).toThrow('budget');
    const bytes = fs
      .readdirSync(destination)
      .reduce((total, name) => total + fs.statSync(path.join(destination, name)).size, 0);
    expect(bytes).toBe(8 * 1_900_000);
  });
  it.skipIf(process.platform !== 'linux')(
    'bounds the read when an opened file grows beyond the individual limit',
    () => {
      const root = temp();
      const source = path.join(root, 'uv.lock');
      fs.writeFileSync(source, 'x');
      const fstat = fs.fstatSync.bind(fs);
      vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number) => {
        const stat = fstat(fd);
        fs.writeFileSync(source, Buffer.alloc(3_000_000));
        return stat;
      }) as typeof fs.fstatSync);
      const read = vi.spyOn(fs, 'readSync');
      expect(() => stageDependencyFiles(root, temp())).toThrow('budget');
      expect(read.mock.calls.every((call) => call[1].byteLength <= 2_000_001)).toBe(true);
    },
  );
  it.skipIf(process.platform !== 'linux')('rejects symlinks in the input root ancestry', () => {
    const parent = temp(),
      outside = temp();
    fs.mkdirSync(path.join(outside, 'group'));
    fs.writeFileSync(path.join(outside, 'group', 'uv.lock'), 'outside');
    fs.symlinkSync(outside, path.join(parent, 'link'));
    expect(() => stageDependencyFiles(path.join(parent, 'link', 'group'), temp())).toThrow();
  });
  it.skipIf(process.platform !== 'linux')('fails closed without procfs descriptor lookup', () => {
    vi.spyOn(fs, 'statfsSync').mockReturnValue({ type: 0 } as fs.StatsFs);
    expect(() => stageDependencyFiles(temp(), temp())).toThrow('Linux procfs');
  });
  it('fails closed when descriptor-relative staging is unsupported', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    expect(() => stageDependencyFiles(temp(), temp())).toThrow('Linux procfs');
  });
  it.skipIf(process.platform !== 'linux')(
    'rejects ranged requirements rather than treating an extracted lower bound as installed',
    () => {
      const root = temp();
      fs.writeFileSync(path.join(root, 'requirements.txt'), 'requests>=2.0\n');
      expect(() => stageDependencyFiles(root, temp())).toThrow('exact pins');
    },
  );
  it('rejects empty package results and version ranges', () => {
    const root = temp();
    expect(() =>
      interpretDependencyReport({ results: [{ source: { path: path.join(root, 'uv.lock') }, packages: [] }] }, root, [
        'uv.lock',
      ]),
    ).toThrow('empty');
    expect(() =>
      interpretDependencyReport(
        {
          results: [
            {
              source: { path: path.join(root, 'uv.lock') },
              packages: [{ package: { name: 'requests', version: '>=2.0', ecosystem: 'PyPI' } }],
            },
          ],
        },
        root,
        ['uv.lock'],
      ),
    ).toThrow('unresolved');
  });
  it('ignores withdrawn advisories and preserves a no-advisory control as evidence, not a safety certification', () => {
    const root = temp();
    const parsed = interpretDependencyReport(
      {
        results: [
          {
            source: { path: path.join(root, 'uv.lock') },
            packages: [
              {
                package: { name: 'control', version: '1.0.0', ecosystem: 'PyPI' },
                vulnerabilities: [{ id: 'GHSA-withdrawn', withdrawn: '2026-01-01T00:00:00Z' }],
              },
            ],
          },
        ],
      },
      root,
      ['uv.lock'],
    );
    expect(parsed.findings).toEqual([]);
    expect(parsed.packages).toHaveLength(1);
  });
});
