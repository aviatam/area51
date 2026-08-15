import path from 'path';

export interface IncusRuntimePlanOptions {
  agentGroupFolder: string;
  groupDir: string;
  sessionDir?: string;
  instanceKind?: 'container' | 'vm';
  image?: string;
  networkProfile?: string;
  quarantineProfile?: string;
  instanceSuffix?: string;
  mounts?: Array<{ source: string; path: string; readonly: boolean }>;
}

export interface IncusRuntimePlan {
  project: string;
  instance: string;
  instanceKind: 'container' | 'vm';
  image: string;
  profiles: string[];
  mounts: Array<{ source: string; path: string; readonly: boolean }>;
  restrictions: Record<string, string>;
  commands: {
    createProject: string[];
    createProfiles: string[];
    launch: string[];
    quarantine: string[];
  };
}

const DEFAULT_IMAGE = 'images:debian/12/cloud';
const DEFAULT_NETWORK_PROFILE = 'area51-agent-net';
const DEFAULT_QUARANTINE_PROFILE = 'area51-quarantine';

export function buildIncusRuntimePlan(options: IncusRuntimePlanOptions): IncusRuntimePlan {
  const safeFolder = safeIncusName(options.agentGroupFolder, 'agent group folder');
  const safeSuffix = options.instanceSuffix ? safeIncusName(options.instanceSuffix, 'instance suffix') : undefined;
  const project = `area51-${safeFolder}`;
  const instance = safeSuffix
    ? `area51-${safeFolder.slice(0, 32)}-${safeSuffix.slice(0, 16)}-agent`
    : `area51-${safeFolder}-agent`;
  const networkProfile = options.networkProfile ?? DEFAULT_NETWORK_PROFILE;
  const quarantineProfile = options.quarantineProfile ?? DEFAULT_QUARANTINE_PROFILE;
  const image = options.image ?? DEFAULT_IMAGE;
  const instanceKind = options.instanceKind ?? 'container';
  const groupDir = path.resolve(options.groupDir);
  const sessionDir = options.sessionDir ? path.resolve(options.sessionDir) : undefined;

  const mounts = options.mounts ?? [
    ...(sessionDir ? [{ source: sessionDir, path: '/workspace', readonly: false }] : []),
    { source: groupDir, path: '/workspace/agent', readonly: true },
  ];
  const profiles = ['default', networkProfile];
  const restrictions = {
    'limits.cpu': '2',
    'limits.memory': '2GiB',
    'security.nesting': 'false',
    'security.privileged': 'false',
  };

  return {
    project,
    instance,
    instanceKind,
    image,
    profiles,
    mounts,
    restrictions,
    commands: {
      createProject: [
        `incus project create ${project}`,
        `incus project set ${project} restricted=true`,
        `incus project set ${project} limits.instances=3`,
      ],
      createProfiles: [
        `incus profile create ${networkProfile} --project ${project}`,
        `incus profile set ${networkProfile} security.idmap.isolated=true --project ${project}`,
        `incus profile create ${quarantineProfile} --project ${project}`,
        `incus profile set ${quarantineProfile} user.area51.quarantined=true --project ${project}`,
      ],
      launch: buildLaunchCommands({
        project,
        instance,
        image,
        instanceKind,
        profiles,
        mounts,
        restrictions,
      }),
      quarantine: [
        `incus freeze ${instance} --project ${project}`,
        `incus snapshot ${instance} area51-quarantine-$(date -u +%Y%m%dT%H%M%SZ) --project ${project}`,
        `incus profile remove ${instance} ${networkProfile} --project ${project}`,
        `incus profile add ${instance} ${quarantineProfile} --project ${project}`,
        `incus config set ${instance} user.area51.quarantine_reason package-risk --project ${project}`,
      ],
    },
  };
}

export function formatIncusRuntimePlan(plan: IncusRuntimePlan): string {
  const lines: string[] = [];
  lines.push(`Incus runtime: ${plan.project}/${plan.instance} (${plan.instanceKind})`);
  lines.push(`Image: ${plan.image}`);
  lines.push(`Profiles: ${plan.profiles.join(', ')}`);
  lines.push('');
  lines.push('Mounts:');
  for (const mount of plan.mounts) {
    lines.push(`  ${mount.source} -> ${mount.path}${mount.readonly ? ' (ro)' : ''}`);
  }
  lines.push('');
  lines.push('Quarantine flow:');
  for (const command of plan.commands.quarantine) lines.push(`  ${command}`);
  return lines.join('\n');
}

function buildLaunchCommands(input: {
  project: string;
  instance: string;
  image: string;
  instanceKind: 'container' | 'vm';
  profiles: string[];
  mounts: Array<{ source: string; path: string; readonly: boolean }>;
  restrictions: Record<string, string>;
}): string[] {
  const flags = input.profiles.flatMap((profile) => ['--profile', profile]);
  const init = [
    'incus',
    'init',
    input.image,
    input.instance,
    '--project',
    input.project,
    '--vm',
    input.instanceKind === 'vm' ? 'true' : 'false',
    ...flags,
  ].join(' ');
  const commands = [init];
  for (const [key, value] of Object.entries(input.restrictions)) {
    commands.push(`incus config set ${input.instance} ${key}=${value} --project ${input.project}`);
  }
  for (const mount of input.mounts) {
    const device = mount.path.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'mount';
    const readonly = mount.readonly ? ' readonly=true' : '';
    commands.push(
      `incus config device add ${input.instance} ${device} disk source="${mount.source}" path=${mount.path}${readonly} --project ${input.project}`,
    );
  }
  commands.push(`incus start ${input.instance} --project ${input.project}`);
  return commands;
}

function safeIncusName(value: string, label: string): string {
  const safe = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (!safe) throw new Error(`Invalid ${label}: ${value}`);
  return safe;
}
