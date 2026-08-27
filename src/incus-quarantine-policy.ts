import { quarantineIncusInstance, type IncusAdapterOptions, type IncusAdapterResult } from './incus-adapter.js';
import type { IncusRuntimePlan } from './incus-runtime.js';
import type { RuntimePolicyDecision } from './runtime-policy.js';

export interface IncusPreflightResult {
  decision: RuntimePolicyDecision;
  quarantine?: IncusAdapterResult;
}

/** Apply a precomputed host-owned decision to the exact Incus runtime it selected. */
export function enforceIncusRuntimeDecision(
  decision: RuntimePolicyDecision,
  plan: IncusRuntimePlan,
  options: IncusAdapterOptions = {},
): IncusPreflightResult {
  if (decision.action === 'block') {
    throw new Error(`Agent Gate blocked Incus execution: ${decision.reasons.join('; ')}`);
  }
  const plannedRuntime = plan.instanceKind === 'vm' ? 'incus-vm' : 'incus-container';
  if (decision.runtime !== plannedRuntime) {
    throw new Error(`Runtime Policy selected ${decision.runtime ?? 'no runtime'}, refusing ${plannedRuntime}`);
  }
  if (decision.action === 'quarantine') {
    return {
      decision,
      quarantine: quarantineIncusInstance(plan, { ...options, reason: decision.reasons.join('; ') }),
    };
  }
  return { decision };
}
