import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const labDir = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(labDir, 'scenarios.json'), 'utf8'));

export function verifyLab(root) {
  const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/assertions.json'), 'utf8'));
  if (
    report.schema !== 'area51.governed_demo.v1' ||
    report.mode !== 'deterministic-contract' ||
    report.passed !== true
  ) {
    throw new Error('Demo assertion report is missing or did not pass in contract mode');
  }
  if (manifest.schema !== 'area51.agent_security_lab.v1' || manifest.scenarios.length !== 3) {
    throw new Error('Lab manifest is invalid');
  }

  const expected = manifest.scenarios.flatMap((scenario) => scenario.assertions);
  const actual = report.assertions.map((assertion) => assertion.id);
  if (
    new Set(expected).size !== expected.length ||
    new Set(actual).size !== actual.length ||
    expected.length !== actual.length ||
    expected.some((id) => !actual.includes(id))
  ) {
    throw new Error('Demo assertions do not match the lab manifest');
  }
  for (const assertion of report.assertions) {
    if (assertion.passed !== true) throw new Error(`Assertion failed: ${assertion.id}`);
  }
  for (const scenario of manifest.scenarios) {
    for (const relative of scenario.evidence) {
      const file = path.resolve(root, relative);
      if (!file.startsWith(`${path.resolve(root)}${path.sep}`) || !fs.statSync(file).isFile()) {
        throw new Error(`Missing or invalid evidence: ${relative}`);
      }
      JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  }
  return {
    schema: manifest.schema,
    mode: 'deterministic-contract',
    passed: true,
    scenarios: manifest.scenarios.map(({ id, evidence, assertions }) => ({ id, evidence, assertions })),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = path.resolve(process.argv[2] ?? '.area51/agent-security-lab');
    const result = verifyLab(root);
    fs.writeFileSync(path.join(root, 'reports/lab-verification.json'), `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`Area51 agent security lab: VERIFIED (${result.scenarios.length} scenarios)\n`);
  } catch (error) {
    process.stderr.write(`Area51 agent security lab: REJECTED (${error.message})\n`);
    process.exitCode = 1;
  }
}
