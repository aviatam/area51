---
name: setup
description: Run initial Area51 setup. Use when user wants to install Area51, configure it, or go through first-time setup. Triggers on "setup", "install", "configure area51", or first-time setup requests.
---

# Area51 Setup

Tell the user to run `bash area51.sh` in their terminal. That script handles the full end-to-end setup — dependencies, container image, OneCLI vault, Anthropic credential, service, first agent, and optional channel wiring.

If they hit an error partway through, the script offers Claude-assisted recovery inline and resumes from where it stopped.
