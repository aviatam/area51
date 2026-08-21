import type { AgentGateReport } from './agent-gate.js';
import {
  quarantineIncusInstance,
  type IncusAdapterOptions,
  type IncusAdapterResult,
} from './incus-adapter.js';
import type { IncusRuntimePlan } from './incus-runtime.js';
import { selectRuntimePolicy, type RuntimePolicyDecision } from './runtime-policy.js';

export interface IncusPreflightResult {
  decision: RuntimePolicyDecision;
  quarantine?: IncusAdapterResult;
}

/** Convert Agent Gate evidence into an applied live-runtime decision. */
export function enforceIncusPreflight(
  report: AgentGateReport,
  plan: IncusRuntimePlan,
  options: IncusAdapterOptions = {},
): IncusPreflightResult {
  const decision = selectRuntimePolicy(report, {
    profile: plan.instanceKind === 'vm' ? 'maximum' : 'production',
    incusAvailable: true,
    allowDockerFallback: false,
    trustLevel: 'unknown',
    dataSensitivity: 'customer',
    capabilities: ['chat', 'network'],
  });
  if (decision.action === 'block') {
    throw new Error(`Agent Gate blocked Incus execution: ${decision.reasons.join('; ')}`);
  }
  if (decision.action === 'quarantine') {
    return {
      decision,
      quarantine: quarantineIncusInstance(plan, { ...options, reason: decision.reasons.join('; ') }),
    };
  }
  return { decision };
}
