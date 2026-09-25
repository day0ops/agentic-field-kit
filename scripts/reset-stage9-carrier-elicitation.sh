#!/usr/bin/env bash
# Resets retail-returns-agent-system's Stage 9 (agentgateway interactive
# elicitation) demo state so the next walkthrough shows the full gate again:
# real 400 -> real carrier-portal login -> real consent screen -> retry.
#
# Two independent things persist across walkthroughs and both need clearing:
#   1. Keycloak's own per-user consent grant (carrier-portal realm, demo-carrier-customer
#      user) -- once granted, Keycloak skips the consent screen on future logins even
#      after a fresh OAuth redirect. Needs a master-realm admin token.
#   2. The STS's banked elicitation/token (customer-scoped -- no admin needed). The BFF
#      itself now clears this automatically after every successful link, so this is
#      mainly a safety net for state left over from before that existed, or a manual
#      customer/resource not covered by the app's own cleanup.
#
# Required env vars:
#   KEYCLOAK_ADMIN_USERNAME, KEYCLOAK_ADMIN_PASSWORD  -- master realm bootstrap admin
#   RETAIL_RETURNS_CUSTOMER_PASSWORD                  -- demo-customer's own password
#
# Usage:
#   KUBECONFIG=._output/infra/<name>/kubeconfig/east.yaml \
#     ./scripts/reset-stage9-carrier-elicitation.sh <keycloak-base-url> [customer-username]
#
# Example:
#   ./scripts/reset-stage9-carrier-elicitation.sh https://keycloak.mesh-demo.kasunt.apac.fe.solo.io

set -euo pipefail

KEYCLOAK_BASE="${1:?usage: reset-stage9-carrier-elicitation.sh <keycloak-base-url> [customer-username]}"
CUSTOMER_USERNAME="${2:-demo-customer}"

CARRIER_REALM="carrier-portal"
CARRIER_CLIENT_ID="carrier-portal-ui"
CARRIER_USERNAME="demo-carrier-customer"

CUSTOMER_REALM="retail-returns-customers"
CUSTOMER_CLIENT_ID="retail-returns-ui"
CUSTOMER_CLIENT_SECRET="retail-returns-ui-secret"

AGW_NAMESPACE="${AGW_NAMESPACE:-agentgateway-system}"
AGW_SERVICE="${AGW_SERVICE:-enterprise-agentgateway}"
LOCAL_PORT="${LOCAL_PORT:-17777}"

: "${KEYCLOAK_ADMIN_USERNAME:?required}"
: "${KEYCLOAK_ADMIN_PASSWORD:?required}"
: "${RETAIL_RETURNS_CUSTOMER_PASSWORD:?required}"

echo "== 1/2: revoking Keycloak's persisted consent grant for '$CARRIER_USERNAME' =="
ADMIN_TOKEN=$(curl -sSf -X POST "$KEYCLOAK_BASE/realms/master/protocol/openid-connect/token" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "username=${KEYCLOAK_ADMIN_USERNAME}" \
  --data-urlencode "password=${KEYCLOAK_ADMIN_PASSWORD}" \
  --data-urlencode "grant_type=password" \
  --data-urlencode "client_id=admin-cli" | jq -r '.access_token')

USER_ID=$(curl -sSf -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$KEYCLOAK_BASE/admin/realms/$CARRIER_REALM/users?username=$CARRIER_USERNAME" \
  | jq -r '.[0].id // empty')

if [ -n "$USER_ID" ]; then
  curl -sS -o /dev/null -w 'consent revoke status: %{http_code}\n' \
    -X DELETE -H "Authorization: Bearer $ADMIN_TOKEN" \
    "$KEYCLOAK_BASE/admin/realms/$CARRIER_REALM/users/$USER_ID/consents/$CARRIER_CLIENT_ID"
else
  echo "no '$CARRIER_USERNAME' user found in realm '$CARRIER_REALM' -- skipping consent revoke"
fi

echo "== 2/2: deleting any banked carrier elicitation for '$CUSTOMER_USERNAME' (safety net) =="
kubectl port-forward -n "$AGW_NAMESPACE" "svc/$AGW_SERVICE" "$LOCAL_PORT:7777" \
  >/tmp/reset-stage9-pf.log 2>&1 &
PF_PID=$!
trap 'kill $PF_PID 2>/dev/null || true' EXIT
sleep 3

CUST_TOKEN=$(curl -sSf -X POST "$KEYCLOAK_BASE/realms/$CUSTOMER_REALM/protocol/openid-connect/token" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "grant_type=password" \
  --data-urlencode "client_id=$CUSTOMER_CLIENT_ID" \
  --data-urlencode "client_secret=$CUSTOMER_CLIENT_SECRET" \
  --data-urlencode "username=$CUSTOMER_USERNAME" \
  --data-urlencode "password=${RETAIL_RETURNS_CUSTOMER_PASSWORD}" \
  --data-urlencode "scope=openid" | jq -r '.access_token')

ELICITATION_ID=$(curl -sSf -H "Authorization: Bearer $CUST_TOKEN" "http://localhost:$LOCAL_PORT/elicitations" \
  | jq -r '[.[] | select(.Elicitation.resource | test("carrier"))][0].Elicitation.ID // empty')

if [ -n "$ELICITATION_ID" ]; then
  curl -sS -o /dev/null -w 'elicitation delete status: %{http_code}\n' \
    -X DELETE -H "Authorization: Bearer $CUST_TOKEN" \
    "http://localhost:$LOCAL_PORT/elicitations/$ELICITATION_ID"
else
  echo "no banked carrier elicitation found for '$CUSTOMER_USERNAME' -- nothing to delete"
fi

echo "Done. Next Stage 9 attempt for '$CUSTOMER_USERNAME' will show the full gate + consent screen again."
