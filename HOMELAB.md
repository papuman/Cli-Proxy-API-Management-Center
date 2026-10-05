# HomeLab build

This branch is the management UI served by the lab's CLIProxyAPI (docker-prd-01:8317).

- Base: chhoumann/Cli-Proxy-API-Management-Center `dev` @ 24633a8 = upstream v1.25.3 + the quota Ledger view
  (chhoumann PR #2, modeled on Theo's setup video). Reviewed 2026-10-05: quota page only, no new deps,
  no outside network calls.
- Build: `bun install --frozen-lockfile && bun test && bun run build` → `dist/index.html`.
- Each GitHub release here carries that file as `management.html`.

## Deploy

```bash
scp dist/index.html labadmin@10.10.200.50:/tmp/management.html
ssh labadmin@10.10.200.50 'sudo install -m 644 /tmp/management.html /srv/cli-proxy-api/static/management.html'
```

The proxy mounts that file read-only, and its config has `management.disable-auto-update-panel: true`;
without that it downloads the upstream panel on start and overwrites this one. Hard-reload the browser after.
Proxy-side files live in HomeLab `cli-proxy-api/`.

## Updating

Merge upstream `main` (router-for-me) or chhoumann `dev` into this branch, rebuild, retest, cut a new release.
