# `area51 tasks` migration

## Detect

If an agent mentions `schedule_task`, `list_tasks`, `update_task`, `cancel_task`, `pause_task`, or `resume_task`, it is using the old scheduling MCP surface.

A subtler symptom of a stale container image: the agent reports a task as scheduled, but `area51 tasks list` shows nothing and the host log has `Unknown system action` — the old image's `schedule_task` call is acknowledged in-container and then dropped by the new host. The fix below (rebuild + restart) resolves it.

## Why

Scheduling moved to `area51 tasks`. New tasks are stored in a per-agent-group system session and run there, so a scheduled task does not wake an existing chat session. When it fires, the agent must choose the delivery destination explicitly.

## Fix

Rebuild and restart agent containers so they load the updated MCP tool list and instructions:

```bash
./container/build.sh
launchctl kickstart -k gui/$(id -u)/com.area51
```

On Linux, restart with `systemctl --user restart area51`.

Use:

```bash
area51 tasks list
area51 tasks create --group <agent_group_id> --prompt "..." --process-after "2026-01-15T09:00:00" --recurrence "0 9 * * *"
area51 tasks update --id <series_id> --prompt "..."
area51 tasks cancel --id <series_id>
```

## Verify

Run `area51 tasks list`. New task rows should show a system `session_id`, not the chat session that requested the task.

## Legacy tasks (scheduled before this update)

Tasks created through the old MCP tools live in the **chat session** that created them, not in a per-series system session. They are unaffected by this update: they keep firing and delivering exactly as before. Two things to know:

- An agent's own `area51 tasks list` (group scope) shows only its group's task rows; from the **host**, unscoped `area51 tasks list` enumerates everything, and `--session <id>` narrows to one session — that is how you find and manage legacy rows (`area51 tasks cancel --session <chat_session_id> --all` to clear a chat session's tasks).
- The `messages_in` status enum now includes `cancelled` (cancel marks the row and clears its recurrence rather than deleting it). Custom code that exhaustively switches on task status needs the new arm.

## Rollback

Order matters:

1. Remove tasks created through `area51 tasks` (`area51 tasks list` / `delete`) — they live in per-series system sessions the old code doesn't know about.
2. **Wait one sweep (≤60s)** so the host closes the now-empty task sessions.
3. Then revert the update and rebuild the container image.

Reverting before the task sessions are collected leaves system sessions behind that the old `findSessionByAgentGroup` (which has no system-session exclusion) can resolve as the group's session — mis-routing agent-to-agent messages into a dead task thread.
