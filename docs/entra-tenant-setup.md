# Entra tenant setup for sre-incident-response-system

Manual checklist for standing up the Entra tenant, app registrations, and two test users this usecase needs. Nothing here is automated (deliberately - see `docs/superpowers/specs/2026-09-08-cross-domain-mcp-identity-federation-design.md`'s Amendment section for why). Follow this once; hand the resulting IDs/secrets back to fill in `config/environments/aws-dev.yaml`'s `spec.entra.sreIRS.*` placeholders and the required `*_CLIENT_SECRET` env vars.

## 1. Create the tenant

Azure Portal -> search "Microsoft Entra ID" -> **Manage tenants** -> **+ Create** -> **Microsoft Entra ID**:

- Organization name: e.g. `sre-irs-demo`
- Initial domain name: e.g. `sreirsdemo` (becomes `sreirsdemo.onmicrosoft.com`)
- Country/region: your choice
- Tenant type: **Workforce** -> **Governed workforce**

The wizard also asks for a **Subscription** and **Resource Group** (billing/management scope for the tenant creation record itself, not something the tenant's identity data lives in). If you have a subscription but no resource group yet, create one first:

- Portal: search "Resource groups" -> **+ Create** -> select your existing subscription -> Resource group name, e.g. `rg-sre-irs-demo` -> Region: your choice -> **Review + create** -> **Create**.
- Or via CLI: `az group create --name rg-sre-irs-demo --location <region>` (e.g. `eastus`, or whatever region your subscription is scoped to).

Then go back to the tenant creation wizard and select that subscription + resource group. You land in the new tenant as Global Administrator automatically once it finishes.

Trade-off worth knowing: a brand-new tenant gives full isolation from the company directory, but means this validates against _a_ real Entra tenant, not necessarily _the_ one Keycloak is federated with in production. If proving the mechanism against the actual corporate identity relationship matters more than isolation, use the shared company tenant instead (see "Alternative" at the bottom).

## 2. Disable MFA for alice/bob

New tenants (Governed Workforce especially) ship with MFA enforced by default, through one of two mechanisms - check both, since which one applies depends on the tenant:

**Security Defaults (most common on a brand-new tenant):** Entra admin center -> Identity -> **Overview** -> **Properties** -> **Manage Security defaults** -> set **Enable Security defaults** to **No** -> **Save**. This disables the tenant-wide "everyone needs MFA" baseline in one toggle.

**Conditional Access policies (Governed Workforce may ship one or more Microsoft-managed baseline policies instead of, or alongside, Security Defaults):** Protection -> **Conditional Access -> Policies**. For any policy requiring MFA:

- Simplest for a demo tenant: open the policy -> set **Enable policy** to **Off**.
- More targeted (leaves the policy active for everyone else): edit the policy's **Users** condition -> **Exclude** -> add alice and bob.

**Per-user MFA (legacy, less likely on a new tenant but quick to check):** Users -> select alice -> **Authentication methods** -> if a "Require re-register MFA" or per-user MFA state shows as Enabled/Enforced, disable it there too. Repeat for bob.

After disabling, sign in as each user in a private browser window to confirm no MFA registration prompt appears.

## 3. Create the two test users

Identity -> **Users -> All users -> + New user -> Create new user**, twice:

| Field               | alice                                       | bob                            |
| ------------------- | ------------------------------------------- | ------------------------------ |
| User principal name | `alice@<tenant>.onmicrosoft.com`            | `bob@<tenant>.onmicrosoft.com` |
| Display name        | `alice`                                     | `bob`                          |
| Password            | auto-generate or set your own, note it down | same                           |
| Usage location      | your country                                | your country                   |
| Groups / Roles      | none                                        | none                           |
| Block sign-in       | No                                          | No                             |

If prompted toward Entitlement Management / Access Packages (a Governed Workforce feature) instead of the classic flow, you can ignore it - plain user creation still works the same way; entitlement management is optional, not required for basic sign-in and app role assignment.

**Verify both can actually sign in** before wiring anything else: open a private browser window, sign in as each user, complete any forced password-change/MFA-registration prompt once.

## 4. App registrations

**App registrations -> New registration**, three times:

### 4a. `chat-app` (the login client)

- Platform: Web, redirect URI `http://localhost:5173/callback` (add the public hostname's `/callback` too once `env.domains.app.sreIRS` is live, e.g. `https://sre-irs.mesh-demo.kasunt.apac.fe.solo.io/callback`)
- Certificates & secrets -> new client secret -> save it -> `ENTRA_CHAT_CLIENT_SECRET`
- Application (client) ID -> `entra.sreIRS.chatAppClientId`
- API permissions -> Add -> My APIs -> `agent-gateway` (create that one first, see 4b) -> delegated `access_as_user` -> grant admin consent

### 4b. `agent-gateway` (audience of the user's login token; does the Keycloak exchange and Entra OBO)

- Expose an API -> Application ID URI -> accept the default `api://<client-id>` (this tenant doesn't allow a bare custom string like `api://agent-gateway` without a verified custom domain - stick with the GUID-based default). `chat-app`'s scope request and this repo's config both template the agent-gateway client ID GUID into the scope string, so this default form is what they expect.
- **Set the access token version to 2** - Manifest -> find `api` -> `requestedAccessTokenVersion` -> set to `2` (defaults to `null`, which makes Entra issue v1.0-format tokens even though the client authenticates through the v2.0 endpoint - the agent's `verifyBearer` expects v2.0 claims: `iss` = `.../v2.0` and `aud` = the bare client ID GUID. A v1.0 token fails both checks at once - `sts.windows.net` issuer and an `api://<guid>` audience - surfacing as `token has invalid audience, token has invalid issuer`. No portal UI toggle for this field; edit the manifest directly, or via CLI: `az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/$(az ad app show --id <agentGatewayClientId> --query id -o tsv)" --headers "Content-Type=application/json" --body '{"api": {"requestedAccessTokenVersion": 2}}'`.
- Add a scope named `access_as_user`, admin+user consentable, with:
  - Admin consent display name: `Access agent-gateway on behalf of the signed-in user`
  - Admin consent description: `Allows agent-gateway to investigate incidents and request deployment rollbacks on behalf of the signed-in user.`
  - User consent display name: `Access agent-gateway on your behalf`
  - User consent description: `Allows agent-gateway to investigate incidents and request deployment rollbacks on your behalf.` (the user consent fields are also mandatory here - Entra requires them whenever a scope is set to "Admins and users" consentable, not just admin consent)
- Authentication -> **+ Add a platform -> Web** -> redirect URI `http://localhost:5173/elicitation/callback` (add the public hostname's `/elicitation/callback` too once `env.domains.app.sreIRS` is live, e.g. `https://sre-irs.mesh-demo.kasunt.apac.fe.solo.io/elicitation/callback`). This is separate from `chat-app`'s own redirect URI in 4a - the elicitation flow runs its own interactive consent using `agent-gateway`'s client ID (see `mcp-elicitation-policy`'s config), not `chat-app`'s.
- Certificates & secrets -> new client secret -> save it -> `ENTRA_GATEWAY_CLIENT_SECRET`
- Application (client) ID -> `entra.sreIRS.agentGatewayClientId`

### 4c. `repo-mcp` (the resource the rollback tool lives behind - Entra-native, no Keycloak)

- Expose an API -> Application ID URI -> accept the default `api://<client-id>` (same restriction as `agent-gateway` in 4b - this tenant doesn't allow a bare custom string like `api://repo-mcp` without a verified custom domain). `mcp-elicitation-policy`'s `scopes` in the usecase spec already templates this client ID GUID into the requested scope, so no further config change is needed once you fill in `repoMcpClientId` below.
- **Set the access token version to 2** - same as 4b's step and same reason: left at the `null` default, the OBO-exchanged token agentgateway holds for repo-mcp comes back v1.0-format instead of the v2.0 shape expected downstream. Manifest -> `api.requestedAccessTokenVersion` -> `2`, or the equivalent `az rest` PATCH from 4b with `repoMcpClientId`.
- Still on Expose an API -> **Add a scope** -> name it `access_as_user`, admin+user consentable, with the same four consent fields as 4b:
  - Admin consent display name: `Access repo-mcp on behalf of the signed-in user`
  - Admin consent description: `Allows repo-mcp actions (including deployment rollback) to be performed on behalf of the signed-in user.`
  - User consent display name: `Access repo-mcp on your behalf`
  - User consent description: `Allows repo-mcp actions (including deployment rollback) to be performed on your behalf.` The elicitation consent screen requests `api://<repo-mcp client id>/.default`, which expands to whatever this app exposes - add this scope defensively even though the actual gate is the app role below, so `.default` has a concrete delegated permission to resolve to. Worth confirming live whether it's strictly required.
- App roles -> Create app role:
  - Display name: `Deployment Rollback`
  - Value: `deployment.rollback`
  - Allowed member types: **Users/Groups**
- Enterprise Applications -> `repo-mcp` -> Properties -> **Assignment required? = Yes** (so only explicitly-assigned users can get a token for this API at all, not just anyone who passes the role check)
- Application (client) ID -> `entra.sreIRS.repoMcpClientId`

## 5. Role assignments (Enterprise Applications -> each app -> Users and groups -> Add user/group)

| App             | alice                                  | bob                                                |
| --------------- | --------------------------------------- | --------------------------------------------------- |
| `agent-gateway` | Assign (default access)                | Assign (default access) - both can log in and read |
| `repo-mcp`      | Assign, role = **Deployment Rollback** | Do not assign at all                               |

With `Assignment required = Yes` on `repo-mcp`, bob's OBO attempt fails outright (not assigned to the resource) rather than reaching the CEL role check - test both users through the full read path first, then try rollback with each to confirm the denial surfaces as expected.

## 6. Record the tenant ID

Entra ID -> **Overview -> Tenant ID** -> `entra.sreIRS.tenantId`.

## 7. Keycloak side - now automated, no manual steps here

The `sre-irs` Keycloak realm, its `gateway-exchange` client, and the Entra identity provider (broker) are all declared in `config/profiles/eks-multi-cluster-agentic-stack-kagent-runtime-spire.yaml` under the keycloak addon's `realms:` list, and get created automatically the next time that addon deploys/reconciles - nothing to do by hand here beyond having `ENTRA_GATEWAY_CLIENT_SECRET` set (same env var as 4b's client secret - the broker reuses `agent-gateway`'s own Entra app registration rather than a dedicated one).

**Unverified:** the broker registration lets Keycloak validate an Entra-issued token's signature/issuer, but whether a runtime token-exchange call actually resolves through Keycloak's external-token-exchange path (distinct from the same-client self-exchange already proven live elsewhere in this demo, e.g. `retail-returns-customers`) hasn't been confirmed against a real Entra tenant. If it doesn't work as configured, the identity provider's `config` fields (in `addons/keycloak/index.js`'s `configureIdentityProvider()`) are the place to start adjusting - the Keycloak Admin REST API payload for an OIDC broker was written from general knowledge, not confirmed against a live Keycloak+Entra pairing.

## What to hand back

- Tenant ID
- `chat-app`, `agent-gateway`, `repo-mcp` client IDs (all three are wired into config - each Application ID URI ended up as the default `api://<client-id>` form, so the client ID GUIDs themselves are what the scope strings and `jwtAudiences` template in)
- `chat-app`, `agent-gateway` client secrets
- Confirmation both alice and bob can sign in

---

## Alternative: shared company tenant instead of a new one

If proving this against the real corporate identity relationship (the one Keycloak is actually federated with) matters more than isolation, skip Section 1 and use the existing company tenant instead. To keep the two test users easy to find and delete later without touching anything else:

- Name them distinctively: `zdemo-alice@<tenant>.onmicrosoft.com` / `zdemo-bob@<tenant>.onmicrosoft.com` - a directory search for `zdemo-` finds exactly these two.
- Everything else (app registrations, role assignments) is identical to Sections 4-5 above.
- Set yourself a reminder to delete both users and the three app registrations once validation is done - there's no automatic expiry unless the tenant has Entra ID Governance (P2) Access Reviews configured.

Via CLI instead of the portal, if you have `az` and admin rights:

```bash
az ad user create \
  --display-name "zdemo-alice" \
  --user-principal-name "zdemo-alice@<tenant>.onmicrosoft.com" \
  --password "<temp-password>" \
  --force-change-password-next-sign-in false

az ad user delete --id zdemo-alice@<tenant>.onmicrosoft.com  # cleanup, when done
```
