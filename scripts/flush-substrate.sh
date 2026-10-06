#!/usr/bin/env bash
set -euo pipefail

# Flushes this demo's Substrate state completely: every actor in the
# "kagent-system" atespace, their snapshot objects in GCS, and (fallback
# only, if kubectl-ate delete leaves stragglers) their rows directly in
# ate-system's own postgres.
#
# Scoping matters here: the snapshot bucket prefix and ate-system's
# postgres are SHARED with other atespaces/harnesses on this cluster -
# "ate-golden" holds reference/golden snapshots (never touched - excluded
# the same way fraud-ops-console's own ListActors excludes it), and a
# sibling "my-first-agent" harness nests under the same bucket prefix too
# (live-confirmed via `gcloud storage ls`). This script only ever touches
# paths/rows scoped to atespace=kagent-system.
#
# Known limitation: this does NOT clear kagent-controller's own
# agent_instance table (a separate Postgres in kagent-system, keyed by
# user_id+request_id for idempotency, with no harness/atespace column to
# scope a safe delete by). "Submit sample case" always reuses
# request_id=ALERT-1001, so after a flush that idempotency key still
# resolves to the pre-flush AgentInstance, which may error once its
# backing actor is gone - if the first hero-case click after a flush
# fails, just click it again (kagent will create a fresh instance once the
# stale one errors out).
#
# Dry-run by default - prints exactly what it would delete and exits.
# Pass --yes to actually delete.

ATE_NAMESPACE="${ATE_NAMESPACE:-ate-system}"
ATESPACE="${ATESPACE:-kagent-system}"
SNAPSHOT_BUCKET="${SNAPSHOT_BUCKET:-gs://kasunt-gke-single-cl-db65bfb4ee20-1-workload-storage/kagent-system}"
# Derived from ATESPACE by default so the two can never silently drift
# apart - overriding ATESPACE alone (without also updating this) would
# otherwise delete actors from one atespace while wiping a different
# atespace's snapshots, or the shared ate-golden/other-harness prefixes.
# Only override this directly once you've verified it points at exactly
# atespace "$ATESPACE"'s own subtree.
SNAPSHOT_BUCKET_PREFIX="${SNAPSHOT_BUCKET_PREFIX:-${SNAPSHOT_BUCKET}/atespaces/${ATESPACE}/}"
ATE_PG_POD="${ATE_PG_POD:-postgres-0}"
CONSOLE_NAMESPACE="${CONSOLE_NAMESPACE:-kagent-system}"
CONSOLE_LABEL="${CONSOLE_LABEL:-app=fraud-ops-console}"
ATE_API_ENDPOINT="${ATE_API_ENDPOINT:-api.ate-system.svc.cluster.local:443}"

usage() {
  cat <<EOF
Usage: $0 [--yes]

Deletes every actor in atespace "$ATESPACE", its snapshot objects under
$SNAPSHOT_BUCKET_PREFIX, and (fallback only) any stray rows left in
ate-system's postgres. Destructive and irreversible - lists what it's
about to delete and requires --yes to actually proceed.

Env overrides: ATE_NAMESPACE, ATESPACE, SNAPSHOT_BUCKET_PREFIX, ATE_PG_POD,
CONSOLE_NAMESPACE, CONSOLE_LABEL, ATE_API_ENDPOINT.
EOF
}

confirm=false
for arg in "$@"; do
  case "$arg" in
    --yes | -y) confirm=true ;;
    --help | -h)
      usage
      exit 0
      ;;
    *)
      echo "unknown arg: $arg" >&2
      usage
      exit 1
      ;;
  esac
done

console_pod=$(kubectl -n "$CONSOLE_NAMESPACE" get pods -l "$CONSOLE_LABEL" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
if [ -z "$console_pod" ]; then
  echo "error: no pod matching -l $CONSOLE_LABEL in namespace $CONSOLE_NAMESPACE (needed for its bundled kubectl-ate + ate-client RBAC)" >&2
  exit 1
fi

ate() {
  kubectl -n "$CONSOLE_NAMESPACE" exec "$console_pod" -- kubectl-ate "$@" --endpoint "$ATE_API_ENDPOINT"
}

echo "== listing actors in atespace \"$ATESPACE\" =="
actor_names=$(ate get actors --atespace "$ATESPACE" -o json | python3 -c '
import json, sys
d = json.load(sys.stdin)
for a in d.get("actors", []):
    print(a["metadata"]["name"])
')
actor_count=$(printf '%s\n' "$actor_names" | grep -c . || true)
echo "  $actor_count actor(s) found"

echo "== counting snapshot objects under $SNAPSHOT_BUCKET_PREFIX =="
object_count=$( (gcloud storage ls "${SNAPSHOT_BUCKET_PREFIX}**" 2>/dev/null || true) | wc -l | tr -d ' ')
echo "  $object_count object(s) found"

if [ "$actor_count" -eq 0 ] && [ "$object_count" -eq 0 ]; then
  echo "Nothing to flush - atespace \"$ATESPACE\" and its snapshot prefix are already empty."
  exit 0
fi

echo ""
echo "This will permanently delete:"
echo "  - $actor_count actor(s) in atespace \"$ATESPACE\" (kubectl-ate delete actor --any-state)"
echo "  - $object_count object(s) under $SNAPSHOT_BUCKET_PREFIX"
echo "  - any stray postgres rows left in atespace \"$ATESPACE\" (fallback only, if the above leaves stragglers)"
echo ""
echo "NOT touched: the ate-golden atespace, any other atespace/harness sharing this bucket,"
echo "kagent-controller's own agent_instance table (see the note at the top of this script)."
echo ""

if [ "$confirm" != true ]; then
  echo "Dry run only - re-run with --yes to actually delete."
  exit 0
fi

if [ "$actor_count" -gt 0 ]; then
  echo "== deleting actors =="
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    echo "  deleting $name"
    ate delete actor "$name" --any-state -a "$ATESPACE"
  done <<<"$actor_names"
fi

if [ "$object_count" -gt 0 ]; then
  echo "== deleting snapshot objects =="
  # kubectl-ate delete actor --any-state can trigger ate-controller's own
  # cleanup of that actor's snapshot objects, racing ahead of this step -
  # by the time it runs the prefix may already be empty, which gcloud
  # storage rm treats as an error ("matched no objects"). Tolerate that the
  # same way the counting step above does, so verification still runs.
  (gcloud storage rm -r "${SNAPSHOT_BUCKET_PREFIX}**" 2>/dev/null || true)
fi

echo "== verifying =="
remaining=$(ate get actors --atespace "$ATESPACE" -o json | python3 -c '
import json, sys
d = json.load(sys.stdin)
print(len(d.get("actors", [])))
')
if [ "$remaining" -gt 0 ]; then
  echo "  $remaining actor(s) survived kubectl-ate delete - falling back to direct postgres cleanup"
  kubectl -n "$ATE_NAMESPACE" exec "$ATE_PG_POD" -- psql -U postgres -d atepg \
    -c "DELETE FROM actors WHERE atespace = '$ATESPACE';"
else
  echo "  0 actors remaining - clean"
fi

echo "Done."
