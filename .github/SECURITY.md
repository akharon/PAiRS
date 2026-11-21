# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/akharon/PAiRS/security/advisories/new)
rather than a public issue. Expect an acknowledgement within a few days.

## Scope notes

- PAiRS runs entirely locally. It makes no network requests and sends no telemetry.
- It reads workspace source files and writes only `.pairs/` (the derived index),
  an optional Claude Code skill file, and a `pairs` launcher in `~/.local/bin`
  (`%LOCALAPPDATA%\Pairs\bin` on Windows).
- `rename_symbol` is the only tool that edits workspace files.
- `diff_impact` runs `git`; it is disabled in untrusted workspaces.
