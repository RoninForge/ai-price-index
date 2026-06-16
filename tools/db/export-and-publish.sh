#!/bin/sh
# ai-price-index export + publish (POSIX sh; dash-safe for cron).
#
# The daily steady-state loop on the VPS system of record:
#   1. pull any merged record edits from the public repo,
#   2. re-seed the bitemporal DB (idempotent; supersedes, never overwrites, on a changed value),
#   3. re-export the static artifacts,
#   4. commit + push + tag ONLY when the published data actually changed.
#
# Push uses the repo-scoped deploy key wired via `git config core.sshCommand` (set up once; the key
# only has write access to this one repo). Seed/export run in the isolated, network-less container;
# only the git pull/push touch the network, on the host.
set -eu

PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

REPO="${AIPI_REPO:-/home/agentuser/ai-price-index}"
cd "$REPO"

log() { echo "[aipi-publish $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

log "pull"
if ! git pull --ff-only --quiet origin main; then
	log "pull not fast-forward; skipping this run (will reconcile next run)"
	exit 0
fi

log "seed"
docker compose run --rm aipi tools/db/aipi.py seed --recorded-by cron >/dev/null

log "export"
docker compose run --rm aipi tools/db/aipi.py export >/dev/null

if [ -z "$(git status --porcelain -- data/ai-price-index)" ]; then
	log "no data change; nothing to publish"
	exit 0
fi

DATE="$(date -u +%Y.%m.%d)"
log "data changed; committing"
git add data/ai-price-index
git commit --quiet -m "data: export ${DATE}"
git push --quiet origin main

SHA="$(git rev-parse --short HEAD)"
TAG="v${DATE}-${SHA}"
git tag "$TAG"
git push --quiet origin "$TAG"
log "published ${TAG}"

# Machine-readable sentinel for the publish-on-merge CI step. It greps for a line matching
# ^PUBLISHED_TAG= to learn the new tag and then notifies the downstream consumers. This line
# is printed ONLY on a real publish; a no-op run exits earlier and never prints it.
echo "PUBLISHED_TAG=${TAG}"
