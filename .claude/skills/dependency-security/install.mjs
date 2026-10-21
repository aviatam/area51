import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../../..');
const remove = process.argv.includes('--remove');
const copies = [
  ['payload/scanner.ts', 'src/dependency-security.ts'],
  ['payload/scanner.test.ts', 'src/dependency-security.test.ts'],
  ['pins.json', 'src/dependency-security-pins.json'],
];
const patches = [
  [
    'src/agent-gate.ts',
    '      packages: packages.length + python.packages,',
    '      packages: packages.length + python.packages + dependencySecurity.summary.packages.length,',
  ],
  [
    'src/agent-gate.ts',
    "import YAML from 'yaml';",
    "import YAML from 'yaml';\nimport { scanDependencySecurity } from './dependency-security.js';",
  ],
  [
    'src/agent-gate.ts',
    'export interface AgentGateReport {',
    'export interface AgentGateReport {\n  dependency_scan?: Record<string, unknown>;',
  ],
  [
    'src/agent-gate.ts',
    '  findings.push(...python.findings);',
    '  findings.push(...python.findings);\n  const dependencySecurity = await scanDependencySecurity(groupDir, { preserveEvidence: options.quarantine ?? true });\n  findings.push(...dependencySecurity.findings);',
  ],
  [
    'src/agent-gate.ts',
    '  const pillars = scorePillars({',
    '  quarantine.files.push(...dependencySecurity.evidenceFiles);\n\n  const pillars = scorePillars({',
  ],
  [
    'src/agent-gate.ts',
    "    schema: 'area51.agent_gate.v1',",
    "    schema: 'area51.agent_gate.v1',\n    dependency_scan: dependencySecurity.summary,",
  ],
];
for (const [source, target] of copies) {
  const expected = fs.readFileSync(path.join(directory, source), 'utf8'),
    destination = path.join(root, target);
  if (fs.existsSync(destination) && fs.readFileSync(destination, 'utf8') !== expected)
    throw new Error(`Refusing modified generated file: ${target}`);
}
let gate = fs.readFileSync(path.join(root, 'src/agent-gate.ts'), 'utf8');
for (const [, before, after] of patches) {
  if (remove) {
    if (gate.includes(after)) gate = gate.replace(after, before);
    else if (!gate.includes(before)) throw new Error('Unrecognized gate integration');
  } else if (!gate.includes(after)) {
    if (!gate.includes(before)) throw new Error('Missing gate integration');
    gate = gate.replace(before, after);
  }
}
for (const [source, target] of copies) {
  const destination = path.join(root, target);
  if (remove) fs.rmSync(destination, { force: true });
  else fs.copyFileSync(path.join(directory, source), destination);
}
fs.writeFileSync(path.join(root, 'src/agent-gate.ts'), gate);
console.log(
  remove
    ? 'Dependency security skill removed.'
    : 'Dependency security skill installed. Enable required host scanning with the documented environment variables.',
);
