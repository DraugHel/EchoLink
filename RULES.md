## Terminal usage
- Prefer read-only commands from the auto-approve list (ls, cat, head, tail, wc, grep, find, which, ps, df, du, free, pm2 status/list/logs --nostream, git status/log/diff/show, systemctl status, journalctl, docker ps/logs) — they run without approval. Wrap grep/find patterns in single quotes; unquoted \| or $ forces an approval prompt.
- Destructive commands (rm, mv, pm2 restart/delete, git push/reset, file edits) require user approval — propose them only when clearly needed.
- NEVER pretend or narrate a terminal command. Either make a real tool call or say you didn't run anything. Only actual tool output counts as proof — after any state-changing command, verify the result with a read-only command in the same turn before reporting success.
- Output is truncated at 4000 chars; use grep/head/tail instead of cat on large files. If unsure about the state of anything, check it instead of guessing.

## Editing code on this server
- EchoLink (/root/echolink) serves this very chat — a broken file takes the chat down. After any edit: node --check the file, pm2 restart echolink, then a quick test chat (streaming must work). Code changes are inactive until restart.
- NEVER rename SSE event fields (token, think, done, error, actionRequest, tool, status) — the frontend depends on these exact names; server and client change together.
- When refactoring: preserve behavior exactly (no dropping validation, formatting blocks, or error handling) and never delete routes, exports, or helpers unless explicitly asked — grep the whole project including client/src for usages first. Past violations broke /models/list, updateMemory, and the urlContext formatter.
- Cosmetic cleanup (dead imports, formatting) is low priority: only when explicitly asked, bundled into one edit, never iterated on the live app.
- Other PM2 apps: sillytavern, paywall-bypass; Marinara runs under the `marinara` user (su - marinara, then pm2 restart marinara).

## Dependencies
- Install packages only with `npm install <name>` inside /root/echolink so they land in package.json — unsaved packages get pruned on the next npm run and crash-loop the app (happened with sharp).
- Never run `npm audit fix --force` — it has broken installs before.
- After any npm operation: restart, then check `pm2 logs echolink --err --lines 10 --nostream` for ERR_MODULE_NOT_FOUND.

## Deleting files & cleanup
- Before deleting an app directory, check for user data (data/, config/, uploads/): back it up and VERIFY the archive (`tar tzf | wc -l` shows a plausible count) before any rm. Never tar and rm in one step.
- Never use wildcards with rm in /root — live dot-dirs (.hermes, .pm2, .ssh) sit there. Spell out explicit paths.
- Edit configs by pattern (`sed -i '\|pattern|d'`), not by line number — line numbers go stale.
- Files in /root that mirror container-internal files (e.g. SearXNG plugin scripts) are backups, not clutter — container filesystems are wiped on recreate.
- After cleanup: verify with read-only commands and report before/after numbers (df -h).

## Style
- Answer in German unless the user writes English. Casual tone, concise, no filler, no restating the question.
