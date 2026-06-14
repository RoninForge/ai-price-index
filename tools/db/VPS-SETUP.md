# VPS setup: system of record + publish loop

The SQLite system of record runs on the RoninForge VPS, isolated from the other stacks. It is not
publicly exposed (no API in v1). A daily cron pulls merged record edits, applies them to the
bitemporal DB, re-exports the static artifacts, and pushes them back when the data actually changed.
This is a runbook; it contains no secrets.

## One-time setup

```sh
# 1. clone the repo onto the VPS (public, no auth needed to clone)
git clone https://github.com/RoninForge/ai-price-index /home/agentuser/ai-price-index
cd /home/agentuser/ai-price-index

# 2. build the isolated tools image (python:3.12-slim, stdlib only) and seed the DB
docker compose build aipi
docker compose run --rm aipi tools/db/aipi.py init
docker compose run --rm aipi tools/db/aipi.py seed

# 3. a dedicated, write-scoped deploy key so the box can push (and only to this one repo)
ssh-keygen -t ed25519 -f /root/.ssh/aipi_deploy -N "" -C "vps-export-ai-price-index"
#    add the PUBLIC half (cat /root/.ssh/aipi_deploy.pub) as a deploy key with write access:
#      gh repo deploy-key add /path/to/aipi_deploy.pub --repo RoninForge/ai-price-index --title vps-export --allow-write
#    (the org must allow deploy keys: deploy_keys_enabled_for_repositories=true)

# 4. point the repo at SSH and use only that key for this repo
git remote set-url origin git@github.com:RoninForge/ai-price-index.git
git config core.sshCommand "ssh -i /root/.ssh/aipi_deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
git config user.name "ai-price-index export bot"
git config user.email "export-bot@roninforge.org"

# 5. daily publish cron (root). 04:17 UTC, after certbot.
( crontab -l 2>/dev/null | grep -v export-and-publish.sh || true
  echo "17 4 * * * /home/agentuser/ai-price-index/tools/db/export-and-publish.sh >> /var/log/aipi-publish.log 2>&1" ) | crontab -
```

## The daily loop

`tools/db/export-and-publish.sh` (POSIX sh, dash-safe): `git pull --ff-only` -> seed (idempotent;
supersedes on a changed value) -> export -> commit + push + tag **only when `data/ai-price-index/`
actually changed** (the export is deterministic: `dataModified` is the latest validation date, not a
wall clock, so a no-op run produces no diff). Logs to `/var/log/aipi-publish.log`.

Run it by hand any time:

```sh
sh /home/agentuser/ai-price-index/tools/db/export-and-publish.sh
```

## Revoke the VPS's write access

Delete the one deploy key (GitHub repo Settings -> Deploy keys, or
`gh api -X DELETE repos/RoninForge/ai-price-index/keys/<id>`) and remove `/root/.ssh/aipi_deploy*`.
Nothing else has access; the key is scoped to this repository only.
