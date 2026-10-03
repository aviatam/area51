# Host tool-action authorization reference

Containment blocks access outside the allowed environment. A permitted API can
still be misused. This reference broker adds an action boundary for requests
explicitly routed through it; it does not automatically govern existing agents,
OneCLI traffic, MCP servers or arbitrary HTTP requests.

## Reproduce the proof

```bash
pnpm install --frozen-lockfile
pnpm exec vitest run src/tool-action-broker.test.ts src/tool-action-http.test.ts
pnpm run typecheck
```

CI runs both tests on Ubuntu, macOS and the portable Windows lane. The HTTP test
starts a real local service with a synthetic host-owned bearer credential and a
separate broker listener. The service records every credentialed request. Only an
allowed read and one approved write may arrive. Denied writes, unknown identity,
identity spoofing, pending actions, unauthorized approvals, modified approval
arguments, concurrent approval, replay, rejection, expiry and cancellation must
leave its request count unchanged.

The broker unit tests additionally cover bounded pending state, trusted policy
snapshots, default denial of unknown actions, per-call approval, argument-size
limits, audit failure before dispatch and ambiguous handler failure without retry.

These tests are separate from the 25-case hosted-KVM release report. They use a
local mock service and synthetic credentials, not a live business integration or
an authenticated VM session.

## Integration contract

The host registers named handlers (for example `crm.read` and `crm.delete`) and
an exact per-agent map of `allow`, `deny` or `approval`. Unknown agents and actions
are denied. Handlers own endpoint selection, argument validation, timeouts,
credential injection and response redaction. Never derive an upstream URL,
credential, privileged identity or handler from untrusted arguments.

`bindAgent` creates a dispatcher using an identity already authenticated by the
host. The HTTP reference transport uses separate host-configured agent and
approver bearer tokens; it rejects duplicate tokens and dual-role principals.
Guest fields cannot override that mapping. Production integration must bind
identity to the actual session and arrange that the agent cannot bypass the
broker using direct egress or another credential source.

An approval captures a private JSON snapshot of the submitted arguments.
Authorized approvers can inspect that snapshot and approve or reject its ID.
Resolution accepts no replacement action or arguments. The ID is consumed before
dispatch, so concurrent approvals and replays cannot cause another send. Every
new approval-required call needs a new decision. Approvals expire and are lost on
process restart; cancellation clears pending decisions. Pending state and JSON
body sizes are bounded. Audit events omit arguments and credentials; approval
previews deliberately expose the requested arguments to authorized reviewers.

Reference HTTP routes:

| Route                 | Principal | Meaning                                            |
| --------------------- | --------- | -------------------------------------------------- |
| `POST /actions`       | Agent     | Submit `{ "action": "crm.read", "args": {} }`      |
| `GET /approvals/:id`  | Approver  | Review agent, action, exact arguments and deadline |
| `POST /approvals/:id` | Approver  | Resolve with `{ "approve": true }` or `false`      |

Bind the reference listener on loopback. It is not a production network service:
remote use still needs TLS, token rotation/revocation, rate limiting, connection
timeouts, trusted identity provisioning and operational audit storage. A stolen
agent token carries that agent's permissions. A compromised host or authorized
approver is outside the claim. Canceling pending approvals does not revoke calls
already dispatched; handler failure may occur after an external side effect and
is never automatically retried.

## Next integration gate

Wire the broker to the contained runtime's allowed relay or verify equivalent
OneCLI enforcement. Then use an authorized test account for a narrow business
API: permitted read, blocked destructive write, exact reviewed write, expired
approval and identity mismatch. Record upstream observations and verify that no
alternate egress path bypasses the decision. Live Entra/Okta authorization and
real credential protection remain separate validation work.
