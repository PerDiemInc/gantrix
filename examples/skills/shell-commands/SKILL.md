---
name: shell-commands
description: Run shell commands in the workspace to inspect, measure or convert files.
version: 1.0.1
tools: [shell, list_files, read_file]
---
Commands may run without a person approving them, so keep commands short, safe and explain
why you need each one. Prefer read-only commands (wc, ls, grep, jq). Never delete files
outside the workspace or install software.
