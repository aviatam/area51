/**
 * Optional Mend Intent provider. Area51 stays fully open source without it; when an
 * operator configures an Intent API, two things change:
 *
 *  1. Agent Gate asks Intent for a behavioral verdict on every pinned dependency of the
 *     group (package-lock.json, container.json npm packages, exact package.json pins,
 *     requirements pins). A package Intent blocks becomes a `dependency-` finding, so
 *     Runtime Policy quarantines the group and the live runner refuses to start it.
 *  2. The Docker runtime mounts the Intent shim as the agent's npm/npx, so an install the
 *     agent makes at runtime is held until Intent decides on those exact bytes.
 *
 * Intent detonates packages in instrumented microVMs, so it catches malware no advisory
 * names yet. Advisory scanning (OSV) stays on: the two answer different questions.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { AgentGateFinding } from './agent-gate.js';

export type IntentMode = 'required' | 'advisory';

export interface IntentConfig {
  apiUrl: string;
  token: string;
  mode: IntentMode;
  waitMs: number;
}

export interface IntentCoordinate {
  ecosystem: 'npm' | 'pypi';
  name: string;
  version: string;
  source: string;
}

export interface IntentPackageResult {
  ecosystem: string;
  name: string;
  version: string;
  source: string;
  status: 'allowed' | 'blocked' | 'pending' | 'failed' | 'error';
  top_severity?: string;
  reason?: string;
  analysis_id?: string;
  findings?: string[];
}

export interface IntentSummary {
  status: 'disabled' | 'complete' | 'incomplete';
  provider: 'Mend Intent';
  mode?: IntentMode;
  api_url?: string;
  config_version?: string;
  checked_at: string;
  packages: IntentPackageResult[];
  limitations: string[];
}

export interface IntentCheckResult {
  findings: AgentGateFinding[];
  summary: IntentSummary;
}

interface WireFinding {
  title?: string;
  severity?: string;
  phase?: string;
  evidence?: Array<{ rendered?: string }>;
}

interface WireItemResult {
  status?: string;
  coordinate?: { ecosystem?: string; name?: string; version?: string };
  verdict?: { top_severity?: string; findings?: WireFinding[] };
  decision?: { action?: string; reason?: string };
  analysis_id?: string;
  reason?: string;
  failure_reason?: string;
}

const MAX_COORDINATES = 2000;
const DEFAULT_WAIT_MS = 10_000;
const EXACT_VERSION = /^v?\d[A-Za-z0-9_.+!-]*$/;

/** Intent is on only when both the API URL and an analysis token are configured on the host. */
export function resolveIntentConfig(env: NodeJS.ProcessEnv = process.env): IntentConfig | null {
  const apiUrl = env.AREA51_INTENT_API_URL?.trim();
  const token = env.AREA51_INTENT_TOKEN?.trim();
  if (!apiUrl || !token) return null;
  const wait = Number(env.AREA51_INTENT_WAIT_MS);
  return {
    apiUrl: apiUrl.replace(/\/+$/, ''),
    token,
    mode: env.AREA51_INTENT_MODE === 'advisory' ? 'advisory' : 'required',
    waitMs: Number.isFinite(wait) && wait >= 0 ? Math.min(wait, 60_000) : DEFAULT_WAIT_MS,
  };
}

/** Pinned npm and PyPI coordinates the group declares. Ranges are skipped: Intent judges exact versions. */
export function collectIntentCoordinates(groupDir: string): IntentCoordinate[] {
  const out = new Map<string, IntentCoordinate>();
  const add = (ecosystem: IntentCoordinate['ecosystem'], name: string, version: string, source: string): void => {
    if (!name || !EXACT_VERSION.test(version)) return;
    const key = `${ecosystem}:${name.toLowerCase()}@${version}`;
    if (!out.has(key)) out.set(key, { ecosystem, name, version: version.replace(/^v/, ''), source });
  };

  const lock = readJson<{ packages?: Record<string, { version?: string; name?: string; link?: boolean }> }>(
    path.join(groupDir, 'package-lock.json'),
  );
  for (const [key, entry] of Object.entries(lock?.packages ?? {})) {
    if (!key || entry.link || typeof entry.version !== 'string') continue;
    const name = entry.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    add('npm', name, entry.version, 'package-lock.json');
  }

  const container = readJson<{ packages?: { npm?: unknown[] } }>(path.join(groupDir, 'container.json'));
  for (const spec of container?.packages?.npm ?? []) {
    if (typeof spec !== 'string') continue;
    const at = spec.lastIndexOf('@');
    if (at > 0) add('npm', spec.slice(0, at), spec.slice(at + 1), 'container.json');
  }

  const pkg = readJson<{ dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> }>(
    path.join(groupDir, 'package.json'),
  );
  for (const deps of [pkg?.dependencies, pkg?.devDependencies]) {
    for (const [name, version] of Object.entries(deps ?? {})) {
      if (typeof version === 'string') add('npm', name, version, 'package.json');
    }
  }

  for (const file of ['requirements.txt', 'requirements.lock']) {
    const text = readText(path.join(groupDir, file));
    for (const line of text?.split(/\r?\n/) ?? []) {
      const match = /^\s*([A-Za-z0-9][A-Za-z0-9_.-]*)(?:\[[^\]]+\])?\s*==\s*([A-Za-z0-9_.+!-]+)/.exec(line);
      if (match) add('pypi', match[1], match[2], file);
    }
  }
  return [...out.values()].slice(0, MAX_COORDINATES);
}

/** Ask Intent for behavioral verdicts and turn blocks (and, when required, unknowns) into findings. */
export async function checkIntentVerdicts(
  groupDir: string,
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<IntentCheckResult> {
  const config = resolveIntentConfig(options.env ?? process.env);
  const summary: IntentSummary = {
    status: 'disabled',
    provider: 'Mend Intent',
    checked_at: (options.now ?? new Date()).toISOString(),
    packages: [],
    limitations: [
      'Optional enterprise provider: unset AREA51_INTENT_API_URL / AREA51_INTENT_TOKEN to run Area51 without it.',
      'Only exact npm/PyPI pins are judged; ranges, git, URL and file dependencies are not.',
    ],
  };
  const result: IntentCheckResult = { findings: [], summary };
  if (!config) return result;
  summary.mode = config.mode;
  summary.api_url = config.apiUrl;
  summary.status = 'incomplete';

  const coordinates = collectIntentCoordinates(groupDir);
  if (!coordinates.length) {
    summary.status = 'complete';
    return result;
  }

  let response: { config_version?: string; results?: WireItemResult[] };
  try {
    response = await postBatch(config, coordinates, options.fetchImpl ?? fetch);
    // eslint-disable-next-line no-catch-all/no-catch-all -- an unreachable verdict service is unknown exposure
  } catch (error) {
    result.findings.push(
      unverifiedFinding(
        config,
        'unavailable',
        `Mend Intent could not be reached (${(error as Error).message}). No behavioral verdict was returned for ${coordinates.length} package(s).`,
        [config.apiUrl],
      ),
    );
    return result;
  }
  summary.config_version = response.config_version;

  const results = Array.isArray(response.results) ? response.results : [];
  coordinates.forEach((coordinate, index) => {
    const item = interpretItem(coordinate, results[index]);
    summary.packages.push(item);
    if (item.status === 'blocked') result.findings.push(blockedFinding(item));
    else if (item.status !== 'allowed')
      result.findings.push(
        unverifiedFinding(
          config,
          key(item),
          `Mend Intent has no decision for ${item.ecosystem} ${item.name}@${item.version} (${item.status}${item.reason ? `: ${item.reason}` : ''}). Unknown behavior is not a clean result.`,
          [item.source, ...(item.analysis_id ? [`intent:analysis/${item.analysis_id}`] : [])],
        ),
      );
  });
  summary.status = summary.packages.every((p) => p.status === 'allowed' || p.status === 'blocked')
    ? 'complete'
    : 'incomplete';
  return result;
}

/**
 * Runtime wiring for the Docker backend: the Intent shim mounted read-only as the agent's
 * npm/npx. Null when Intent or the Linux shim binary (AREA51_INTENT_SHIM) is not configured.
 */
export function prepareIntentRuntime(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): { hostDir: string; containerDir: string; env: Record<string, string> } | null {
  const config = resolveIntentConfig(env);
  const shim = env.AREA51_INTENT_SHIM?.trim();
  if (!config || !shim) return null;
  if (!fs.statSync(shim, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`AREA51_INTENT_SHIM is not a file: ${shim}`);
  }
  const hostDir = path.join(dataDir, 'intent-runtime');
  fs.mkdirSync(path.join(hostDir, 'bin'), { recursive: true });
  const binary = path.join(hostDir, 'bin', 'intent');
  fs.copyFileSync(shim, binary);
  fs.chmodSync(binary, 0o755);
  for (const tool of ['npm', 'npx']) {
    const link = path.join(hostDir, 'bin', tool);
    fs.rmSync(link, { force: true });
    fs.symlinkSync('intent', link);
  }
  const containerDir = '/opt/intent';
  return {
    hostDir,
    containerDir,
    env: {
      INTENT_API_URL: env.AREA51_INTENT_CONTAINER_API_URL?.trim() || toContainerUrl(config.apiUrl),
      INTENT_TOKEN: config.token,
      // An autonomous agent gets the strict setting: URL, git and file: dependencies
      // cannot be judged by coordinate, so they are refused rather than waved through.
      INTENT_NON_REGISTRY: 'block',
      INTENT_CONFIG: '/tmp/intent-config',
      PATH: `${containerDir}/bin:/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    },
  };
}

export function formatIntentSummary(summary: IntentSummary | undefined): string[] {
  if (!summary || summary.status === 'disabled') return ['Mend Intent: not configured (open-source mode)'];
  const blocked = summary.packages.filter((p) => p.status === 'blocked');
  const unknown = summary.packages.filter((p) => p.status !== 'allowed' && p.status !== 'blocked');
  const lines = [
    `Mend Intent: ${summary.status} (${summary.mode}) packages=${summary.packages.length} blocked=${blocked.length} unverified=${unknown.length}`,
  ];
  for (const p of blocked) lines.push(`  ✗ ${p.name}@${p.version}  ${p.top_severity}: ${p.findings?.join('; ')}`);
  return lines;
}

async function postBatch(
  config: IntentConfig,
  coordinates: IntentCoordinate[],
  fetchImpl: typeof fetch,
): Promise<{ config_version?: string; results?: WireItemResult[] }> {
  const res = await fetchImpl(`${config.apiUrl}/v1/verdicts:batch`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      wait_ms: config.waitMs,
      items: coordinates.map(({ ecosystem, name, version }) => ({ ecosystem, name, version })),
    }),
    signal: AbortSignal.timeout(config.waitMs + 15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as { config_version?: string; results?: WireItemResult[] };
}

function interpretItem(coordinate: IntentCoordinate, item: WireItemResult | undefined): IntentPackageResult {
  const base = {
    ecosystem: coordinate.ecosystem,
    name: coordinate.name,
    version: coordinate.version,
    source: coordinate.source,
  };
  const same =
    item?.coordinate?.ecosystem === coordinate.ecosystem &&
    item.coordinate.version === coordinate.version &&
    canonicalName(coordinate.ecosystem, item.coordinate.name ?? '') ===
      canonicalName(coordinate.ecosystem, coordinate.name);
  if (!item || !same) return { ...base, status: 'error', reason: 'response did not match the request' };
  if (item.status !== 'available') {
    return {
      ...base,
      status: item.status === 'pending' ? 'pending' : item.status === 'failed' ? 'failed' : 'error',
      reason: item.failure_reason ?? item.reason,
      analysis_id: item.analysis_id,
    };
  }
  const blocked = item.decision?.action === 'block';
  return {
    ...base,
    status: blocked ? 'blocked' : item.decision?.action === 'allow' ? 'allowed' : 'error',
    top_severity: item.verdict?.top_severity,
    reason: item.decision?.reason,
    analysis_id: item.analysis_id,
    findings: (item.verdict?.findings ?? [])
      .filter((f) => f.severity === 'critical' || f.severity === 'high')
      .map((f) => f.title ?? 'untitled finding')
      .slice(0, 6),
  };
}

function blockedFinding(item: IntentPackageResult): AgentGateFinding {
  return {
    id: `dependency-intent-${key(item)}`,
    severity: 'high',
    pillar: 'security',
    title: 'Mend Intent blocked a dependency by its behavior',
    detail: `${item.ecosystem} ${item.name}@${item.version} was detonated by Mend Intent: ${item.top_severity} — ${item.findings?.join('; ') || 'see verdict'}. Decision: ${item.reason ?? 'block'}.`,
    evidence: [item.source, ...(item.analysis_id ? [`intent:analysis/${item.analysis_id}`] : [])],
    recommendation:
      'Remove the package from the agent group, regenerate the lockfile, and review the Intent verdict before any agent runs it.',
  };
}

function unverifiedFinding(config: IntentConfig, id: string, detail: string, evidence: string[]): AgentGateFinding {
  const required = config.mode === 'required';
  return {
    id: `${required ? 'dependency-' : ''}intent-unverified-${id}`,
    severity: required ? 'high' : 'warning',
    pillar: 'security',
    title: 'Dependency behavior is unverified',
    detail,
    evidence,
    recommendation: required
      ? 'Wait for the Intent analysis to finish and rescan, or remove the package. Required mode fails closed.'
      : 'Rescan once the Intent analysis finishes.',
  };
}

function key(item: { ecosystem: string; name: string; version: string; source?: string }): string {
  return createHash('sha256')
    .update(`${item.source}:${item.ecosystem}:${item.name}:${item.version}`)
    .digest('hex')
    .slice(0, 16);
}

/** PyPI names compare under PEP 503 normalization; npm names are exact. */
function canonicalName(ecosystem: string, name: string): string {
  return ecosystem === 'pypi' ? name.toLowerCase().replace(/[-_.]+/g, '-') : name;
}

function toContainerUrl(url: string): string {
  return url.replace(/\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/, '//host.docker.internal');
}

function readText(file: string): string | undefined {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 2_000_000) return undefined;
    return fs.readFileSync(file, 'utf8');
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    return undefined;
  }
}

function readJson<T>(file: string): T | undefined {
  const text = readText(file);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    return undefined;
  }
}
