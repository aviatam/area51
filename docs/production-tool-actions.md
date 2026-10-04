# Session-bound host tool actions

The `tool_action` MCP tool writes a request to the existing session outbox. The
host poller supplies the session/group identity; request fields cannot select a
different agent. The host consults its default-deny broker, sends any approval
card through the existing administrator channel, executes the registered action,
and reports its status to the agent. This path adds no VM listener or egress rule.

## Enable on Linux

As the host service user, create `~/.config/area51/tool-actions.json` with mode
`0600`. Keep its directory outside every permitted guest mount. Do not commit
the file or copy it into an agent workspace. The module is disabled when the file
is absent; an invalid/private-permission failure stops host module startup.

Example structure (replace the endpoint, group ID and placeholder credential):

```json
{
  "schema": "area51.tool-actions.v1",
  "approvalTtlMs": 60000,
  "actions": {
    "demo.send": {
      "url": "https://your-test-service.example/actions/send",
      "token": "REPLACE_WITH_HOST_ONLY_TEST_CREDENTIAL",
      "arguments": { "text": "string" },
      "required": ["text"]
    }
  },
  "policy": {
    "YOUR_AGENT_GROUP_ID": { "demo.send": "approval" },
    "YOUR_OTHER_AGENT_GROUP_ID": { "demo.send": "deny" }
  }
}
```

Permission values are `allow`, `deny`, or `approval`. Missing identities, actions
and rules are denied. `allow` means every valid request may execute without a
human decision; use it only for operations deliberately granted that authority.
Only the host chooses the URL and credential. Destinations use HTTPS; loopback
HTTP is permitted for local validation. URLs containing credentials, queries or
fragments, unknown fields and redirects are rejected. The adapter makes one
JSON POST with a 10-second timeout and never retries it.

The agent invokes `tool_action({tool: "demo.send", args: {text: "reviewed"}})`.
The agent receives submission acknowledgement, followed by a system status
message. Upstream bodies, secrets and raw errors are not returned. This version
supports acknowledgement-only actions, not arbitrary response-data retrieval.

## Approval and recovery behavior

An administrator sees the entire canonical action/arguments and a deadline;
previews exceeding 3000 characters are denied instead of truncated. String
arguments are limited to 2048 characters and exclude controls, bidi overrides
and backticks that could obscure the displayed request. Unknown arguments and
wrong types fail validation before requesting approval. Approval carries only a
host-held continuation ID; it cannot replace the submitted arguments.

Resolution rechecks the administrator's current role, the active session and the
current private configuration digest. A changed or removed configuration denies
the outstanding request. Rotate a credential by updating the private file;
approvals for the old configuration are denied when resolved. A previously
authorized approver removed from the role list cannot resolve it. Newly added
administrators need a fresh request because broker authorization was captured
when the request was created.

The host consumes the ID before waiting for the external service, preventing
concurrent/replayed approval dispatch. Pending requests expire (default 60 seconds,
configurable from 1 to 300 seconds), and shutdown/restart loses all executable
continuations. Stale approval cards cannot execute after restart. Failed delivery
removes the card row and cancels its continuation. Reject-with-reason keeps the
existing card UI behavior, but never extends the broker deadline.

Before dispatch, a central-DB migration records a durable `(session, requestId)`
reservation. Outbox redelivery and host restart cannot dispatch that ID again.
This is at-most-once dispatch, not guaranteed external completion: a crash after
reservation may lose a request, and a timeout may follow a successful external
write. Reconcile the upstream log before issuing a fresh request. Reservations
are capped at 1000 per session and 50000 per installation; reaching the cap denies
new actions. Deleting a session deletes its reservations. Never delete a live
session's reservations just to replay an ambiguous action. Back up this table
with the central DB; restoring an old snapshot can lose reservations, so reconcile
post-backup writes before resuming agents after restore.

## Boundaries and validation

This governs the `tool_action` path only. Existing OneCLI credentials, other MCP
servers and independently granted routes can bypass it. Do not issue the same
business credential through those paths; keep the private config outside guest
mounts and demonstrate direct/alternate route denial in the deployment. This is
required before claiming complete mediation of a real service.

Run host tests with:

```bash
pnpm exec vitest run src/session-tool-actions.test.ts src/tool-action-config.test.ts src/modules/tool-actions/index.test.ts
pnpm run typecheck
```

Run container tool tests from `container/agent-runner` with `bun run test`.
CI tests the real delivery/approval registries against SQLite and the adapter
against an actual local credentialed HTTP service. These are synthetic-account
tests. Real-account, production VM session-path, physical-host reboot and
independent review remain [Linux GA gates](linux-ga-readiness.md).
