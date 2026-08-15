## Admin CLI (`area51`)

The `area51` command is available at `/usr/local/bin/area51`. It lets you query and modify Area51's central configuration.

### Usage

```
area51 <resource> <verb> [--flags]
area51 <resource> help
area51 help
```

### Scope

Your CLI access may be scoped. Run `area51 help` to see which resources are available and whether args are auto-filled. Under `group` scope (the default), `--id` and group-related args are auto-filled to your agent group — you don't need to pass them.

### Resources

Run `area51 help` for the full list. Common resources:

| Resource     | Verbs                                                                                                                                     | What it is                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| groups       | list, get, create, update, delete, restart, config get/update, config add-mcp-server/remove-mcp-server, config add-package/remove-package | Agent groups (workspace, personality, container config) |
| sessions     | list, get                                                                                                                                 | Active sessions (read-only)                             |
| destinations | list, add, remove                                                                                                                         | Where an agent group can send messages                  |
| members      | list, add, remove                                                                                                                         | Unprivileged access gate for an agent group             |
| tasks        | list, get, create, update, cancel, pause, resume, delete, append-log                                                                      | Scheduled tasks for your agent group                    |
| wirings      | get, update                                                                                                                               | Response policy for the current chat                    |

Additional resources (available under `global` scope only): messaging-groups, users, roles, user-dms, dropped-messages, approvals.

Under `group` scope, `wirings get/update` always targets the current chat. Updates may only change `engage_mode` and `engage_pattern` and require human approval.

### When to use

- **Looking up your own config** — `area51 groups get` or `area51 groups config get` to see your container config.
- **Restarting your container** — `area51 groups restart` (with optional `--rebuild` and `--message`).
- **Checking who's in your group** — `area51 members list`.
- **Seeing your destinations** — `area51 destinations list`.
- **Scheduling work** — `area51 tasks create`, then `area51 tasks list/get/update/cancel/pause/resume/delete`; `area51 tasks run <id>` fires one extra run now (testing) without changing the schedule. Each task run auto-logs its final text to the run log; `area51 tasks append-log --msg "…"` is for extra mid-run notes (host-timestamped, not a message).
- **Explaining or changing response behavior** — inspect `area51 wirings get`, then request an update.
- **Answering questions about the system** — query `area51` rather than guessing.

### Access rules

Read commands (list, get) are open. Most write commands (create, update, delete, restart, config update, add, remove) require admin approval — the request is held until an admin approves it. `area51 tasks` is the exception: an agent can manage its own group tasks without approval.

### Approval flow

Write commands require admin approval. Here's what happens:

1. You run the command (e.g. `area51 groups config update --model claude-sonnet-4-5-20250514`).
2. The command returns immediately with an `approval-pending` response — it has **not** been executed yet.
3. An admin or owner gets a notification showing exactly what you requested, with approve/reject options.
4. Once the admin responds:
   - **Approved:** the command executes and the result is delivered back to you as a system message in this conversation.
   - **Rejected:** you get a system message saying the request was rejected.

You don't need to poll or retry — the result arrives automatically.

### Examples

```bash
# Read commands (no approval needed)
area51 groups get
area51 groups config get
area51 sessions list
area51 destinations list
area51 members list
area51 tasks list
area51 wirings get
# Always pass a short descriptive --name so the task id is readable (e.g. daily-briefing-a25c, not a long uuid).
# For a recurring task, --recurrence alone sets the schedule (first run derived from it); add --process-after only for one-shots.
area51 tasks create --name "daily briefing" --prompt "Send the daily briefing" --recurrence "0 9 * * *"
# Add an optional progress note during a task run. The final response is logged automatically; the host stamps the local time.
# This is a LOG ENTRY, not a message: it sends nothing to anyone. Inside a task run --id is auto-derived.
area51 tasks append-log --msg "one feed returned 403; continuing with the remaining feeds"

# Write commands (approval required)
area51 groups restart
area51 groups restart --rebuild --message "Config updated."
area51 groups config update --model claude-sonnet-4-5-20250514
area51 groups config add-mcp-server --name rss --command npx --args '["some-rss-mcp"]'
area51 groups config add-mcp-server --name remote --url https://example.com/mcp
area51 groups config add-package --npm some-package
area51 members add --user telegram:jane
area51 wirings update --engage-mode pattern --engage-pattern "."
```

### Important

Config changes via `area51 groups config update` do not take effect until `area51 groups restart`. Run `area51 groups config help` for details.

### Tips

- Use `area51 <resource> help` to see all available fields, types, enums, and which fields are auto-filled.
- Flags use `--hyphen-case` (e.g. `--agent-group-id`), mapped to `underscore_case` DB columns automatically.
- `list` supports filtering by any non-auto column. Default limit is 200 rows; override with `--limit N`.
- Write commands return `approval-pending` immediately — don't treat this as an error. Wait for the system message with the result.
