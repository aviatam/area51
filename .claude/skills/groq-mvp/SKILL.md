---
name: groq-mvp
description: Install a Groq chat provider for the isolated Area51 MVP, using a host credential gateway and the built-in MCP tool_action broker.
---

# Groq MVP provider

Use this skill with the bounded host gateway in `scripts/groq-agent-gateway.ts`.
The provider supports conversation, queued follow-ups, persistent continuation,
and the built-in `tool_action` MCP tool. The host defines available actions.

## Apply

From the repository root, run `node .claude/skills/groq-mvp/install.mjs`.
This copies the provider and its registration test into the agent runner and
adds its import to the provider registry barrel. Reapplying is idempotent.
Build the VM image after installation.

Run `bun install --frozen-lockfile`, `bun run typecheck`, and
`bun test src/providers/groq.registration.test.ts` in `container/agent-runner`.
The registration test uses the real barrel and session database helpers.

## Credentials and configuration

Set the agent's `container.json` provider to `groq` and model to
`openai/gpt-oss-20b`. Supply `AREA51_GROQ_RELAY_URL` and
`AREA51_GROQ_RELAY_TOKEN` from the host controller when starting the guest.
The token is a short-lived capability for the bounded model gateway.
Keep `GROQ_API_KEY` and `GITHUB_TOKEN` on the host. The gateway fixes the model,
tool schema, upstream URL, and request budget. Use synthetic demo inputs.

The provider stores its conversation under `/workspace/groq-history.json`,
inside the session volume. It fails closed on interrupted tool calls and
oversized history. Start a new session to clear the conversation.

## Recipe

Install this skill before `container/incus/build-vm.sh`, then follow
`docs/groq-agent-mvp.md` for the owner-started live workflow and evidence.
Additional MCP servers require a separate provider extension.

## Troubleshooting

For model unavailability, inspect the workflow's redacted gateway status.
For a missing relay capability, restart through the host controller.
An interrupted tool outcome requires host reconciliation before another action.
Never retry an uncertain external write.

## Remove

Follow [REMOVE.md](REMOVE.md).
