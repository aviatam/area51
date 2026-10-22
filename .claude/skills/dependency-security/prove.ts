/** Known vulnerable versions are metadata fixtures only. This proof installs or executes no target package. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { monitorDependencies, writeDependencyHold, assertNoDependencyHold } from '../../../src/dependency-monitor.js';
import { scanAgentGate } from '../../../src/agent-gate.js';
import { selectRuntimePolicy } from '../../../src/runtime-policy.js';
import { buildIncusRuntimePlan } from '../../../src/incus-runtime.js';
import { enforceIncusRuntimeDecision } from '../../../src/incus-quarantine-policy.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(fs.readFileSync(path.join(directory, 'fixtures.json'), 'utf8')) as Array<{
  manager: string;
  file: string;
  content: string;
  name: string;
  version: string;
  ecosystem: string;
}>;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-multi-manager-'));
const out = path.resolve(process.env.AREA51_DEPENDENCY_PROOF_OUTPUT ?? '.area51/diagnostics/dependency-security');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Metadata-only security probe.');
for (const fixture of fixtures) {
  const dir = path.join(root, fixture.manager);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, fixture.file), fixture.content);
}
try {
  const report = await scanAgentGate({
    groupDir: root,
    requiredSecrets: [],
    env: {},
    quarantine: true,
    dependencySecurity: 'required',
  });
  const summary = report.dependency_scan as {
    status: string;
    scanner: string;
    checked_at: string;
    packages: Array<{ name: string; version: string; ecosystem: string; source: string; advisoryIds: string[] }>;
  };
  if (summary?.status !== 'complete') throw new Error('Live dependency scan is incomplete');
  const rows = fixtures.map((fixture) => {
    const found = summary.packages.find(
      (p) =>
        p.name.toLowerCase() === fixture.name.toLowerCase() &&
        p.version.replace(/^v/, '') === fixture.version.replace(/^v/, '') &&
        p.ecosystem === fixture.ecosystem &&
        p.source === `${fixture.manager}/${fixture.file}`,
    );
    if (!found || !found.advisoryIds.length) throw new Error(`Missing live advisory evidence for ${fixture.manager}`);
    return {
      manager: fixture.manager,
      file: found.source,
      ecosystem: found.ecosystem,
      package: found.name,
      version: found.version,
      advisories: found.advisoryIds,
      detected: true,
    };
  });
  const decision = selectRuntimePolicy(report, { profile: 'maximum', incusAvailable: true });
  if (report.counts.packages < rows.length) throw new Error('Gate package counts omit the installed scanner inventory');
  const blocked = selectRuntimePolicy(report, { incusAvailable: false, allowDockerFallback: false });
  if (decision.action !== 'quarantine' || blocked.action !== 'block')
    throw new Error('Host policy did not enforce dependency findings');
  const plan = buildIncusRuntimePlan({
    agentGroupFolder: 'dependency-proof',
    groupDir: root,
    instanceKind: 'vm',
    mounts: [],
    vmNetwork: {
      network: 'dependency-proof',
      acl: 'dependency-proof-acl',
      ipv4Cidr: '10.90.0.1/24',
      oneCliAddress: '10.90.0.1',
      oneCliPort: 10255,
    },
    vmDisks: {
      pool: 'default',
      volumes: [{ name: 'dependency-proof-work', source: root, path: '/workspace', readonly: false, size: '1GiB' }],
    },
  });
  const commands: string[][] = [];
  enforceIncusRuntimeDecision(decision, plan, {
    executor: (argv) => {
      commands.push(argv);
    },
  });
  if (
    !commands.some((c) => c[0] === 'stop') ||
    !commands.some((c) => c[0] === 'snapshot') ||
    !commands.some((c) => c.slice(0, 3).join(' ') === 'config device remove')
  )
    throw new Error('Missing production enforcement commands');
  // Real periodic trigger and fresh OSV lookup; containment remains a recording executor here.
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      stop();
      reject(new Error('Automatic monitor timed out'));
    }, 120_000);
    const stop = monitorDependencies({
      groupDir: root,
      intervalMs: 1_000,
      current: () => true,
      error: (error) => {
        clearTimeout(timeout);
        stop();
        reject(error);
      },
      unsafe: (result) => {
        try {
          if (result.summary.status !== 'complete' || !result.findings.length)
            throw new Error('Monitor did not produce complete advisory evidence');
          writeDependencyHold(path.join(out, 'monitor-host'), 'proof-session', result);
          let held = false;
          try {
            assertNoDependencyHold(path.join(out, 'monitor-host'), 'proof-session');
          } catch {
            held = true;
          }
          if (!held) throw new Error('Automatic session hold did not block restart');
          enforceIncusRuntimeDecision(decision, plan, {
            executor: (argv) => {
              commands.push(argv);
            },
          });
          resolve();
        } catch (error) {
          reject(error);
        } finally {
          clearTimeout(timeout);
          stop();
        }
      },
    });
  });
  fs.cpSync(root, path.join(out, 'inputs'), {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}.area51`),
  });
  const evidence = {
    schema: 'area51.multi_manager_dependencies.v1',
    measured_at: new Date().toISOString(),
    source_sha: process.env.GITHUB_SHA ?? null,
    scanner: summary.scanner,
    live_advisory_lookup: true,
    host_platform: process.platform,
    rows,
    host_decision: decision.action,
    without_incus: blocked.action,
    production_adapter_commands_verified: true,
    actual_vm_quarantine_tested: false,
    target_packages_installed: false,
    unknown_malware_detection_tested: false,
    automatic_polling_tested: true,
    monitor_test_interval_ms: 1000,
    persistent_restart_hold_verified: true,
    continuous_monitoring_tested: false,
    input_hashes: fixtures.map((f) => ({
      file: `${f.manager}/${f.file}`,
      sha256: createHash('sha256').update(f.content).digest('hex'),
    })),
  };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(evidence, null, 2) + '\n');
  fs.writeFileSync(path.join(out, 'agent-gate.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(
    path.join(out, 'summary.md'),
    '## Multi-manager dependency security\n\n| Manager | Resolved package | Live advisories | Host policy |\n|---|---|---|---|\n' +
      rows
        .map(
          (row) =>
            `| ${row.manager} | ${row.package}@${row.version} | ${row.advisories.length} | ✅ quarantine / block |`,
        )
        .join('\n') +
      '\n\nActual pinned scanner and current OSV lookup; target packages are metadata only. Production policy and quarantine command construction were exercised with a recording executor. Automatic polling (accelerated to one second) performed another real scan and persisted a restart hold. This proof does not run a VM or test guest inventory changes, language runtimes, unknown malware, build containment, or long-running monitoring. The separate LiteLLM live VM proof covers actual stop/NIC removal on Linux.\n',
  );
  console.log(`Verified ${rows.length} managers with actual OSV matching and Area51 host decisions.`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
