import fs from 'node:fs';
import path from 'node:path';

import type { AgentGateFinding } from './agent-gate.js';

export const PYTHON_EVIDENCE_FILES = ['requirements.txt', 'requirements.lock', 'python-packages.json'];
// Published incidents, not a general malware detector. Never download these versions to inspect them.
const COMPROMISED_LITELLM = new Set(['1.82.7', '1.82.8', '1.107.0']);
const INCIDENT_SOURCES = [
  'https://github.com/BerriAI/litellm/issues/24518',
  'https://www.stepsecurity.io/blog/litellm-1-107-0-compromised-pypi-backdoored-wheels-credential-stealer',
];

/** Read root-level declarations and an exported pip list inventory without importing Python code. */
export function scanPythonPackageRisk(groupDir: string): { findings: AgentGateFinding[]; packages: number } {
  const findings: AgentGateFinding[] = [];
  let packages = 0;
  const finding = (id: string, detail: string, source: string): void => {
    findings.push({
      id,
      severity: 'high',
      pillar: 'security',
      title:
        id === 'pypi-litellm-compromised'
          ? 'Known compromised LiteLLM release'
          : 'Python dependency evidence needs review',
      detail,
      evidence: [source, ...INCIDENT_SOURCES],
      recommendation:
        'Stop the affected workload, preserve evidence, and rebuild from reviewed, pinned inputs. Rotate credentials if exposed.',
    });
  };
  const inspect = (name: string, version: string | undefined, source: string): void => {
    packages++;
    if (name.toLowerCase().replace(/[-_.]+/g, '-') !== 'litellm') return;
    if (version && COMPROMISED_LITELLM.has(version)) {
      finding(
        'pypi-litellm-compromised',
        `LiteLLM ${version} is a reported malicious release. This is a known-version match.`,
        source,
      );
    } else if (!version) {
      finding(
        'pypi-litellm-unresolved',
        'LiteLLM has no exact resolved version; its exposure cannot be determined from this declaration.',
        source,
      );
    }
  };
  for (const file of PYTHON_EVIDENCE_FILES) {
    const absolute = path.join(groupDir, file);
    if (!fs.existsSync(absolute)) continue;
    try {
      if (!fs.lstatSync(absolute).isFile() || fs.statSync(absolute).size > 2_000_000)
        throw new Error('inventory surface');
      const text = fs.readFileSync(absolute, 'utf8');
      if (file === 'python-packages.json') {
        const inventory: unknown = JSON.parse(text);
        if (!Array.isArray(inventory)) throw new Error('inventory format');
        for (const entry of inventory) {
          if (!entry || typeof entry.name !== 'string' || typeof entry.version !== 'string')
            throw new Error('inventory entry');
          inspect(entry.name, entry.version, file);
        }
      } else {
        for (const [index, line] of text.split(/\r?\n/).entries()) {
          const match = line.trim().match(/^([A-Za-z0-9][A-Za-z0-9_.-]*)(?:\[[^\]]+\])?\s*(.*)$/);
          if (!match) continue;
          const exact = match[2].match(/^==\s*([0-9]+(?:\.[0-9]+){1,3})(?=\s*(?:$|;|#|--hash=|\\))/);
          inspect(match[1], exact?.[1], `${file}:${index + 1}`);
        }
      }
      // eslint-disable-next-line no-catch-all/no-catch-all -- malformed dependency evidence must fail closed
    } catch (_error) {
      finding('pypi-inventory-invalid', `Cannot safely read ${file}; dependency coverage is incomplete.`, file);
    }
  }
  return { findings, packages };
}

export function isPackageRiskFinding(finding: AgentGateFinding): boolean {
  return finding.severity === 'high' && /^(npm-|pypi-)/.test(finding.id);
}
