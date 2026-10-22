import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentGateFinding } from './agent-gate.js';
import { isKnownCompromisedPythonPackage } from './python-package-risk.js';
import pins from './dependency-security-pins.json' with { type: 'json' };
import { ensureDependencyScanner } from './dependency-scanner.js';

export const DEPENDENCY_FORMATS: Record<string, string> = {
  'package-lock.json': 'npm',
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'Yarn',
  'bun.lock': 'Bun',
  'requirements.txt': 'pip',
  'requirements.lock': 'pip',
  'uv.lock': 'uv',
  'poetry.lock': 'Poetry',
  'Pipfile.lock': 'Pipenv',
  'pdm.lock': 'PDM',
  'pylock.toml': 'Python',
  'pom.xml': 'Maven',
  'gradle.lockfile': 'Gradle',
  'buildscript-gradle.lockfile': 'Gradle',
  'Cargo.lock': 'Cargo',
  'go.mod': 'Go',
  'packages.lock.json': 'NuGet',
  'packages.config': 'NuGet',
};
const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', 'target', 'dist', '.area51']);
const ECOSYSTEMS = new Set(['npm', 'PyPI', 'Maven', 'crates.io', 'Go', 'NuGet']);
const supported = (name: string): boolean =>
  name in DEPENDENCY_FORMATS || name === 'bom.json' || /\.(?:cdx|spdx)\.json$/.test(name);
interface Package {
  name: string;
  version: string;
  ecosystem: string;
  source: string;
  advisoryIds: string[];
}
export interface DependencySecurityResult {
  findings: AgentGateFinding[];
  evidenceFiles: string[];
  summary: {
    status: 'disabled' | 'complete' | 'incomplete';
    scanner: string;
    checked_at: string;
    files: string[];
    packages: Package[];
    limitations: string[];
  };
}
const issue = (id: string, detail: string, evidence: string[] = []): AgentGateFinding => ({
  id: `dependency-${id}`,
  severity: 'high',
  pillar: 'security',
  title: 'Dependency security requires host review',
  detail,
  evidence,
  recommendation:
    'Keep the workload stopped or isolated, review the evidence, and rebuild from reviewed resolved dependencies.',
});

/** Only regular, bounded dependency files are staged. Agent ignore/config files and executable code never reach the scanner. */
export function stageDependencyFiles(groupDir: string, destination: string): Array<{ path: string; sha256: string }> {
  const result: Array<{ path: string; sha256: string }> = [];
  let entries = 0,
    bytes = 0;
  const walk = (directory: string, depth: number): void => {
    if (depth > 12) throw new Error('directory depth budget');
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (++entries > 10000) throw new Error('directory entry budget');
      if (SKIP.has(entry.name)) continue;
      const source = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(source, depth + 1);
        continue;
      }
      if (!supported(entry.name)) continue;
      if (!entry.isFile()) throw new Error('non-regular dependency file');
      const size = fs.lstatSync(source).size;
      if (size > 2_000_000 || (bytes += size) > 16_000_000 || result.length >= 100)
        throw new Error('dependency file budget');
      const relative = path.relative(groupDir, source);
      const target = path.join(destination, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const fd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      let content: Buffer;
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > 2_000_000) throw new Error('changed dependency file');
        content = fs.readFileSync(fd);
        if (content.length > 2_000_000) throw new Error('dependency file grew during scan');
      } finally {
        fs.closeSync(fd);
      }
      if (entry.name === 'requirements.txt' || entry.name === 'requirements.lock') {
        for (const line of content.toString('utf8').split(/\r?\n/)) {
          if (!line.trim() || /^\s*(?:#|--hash=)/.test(line)) continue;
          if (!/^\s*[A-Za-z0-9][A-Za-z0-9_.-]*(?:\[[^\]]+\])?\s*==\s*[A-Za-z0-9_.+!-]+(?:\s|;|#|\\|$)/.test(line))
            throw new Error('requirements must be resolved exact pins');
        }
      }
      fs.writeFileSync(target, content, { mode: 0o600 });
      result.push({ path: relative.replace(/\\/g, '/'), sha256: createHash('sha256').update(content).digest('hex') });
    }
  };
  walk(path.resolve(groupDir), 0);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

/** Validate the pinned scanner's JSON, preserving ecosystem identity and all active advisories. */
export function interpretDependencyReport(
  raw: unknown,
  stagedRoot: string,
  expectedFiles: string[],
): { packages: Package[]; findings: AgentGateFinding[] } {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { results?: unknown }).results))
    throw new Error('scanner report');
  const packages: Package[] = [],
    findings: AgentGateFinding[] = [];
  const seenFiles = new Set<string>();
  for (const result of (raw as { results: unknown[] }).results) {
    const r = result as { source?: { path?: unknown }; packages?: unknown[] };
    if (typeof r?.source?.path !== 'string' || !Array.isArray(r.packages)) throw new Error('scanner source');
    const source = path.relative(stagedRoot, r.source.path).replace(/\\/g, '/');
    if (!expectedFiles.includes(source)) throw new Error('unrecognized scanner source');
    if (!r.packages.length) throw new Error('empty or unresolved dependency inventory');
    seenFiles.add(source);
    for (const entry of r.packages) {
      const p = entry as {
        package?: { name?: unknown; version?: unknown; ecosystem?: unknown };
        vulnerabilities?: unknown[];
      };
      const info = p?.package;
      if (
        typeof info?.name !== 'string' ||
        typeof info.version !== 'string' ||
        !info.version ||
        typeof info.ecosystem !== 'string' ||
        !ECOSYSTEMS.has(info.ecosystem)
      )
        throw new Error('unresolved package identity');
      if (!/^(?:v?\d)[A-Za-z0-9_.+!-]*$/.test(info.version)) throw new Error('unresolved package version');
      if (info.name.length > 512 || info.version.length > 200) throw new Error('package identity budget');
      if (p.vulnerabilities !== undefined && !Array.isArray(p.vulnerabilities)) throw new Error('advisory list');
      const ids = (p.vulnerabilities ?? []).flatMap((v) => {
        if (!v || typeof v !== 'object' || typeof (v as { id?: unknown }).id !== 'string')
          throw new Error('advisory identity');
        const advisory = v as { id: string; withdrawn?: unknown };
        if (!/^[A-Za-z0-9_.-]{1,180}$/.test(advisory.id)) throw new Error('advisory identity');
        return advisory.withdrawn ? [] : [advisory.id];
      });
      packages.push({ name: info.name, version: info.version, ecosystem: info.ecosystem, source, advisoryIds: ids });
      const knownMalware = info.ecosystem === 'PyPI' && isKnownCompromisedPythonPackage(info.name, info.version);
      if (ids.length || knownMalware) {
        const key = createHash('sha256')
          .update(`${source}:${info.ecosystem}:${info.name}:${info.version}`)
          .digest('hex')
          .slice(0, 16);
        findings.push(
          issue(
            `advisory-${key}`,
            knownMalware
              ? `Known malicious release: ${info.name}@${info.version}.`
              : `Reported vulnerability in ${info.ecosystem} ${info.name}@${info.version}; conservative policy requires review. An advisory is not proof of exploitation.`,
            [source, ...ids.map((id) => `https://osv.dev/vulnerability/${id}`)],
          ),
        );
      }
      if (packages.length > 5000) throw new Error('package inventory budget');
    }
  }
  // A parser that silently skips a file must not turn an incomplete inventory into a clean scan.
  if (expectedFiles.some((file) => !seenFiles.has(file)))
    throw new Error('dependency files missing from scanner output');
  return { packages, findings };
}

export async function scanDependencySecurity(
  groupDir: string,
  options: { preserveEvidence?: boolean; required?: boolean } = {},
): Promise<DependencySecurityResult> {
  const result: DependencySecurityResult = {
    findings: [],
    evidenceFiles: [],
    summary: {
      status: 'disabled',
      scanner: `OSV-Scanner ${pins.version}`,
      checked_at: new Date().toISOString(),
      files: [],
      packages: [],
      limitations: [
        'Known advisory and supplied-version evidence; no unknown-malware detection or artifact attestation.',
        'Maven manifest resolution and build/call analysis are disabled. Use resolved lockfiles or SBOMs for complete transitive coverage.',
        'Inventories describe declared dependencies, not installed-package attestation. The live host refreshes running sessions every 60 seconds; scans may take up to 90 seconds.',
      ],
    },
  };
  if (!options.required && process.env.AREA51_DEPENDENCY_SECURITY !== 'required') return result;
  result.summary.status = 'incomplete';
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-dependency-scan-'));
  const staged = path.join(temporary, 'inputs');
  fs.mkdirSync(staged);
  try {
    const files = stageDependencyFiles(groupDir, staged);
    result.summary.files = files.map((f) => f.path);
    if (!files.length) {
      result.findings.push(
        issue(
          'inventory-missing',
          'Required dependency scanning found no supported resolved inventory. Supply a supported lockfile or pinned manifest.',
        ),
      );
      return result;
    }
    const binary = await ensureDependencyScanner();
    const asset = pins.assets[`${process.platform}-${process.arch}` as keyof typeof pins.assets];
    if (
      !binary ||
      !path.isAbsolute(binary) ||
      !asset ||
      !fs.lstatSync(binary).isFile() ||
      fs.lstatSync(binary).isSymbolicLink()
    )
      throw new Error('scanner configuration');
    if (createHash('sha256').update(fs.readFileSync(binary)).digest('hex') !== asset.sha256)
      throw new Error('scanner integrity');
    const trustedConfig = path.join(temporary, 'host-config.toml');
    fs.writeFileSync(trustedConfig, '# Host-owned empty policy; agent ignore rules are not consulted.\n', {
      mode: 0o600,
    });
    const args = [
      'scan',
      'source',
      '--no-ignore',
      '--no-resolve',
      '--no-call-analysis=go',
      '--no-call-analysis=rust',
      '--all-packages',
      '--all-vulns',
      '--format=json',
      `--config=${trustedConfig}`,
      ...files.map(
        (file) =>
          `--lockfile=${path.basename(file.path) === 'requirements.lock' ? 'requirements.txt:' : ':'}${path.join(staged, file.path)}`,
      ),
    ];
    const execution = await new Promise<{ stdout: string; code: number }>((resolve, reject) => {
      execFile(
        binary,
        args,
        {
          cwd: temporary,
          env: {
            // Explicit host network configuration only; provider, CI and agent secrets are excluded.
            ...Object.fromEntries(
              [
                'HTTP_PROXY',
                'HTTPS_PROXY',
                'NO_PROXY',
                'http_proxy',
                'https_proxy',
                'no_proxy',
                'SSL_CERT_FILE',
                'SSL_CERT_DIR',
              ].flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])),
            ),
            HOME: temporary,
            USERPROFILE: temporary,
            TEMP: temporary,
            TMP: temporary,
            TMPDIR: temporary,
            LOCALAPPDATA: temporary,
            XDG_CACHE_HOME: path.join(temporary, 'cache'),
            PATH:
              process.platform === 'win32' ? (process.env.SystemRoot ?? 'C:\\Windows') + '\\System32' : '/usr/bin:/bin',
            ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } : {}),
          },
          timeout: 90000,
          maxBuffer: 16_000_000,
          windowsHide: true,
        },
        (error, stdout) => {
          const code = error ? (error as { code?: unknown }).code : 0;
          if (code !== 0 && code !== 1) return reject(new Error('scanner unavailable or incomplete'));
          resolve({ stdout, code });
        },
      );
    });
    const interpreted = interpretDependencyReport(JSON.parse(execution.stdout), staged, result.summary.files);
    if (execution.code === 1 && !interpreted.findings.length) throw new Error('inconsistent scanner result');
    result.summary.packages = interpreted.packages;
    result.findings.push(...interpreted.findings);
    result.summary.status = 'complete';
    if (result.findings.length && options.preserveEvidence !== false) {
      const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-dependency-evidence-'));
      fs.cpSync(staged, path.join(evidence, 'inputs'), { recursive: true });
      const reportFile = path.join(evidence, 'scan.json');
      fs.writeFileSync(
        reportFile,
        JSON.stringify(
          { id: randomUUID(), ...result.summary, input_hashes: files, findings: result.findings },
          null,
          2,
        ) + '\n',
        { mode: 0o600 },
      );
      result.evidenceFiles.push(reportFile, ...files.map((f) => path.join(evidence, 'inputs', f.path)));
    }
    return result;
    // eslint-disable-next-line no-catch-all/no-catch-all -- scanner failures are unknown coverage and must fail closed
  } catch (_error) {
    result.findings.push(
      issue(
        'scan-incomplete',
        'Dependency scan could not be completed or verified. This is unknown exposure, not a clean result.',
        result.summary.files,
      ),
    );
    return result;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
