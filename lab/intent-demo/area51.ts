/**
 * Demo helper: runs the real Area51 code paths the demo shows.
 *
 *   gate <groupDir> <reportFile>   Agent Gate + Runtime Policy + the live runner's startup check
 *   runtime <dataDir>              the Intent runtime wiring (mount + env) the Docker runner applies
 *
 * Mend Intent is used only when AREA51_INTENT_API_URL and AREA51_INTENT_TOKEN are set.
 */
import fs from 'node:fs';
import path from 'node:path';

import { formatAgentGateReport, scanAgentGate } from '../../src/agent-gate.js';
import { prepareIntentRuntime } from '../../src/intent-verdicts.js';
import { selectRuntimePolicy } from '../../src/runtime-policy.js';

const [command, target, reportFile] = process.argv.slice(2);

if (command === 'gate') {
  const report = await scanAgentGate({
    groupDir: target,
    env: { ANTHROPIC_API_KEY: 'demo-managed' },
    quarantine: true,
    // The live runner requires advisory scanning too (src/container-runner.ts).
    dependencySecurity: process.env.DEMO_OSV === '0' ? undefined : 'required',
  });
  const policy = selectRuntimePolicy(report, {
    profile: 'production',
    trustLevel: 'approved',
    dataSensitivity: 'customer',
    capabilities: ['chat', 'shell', 'package-install'],
    incusAvailable: true,
  });
  // The live runner's own refusal (src/container-runner.ts spawnContainer).
  const startupRefused = report.findings.some((f) => f.severity === 'high' && f.id.startsWith('dependency-'));
  const lines = formatAgentGateReport(report).split('\n');
  const keep = lines.filter(
    (l) => /^(Agent Gate|Mend Intent|  ✗|  \[high\]|Quarantine:)/.test(l) || /^    (Reported|npm|pypi)/.test(l),
  );
  console.log(keep.join('\n'));
  const scan = report.dependency_scan as { status?: string; scanner?: string; packages?: unknown[] } | undefined;
  console.log(
    `Advisory scan (${scan?.scanner ?? 'OSV'} + known-bad list): ${scan?.status}, ${scan?.packages?.length ?? 0} package(s), ${countAdvisories(report.findings)} advisory hit(s)`,
  );
  console.log(
    `Runtime Policy: ${policy.action.toUpperCase()}${policy.runtime ? ` via ${policy.runtime}` : ''} (risk ${policy.riskScore}/100)`,
  );
  console.log(`Agent start: ${startupRefused ? 'REFUSED — dependency security blocked startup' : 'allowed'}`);
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(
    reportFile,
    JSON.stringify({ agent_gate: report, runtime_policy: policy, startup_refused: startupRefused }, null, 2) + '\n',
  );
} else if (command === 'runtime') {
  const runtime = prepareIntentRuntime(target);
  if (!runtime)
    throw new Error(
      'Intent runtime is not configured (AREA51_INTENT_API_URL, AREA51_INTENT_TOKEN, AREA51_INTENT_SHIM)',
    );
  const args = ['-v', `${runtime.hostDir}:${runtime.containerDir}:ro`];
  for (const [key, value] of Object.entries(runtime.env)) args.push('-e', `${key}=${value}`);
  console.log(args.join('\n'));
} else {
  console.error('usage: area51.ts gate <groupDir> <reportFile> | runtime <dataDir>');
  process.exit(2);
}

function countAdvisories(findings: Array<{ id: string }>): number {
  return findings.filter((f) => /^(npm-|pypi-|dependency-advisory-)/.test(f.id)).length;
}
