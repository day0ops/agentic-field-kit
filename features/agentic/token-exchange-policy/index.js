import { Feature } from '../../../src/lib/feature.js';
import { CommandRunner } from '../../../src/lib/common.js';

/**
 * TokenExchangePolicyFeature
 *
 * Applies three EnterpriseAgentgatewayPolicy objects:
 *   1. JWT validation (spec.traffic.jwtAuthentication), targeting the delegate
 *      HTTPRoute plus every agentgateway-a2a-route HTTPRoute (a2aAgentNames) —
 *      does NOT apply gateway-wide (confirmed live: a route not explicitly listed
 *      here gets zero auth enforcement), and does inherit through AgentRegistry's
 *      HTTPRoute-to-HTTPRoute delegation from the one delegate route it targets,
 *      but each *separate* top-level route (like an A2A route) needs its own
 *      explicit entry in targetRefs.
 *   2. Token exchange (RFC 8693, spec.backend.auth.oauthTokenExchange) for the MCP
 *      path, targeting the concrete per-MCP-server EnterpriseAgentgatewayBackend
 *      objects directly.
 *   3. The same token exchange for the A2A path (buildA2AExchangePolicy below),
 *      targeting the statically-named `<agentName>-a2a` Backend objects.
 *
 * Why two policies, and why not target the delegate HTTPRoute for both: AgentRegistry
 * registers each MCP server behind its own dynamically-created HTTPRoute + Backend in
 * agentregistry-system (e.g. gw-dep-default-order-db-<hash>), one hop downstream of the
 * delegate HTTPRoute this use case owns. A policy's backend.auth only applies to the
 * concrete Backend actually selected for a request — it does not inherit through
 * HTTPRoute-to-HTTPRoute delegation the way traffic.jwtAuthentication does. Targeting
 * the delegate route for oauthTokenExchange looked like it worked (dry-run validated,
 * deploy succeeded) but silently never exchanged anything: the original customer JWT
 * passed straight through unchanged. Confirmed via a live whoami round-trip where the
 * token's jti was identical before and after — i.e. no exchange occurred.
 *
 * The per-server Backend names are hash-suffixed and not knowable ahead of time, so
 * they're discovered live at deploy time (after this use case's agentregistry-catalog
 * steps have already run) by label (agentregistry.solo.io/ownerName=<mcpServerName>)
 * rather than hardcoded.
 *
 * Combining both policy types on one object is also blocked by CEL validation:
 * EnterpriseAgentgatewayPolicy allows Backend-kind targetRefs in general, but a
 * separate rule forces Gateway/HTTPRoute/GRPCRoute/ListenerSet/Service/ServiceEntry-only
 * targeting whenever spec.traffic is also set — so a policy can't carry both
 * jwtAuthentication and a Backend-targeted oauthTokenExchange at once regardless.
 *
 * Also applies a ReferenceGrant (in Keycloak's own namespace) so these policies — which
 * live outside Keycloak's namespace — are allowed to reference Keycloak's Service for
 * both JWKS and the token-exchange endpoint.
 *
 * Configuration:
 * {
 *   policyName: string,               // Required — base name; JWT policy uses this name
 *                                      // as-is, the exchange policy suffixes '-exchange'
 *   namespace: string,                // Required — must match the target HTTPRoute's namespace
 *   targetHTTPRoute: string,          // Required — HTTPRoute name, same namespace as this policy
 *   mcpServerNames: string[],         // Required — agentregistry serverName values (from this
 *                                      // use case's agentregistry-catalog steps) whose live
 *                                      // Backend objects the exchange policy should target
 *   backendDiscoveryNamespace: string, // Default: 'agentregistry-system' — namespace AgentRegistry
 *                                      // creates its dynamic per-server Backend objects in
 *   a2aAgentNames: string[],          // Optional — agentgateway-a2a-route feature's agentName
 *                                      // values (e.g. ['order-lookup']) whose '<name>-a2a'
 *                                      // EnterpriseAgentgatewayBackend a second exchange policy
 *                                      // should target. Statically named (no discovery needed,
 *                                      // we create those Backends ourselves), and applied via a
 *                                      // separate policy object in `namespace` since Backend-kind
 *                                      // targetRefs must live in the same namespace as the policy.
 *   jwtIssuer: string,                // Required — issuer of the INCOMING JWT the JWT auth
 *                                      // policy validates, e.g. https://<keycloak>/realms/<realm>
 *                                      // for same-realm exchange, or an external IdP's issuer
 *                                      // (e.g. Entra) when jwksRemoteUrl is also set.
 *   jwtAudiences: string[],           // Optional
 *   keycloakIssuer: string,           // Optional — Keycloak's own issuer, used only for the
 *                                      // exchange leg's TLS hostname validation. Defaults to
 *                                      // jwtIssuer; set explicitly when jwtIssuer is an
 *                                      // external IdP rather than Keycloak itself.
 *   jwksRemoteUrl: string,            // Optional — full external JWKS URL (e.g. Entra's
 *                                      // https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys).
 *                                      // When set, the JWT policy uses jwks.remote.url instead of
 *                                      // jwks.remote.backendRef — for validating a JWT issued by
 *                                      // something other than the in-cluster Keycloak this feature
 *                                      // otherwise assumes (the exchange leg below still always
 *                                      // targets Keycloak regardless — this only changes where the
 *                                      // *validation* JWKS comes from). Mutually exclusive with
 *                                      // jwksPath/keycloak-backendRef-based JWKS below; when set,
 *                                      // jwksPath is not required.
 *   keycloak: {                       // Required — Keycloak's Service coordinates
 *     serviceName: string,            // Default: 'keycloak'
 *     namespace: string,              // Required
 *     port: number,                   // Default: 8080 (internal HTTP, matches this repo's
 *                                      // other in-cluster Keycloak references, e.g.
 *                                      // env.internal.kagent.controllerUrl)
 *   },
 *   jwksPath: string,                 // Required unless jwksRemoteUrl is set — e.g.
 *                                      // /realms/<realm>/protocol/openid-connect/certs
 *   exchangePath: string,             // Required — e.g. /realms/<realm>/protocol/openid-connect/token
 *   staticBackendNames: string[],     // Optional — alternative to mcpServerNames for callers that
 *                                      // aren't using AgentRegistry: exact EnterpriseAgentgatewayBackend
 *                                      // names to target directly, skipping discoverBackendName()'s
 *                                      // label lookup entirely. When set, the exchange policy (and its
 *                                      // client Secret) are created in `namespace` (this policy's own
 *                                      // namespace), not backendDiscoveryNamespace — there's no
 *                                      // AgentRegistry-owned namespace to defer to.
 *   clientId: string,                 // Required — outbound OAuth client agentgateway authenticates as
 *   clientSecret: string,             // Required — plaintext value of the Keycloak client's
 *                                     // secret; the feature creates the Kubernetes Secret
 *                                     // itself (same pattern as features/agentic/providers),
 *                                     // callers don't pre-create it out of band
 *   requestedTokenType: string,       // Default: 'AccessToken'. Only valid with grantType 'TokenExchange' —
 *                                      // omitted from the built spec when grantType is 'JwtBearer'.
 *   exchangeAudiences: string[],      // Optional — exchange target audiences. Only valid with grantType
 *                                      // 'TokenExchange' — omitted from the built spec when grantType is
 *                                      // 'JwtBearer' (RFC 8693 audience has no equivalent in the RFC 7523
 *                                      // assertion grant Keycloak's JWT Authorization Grant expects).
 *   scopes: string[],                 // Optional
 *   grantType: string,                // Default: 'TokenExchange' (RFC 8693, same-realm subject tokens only —
 *                                      // Keycloak's Standard Token Exchange V2 rejects externally-issued
 *                                      // subject tokens). Set to 'JwtBearer' when jwtIssuer is an external IdP
 *                                      // (e.g. Entra) validated via Keycloak's JWT Authorization Grant — requires
 *                                      // the external identity provider to have jwtAuthorizationGrantEnabled +
 *                                      // allowClientIdAsAudience + jwtAuthorizationGrantAssertionReuseAllowed set
 *                                      // (Entra tokens carry no jti), and the calling client to have
 *                                      // oauth2.jwt.authorization.grant.enabled/.idp attributes set — none of
 *                                      // this is automated by this feature yet. Also requires the subject's
 *                                      // Entra identity to already have a federated-identity link to a Keycloak
 *                                      // user (Keycloak will not JIT-create one for this grant) — see
 *                                      // docs/superpowers/specs/2026-09-08-cross-domain-mcp-identity-federation-design.md.
 * }
 */
export class TokenExchangePolicyFeature extends Feature {
  constructor(name, config = {}) {
    super(name, config);
    this.policyName = config.policyName;
    this.exchangePolicyName = config.policyName ? `${config.policyName}-exchange` : undefined;
    this.targetHTTPRoute = config.targetHTTPRoute;
    this.mcpServerNames = config.mcpServerNames || [];
    this.staticBackendNames = config.staticBackendNames || null;
    // Static backends have no AgentRegistry-owned namespace to defer to -- the exchange
    // policy and its client Secret live in this policy's own namespace instead.
    this.backendDiscoveryNamespace = this.staticBackendNames
      ? this.namespace
      : config.backendDiscoveryNamespace || 'agentregistry-system';
    this.jwksRemoteUrl = config.jwksRemoteUrl || null;
    // agentgateway-a2a-route feature's agentName values -- e.g. ['order-lookup'] targets
    // the 'order-lookup-a2a' EnterpriseAgentgatewayBackend it creates. Optional: the
    // exchange applies to MCP backends alone if this is left empty.
    this.a2aAgentNames = config.a2aAgentNames || [];
    this.jwtIssuer = config.jwtIssuer;
    this.jwtAudiences = config.jwtAudiences || [];
    // Keycloak's own issuer, used only for the exchange leg's BackendTLSPolicy hostname
    // validation. Defaults to jwtIssuer for backward compatibility (same-realm exchange,
    // where the incoming JWT's issuer and Keycloak's issuer are the same thing) -- set
    // explicitly when jwtIssuer is an external IdP (e.g. Entra) instead of Keycloak itself.
    this.keycloakIssuer = config.keycloakIssuer || config.jwtIssuer;
    const keycloak = config.keycloak || {};
    this.keycloakServiceName = keycloak.serviceName || 'keycloak';
    this.keycloakNamespace = keycloak.namespace;
    this.keycloakPort = keycloak.port || 8080;
    // The actual RFC 8693 exchange call (unlike JWKS fetching) needs HTTPS: Keycloak
    // rejects subject tokens with "Invalid token" when the exchange request itself
    // arrives over plain HTTP, even with a correct Host header -- confirmed live by
    // replaying the identical request against Keycloak's internal HTTP (8080) vs
    // HTTPS (443/8443) ports directly. JWKS validation has no such requirement (pure
    // signature verification), so it stays on keycloakPort/8080.
    this.keycloakExchangePort = keycloak.exchangePort || 443;
    this.jwksPath = config.jwksPath;
    this.exchangePath = config.exchangePath;
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.clientSecretName = `${config.policyName}-oidc-client`;
    this.clientSecretKey = 'clientSecret';
    this.requestedTokenType = config.requestedTokenType || 'AccessToken';
    this.exchangeAudiences = config.exchangeAudiences || [];
    this.scopes = config.scopes || [];
    this.grantType = config.grantType || 'TokenExchange';
  }

  validate() {
    if (!this.policyName) throw new Error('token-exchange-policy: policyName is required');
    if (!this.namespace) throw new Error('token-exchange-policy: namespace is required');
    if (!['TokenExchange', 'JwtBearer'].includes(this.grantType))
      throw new Error(
        `token-exchange-policy: grantType must be 'TokenExchange' or 'JwtBearer', got '${this.grantType}'`
      );
    if (!this.targetHTTPRoute)
      throw new Error('token-exchange-policy: targetHTTPRoute is required');
    if (this.mcpServerNames.length === 0 && !this.staticBackendNames)
      throw new Error(
        'token-exchange-policy: mcpServerNames is required (non-empty) unless staticBackendNames is set'
      );
    if (!this.jwtIssuer) throw new Error('token-exchange-policy: jwtIssuer is required');
    if (!this.keycloakNamespace)
      throw new Error('token-exchange-policy: keycloak.namespace is required');
    if (!this.jwksPath && !this.jwksRemoteUrl)
      throw new Error('token-exchange-policy: jwksPath is required unless jwksRemoteUrl is set');
    if (!this.exchangePath) throw new Error('token-exchange-policy: exchangePath is required');
    if (!this.clientId) throw new Error('token-exchange-policy: clientId is required');
    if (!this.clientSecret) throw new Error('token-exchange-policy: clientSecret is required');
    return true;
  }

  keycloakBackendRef() {
    return {
      name: this.keycloakServiceName,
      namespace: this.keycloakNamespace,
      port: this.keycloakPort,
    };
  }

  keycloakExchangeBackendRef() {
    return {
      name: this.keycloakServiceName,
      namespace: this.keycloakNamespace,
      port: this.keycloakExchangePort,
    };
  }

  buildJwtPolicy() {
    return {
      apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
      kind: 'EnterpriseAgentgatewayPolicy',
      metadata: {
        name: this.policyName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentic-demo',
          'agentic.demo/feature': this.name,
        },
      },
      spec: {
        // JWT enforcement does NOT apply gateway-wide by default -- confirmed live: a
        // request to an agentgateway-a2a-route HTTPRoute not listed here sailed straight
        // through with no auth check at all (reason=Internal, not reason=JwtAuth) the
        // moment it existed as its own top-level route, unlike agentregistry's
        // dynamically-created sub-routes which DO inherit enforcement because they're
        // delegated FROM targetHTTPRoute, not separate top-level routes. Every A2A route
        // this policy's exchange half also covers must be listed here too, or its
        // customer-identity story silently has an unauthenticated hole.
        targetRefs: [
          { group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', name: this.targetHTTPRoute },
          ...this.a2aAgentNames.map(agentName => ({
            group: 'gateway.networking.k8s.io',
            kind: 'HTTPRoute',
            name: `${agentName}-a2a`,
          })),
        ],
        traffic: {
          jwtAuthentication: {
            mode: 'Strict',
            providers: [
              {
                issuer: this.jwtIssuer,
                ...(this.jwtAudiences.length > 0 && { audiences: this.jwtAudiences }),
                jwks: {
                  remote: this.jwksRemoteUrl
                    ? { url: this.jwksRemoteUrl }
                    : { backendRef: this.keycloakBackendRef(), jwksPath: this.jwksPath },
                },
              },
            ],
          },
        },
      },
    };
  }

  /**
   * Discover the live EnterpriseAgentgatewayBackend name AgentRegistry created for a
   * given MCP server (labeled agentregistry.solo.io/ownerName=<serverName> in
   * backendDiscoveryNamespace). Throws if none or more than one match is found —
   * both are signs the deploy ordering or naming assumption is wrong, not something
   * to silently paper over with a partial targetRefs list.
   *
   * Also filters on ownerKind=Deployment -- confirmed live after bumping agentgateway
   * to v2026.8.2 (Phase 6): AgentRegistry now ALSO creates a second, MCPServer-owned
   * Backend + HTTPRoute pair per server (name prefixes gw-be-mcpserver- / gw-rt-mcpserver-),
   * matching a generic '/mcp' path -- a new, separate discovery mechanism, NOT a
   * replacement for the Deployment-owned one (gw-dep- prefix) this use case's
   * agentregistry-catalog steps actually rely on (matching '/retail-returns/<server>',
   * the path PAYMENT_URL/ORDER_DB_URL/etc. actually use). Confirmed by comparing both
   * HTTPRoutes' spec.rules[].matches directly -- they're for different paths, not
   * duplicates of the same one, so this is NOT a "pick the newer one" situation.
   * Without this filter, discovery finds 2 matches for every server and throws.
   */
  async discoverBackendName(serverName, context) {
    const contextFlag = context ? `--context=${context}` : '';
    const result = await CommandRunner.exec(
      `kubectl ${contextFlag} get enterpriseagentgatewaybackend -n ${this.backendDiscoveryNamespace} ` +
        `-l agentregistry.solo.io/ownerName=${serverName},agentregistry.solo.io/ownerKind=Deployment -o jsonpath='{.items[*].metadata.name}'`
    );
    const names = result.stdout.trim().split(/\s+/).filter(Boolean);
    if (names.length !== 1) {
      throw new Error(
        `token-exchange-policy: expected exactly 1 EnterpriseAgentgatewayBackend for ` +
          `MCP server '${serverName}' in namespace '${this.backendDiscoveryNamespace}', found ${names.length}` +
          (names.length > 0 ? ` (${names.join(', ')})` : '')
      );
    }
    return names[0];
  }

  oauthTokenExchangeSpec() {
    const isJwtBearer = this.grantType === 'JwtBearer';
    return {
      backendRef: this.keycloakExchangeBackendRef(),
      path: this.exchangePath,
      grantType: this.grantType,
      // requestedTokenType/audiences are RFC 8693 TokenExchange-only fields -- rejected by the
      // policy schema when grantType is JwtBearer (RFC 7523 has no audience/requested-token-type
      // equivalent; Keycloak's JWT Authorization Grant scopes the result via `scope` instead).
      ...(!isJwtBearer && { requestedTokenType: this.requestedTokenType }),
      ...(!isJwtBearer && this.exchangeAudiences.length > 0 && { audiences: this.exchangeAudiences }),
      ...(this.scopes.length > 0 && { scopes: this.scopes }),
      clientAuth: {
        clientId: this.clientId,
        method: 'ClientSecretPost',
        secretRef: { name: this.clientSecretName, key: this.clientSecretKey },
      },
      // The default subjectToken source reads the raw `Authorization` header --
      // but the companion JWT policy (traffic.jwtAuthentication, same request)
      // already validated it, REMOVES it from the header, and stashes it in a
      // request-extension `Claims` instead (agentgateway's http/jwt.rs). Left at
      // its default, the exchange finds no subject token and fails with a bare
      // "invalid request" (agentgateway's http/auth/oauth logs "oauth token
      // exchange subject token missing" at debug level -- confirmed live via the
      // admin /logging endpoint). Point it at the CEL binding CEL exposes for
      // exactly this case instead of the header.
      subjectToken: { source: { expression: 'jwt.rawToken.unredacted()' } },
    };
  }

  buildExchangePolicy(backendNames) {
    return {
      apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
      kind: 'EnterpriseAgentgatewayPolicy',
      metadata: {
        name: this.exchangePolicyName,
        namespace: this.backendDiscoveryNamespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentic-demo',
          'agentic.demo/feature': this.name,
        },
      },
      spec: {
        targetRefs: backendNames.map(name => ({
          group: 'enterpriseagentgateway.solo.io',
          kind: 'EnterpriseAgentgatewayBackend',
          name,
        })),
        backend: { auth: { oauthTokenExchange: this.oauthTokenExchangeSpec() } },
      },
    };
  }

  /**
   * Same oauthTokenExchange shape as buildExchangePolicy(), but for the A2A
   * EnterpriseAgentgatewayBackend objects created by the agentgateway-a2a-route
   * feature (Phase 4) -- a separate policy object because those Backends live
   * in this.namespace (agentgateway-proxy), not backendDiscoveryNamespace
   * (agentregistry-system), and Backend-kind targetRefs must live in the same
   * namespace as the policy that targets them. Names are known statically
   * (we create those Backends ourselves via a2aAgentNames, no agentregistry-style
   * hash-suffixed discovery needed) -- must match AgentgatewayA2ARouteFeature's
   * own `${agentName}-a2a` naming convention.
   */
  buildA2AExchangePolicy() {
    return {
      apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
      kind: 'EnterpriseAgentgatewayPolicy',
      metadata: {
        name: `${this.exchangePolicyName}-a2a`,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentic-demo',
          'agentic.demo/feature': this.name,
        },
      },
      spec: {
        targetRefs: this.a2aAgentNames.map(agentName => ({
          group: 'enterpriseagentgateway.solo.io',
          kind: 'EnterpriseAgentgatewayBackend',
          name: `${agentName}-a2a`,
        })),
        backend: { auth: { oauthTokenExchange: this.oauthTokenExchangeSpec() } },
      },
    };
  }

  /**
   * agentgateway doesn't negotiate TLS to a plain {name,namespace,port} backendRef on
   * its own -- confirmed live (a bare port-443 backendRef produced "connection closed
   * before message completed", i.e. it spoke plain HTTP to a TLS-only listener). The
   * standard Gateway API BackendTLSPolicy is what tells it to use TLS for this Service.
   * Keycloak's own TLS cert here happens to be publicly issued (Let's Encrypt, not
   * self-signed, confirmed via `openssl x509 -noout -issuer` against the live Secret),
   * so wellKnownCACertificates: System is enough -- no custom CA pinning needed.
   * Must live in the same namespace as its target Service per Gateway API policy
   * attachment rules (unlike EnterpriseAgentgatewayPolicy, no ReferenceGrant applies here).
   *
   * targetRefs has no port field, only sectionName -- WITHOUT it, the policy applies to
   * the whole keycloak Service, including the plain-HTTP port the JWT policy's JWKS fetch
   * still uses on keycloakPort/8080. That broke JWKS fetching entirely ("jwks keyset ...
   * isn't available (not yet fetched or fetch failed)" in the JWT policy's own status,
   * confirmed live) the moment this policy was added, even though nothing about the JWT
   * policy itself changed. sectionName scopes it to just the Service's 'https'-named port.
   */
  buildBackendTlsPolicy() {
    return {
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'BackendTLSPolicy',
      metadata: {
        name: `${this.policyName}-keycloak-exchange-tls`,
        namespace: this.keycloakNamespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentic-demo',
          'agentic.demo/feature': this.name,
        },
      },
      spec: {
        targetRefs: [
          { group: '', kind: 'Service', name: this.keycloakServiceName, sectionName: 'https' },
        ],
        validation: {
          hostname: this.keycloakIssuer.replace(/^https?:\/\//, '').split('/')[0],
          wellKnownCACertificates: 'System',
        },
      },
    };
  }

  buildReferenceGrant() {
    return {
      apiVersion: 'gateway.networking.k8s.io/v1beta1',
      kind: 'ReferenceGrant',
      metadata: {
        name: `${this.policyName}-to-keycloak`,
        namespace: this.keycloakNamespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentic-demo',
          'agentic.demo/feature': this.name,
        },
      },
      spec: {
        // Two policies in two different namespaces both need to reach Keycloak's
        // Service: the JWT policy (this.namespace, for JWKS) and the exchange policy
        // (backendDiscoveryNamespace, for the token endpoint).
        from: [
          {
            group: 'enterpriseagentgateway.solo.io',
            kind: 'EnterpriseAgentgatewayPolicy',
            namespace: this.namespace,
          },
          {
            group: 'enterpriseagentgateway.solo.io',
            kind: 'EnterpriseAgentgatewayPolicy',
            namespace: this.backendDiscoveryNamespace,
          },
        ],
        to: [{ group: '', kind: 'Service', name: this.keycloakServiceName }],
      },
    };
  }

  /**
   * clientAuth.secretRef on EnterpriseAgentgatewayPolicy resolves within the
   * policy's own namespace -- unlike the Service backendRefs this feature also
   * uses, there's no ReferenceGrant escape hatch for it (confirmed live: a
   * second copy of this Secret in agentgateway-proxy was required before
   * buildA2AExchangePolicy()'s policy there left its "secret ... not found"
   * PartiallyValid status -- until fixed, that policy silently never exchanged
   * anything, and every downstream A2A hop's outbound MCP calls got no
   * Authorization header at all). So the same Secret must be duplicated into
   * every namespace that has a policy referencing it: always
   * backendDiscoveryNamespace (buildExchangePolicy's namespace), plus
   * this.namespace too when buildA2AExchangePolicy() is in play.
   */
  buildClientSecret(namespace) {
    return {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: this.clientSecretName,
        namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentic-demo',
          'agentic.demo/feature': this.name,
        },
      },
      type: 'Opaque',
      stringData: { [this.clientSecretKey]: this.clientSecret },
    };
  }

  async deploy() {
    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];
    for (const context of contextsToDeploy) {
      await this.applyResource(this.buildClientSecret(this.backendDiscoveryNamespace), context);
      await this.applyResource(this.buildReferenceGrant(), context);
      await this.applyResource(this.buildBackendTlsPolicy(), context);
      await this.applyResource(this.buildJwtPolicy(), context);

      let backendNames;
      if (this.staticBackendNames) {
        backendNames = this.staticBackendNames;
      } else {
        backendNames = [];
        for (const serverName of this.mcpServerNames) {
          backendNames.push(await this.discoverBackendName(serverName, context));
        }
      }
      await this.applyResource(this.buildExchangePolicy(backendNames), context);
      this.log(
        `Token exchange policy '${this.exchangePolicyName}' applied, targeting ${backendNames.length} live Backend(s): ${backendNames.join(', ')}`,
        'success'
      );

      if (this.a2aAgentNames.length > 0) {
        if (this.namespace !== this.backendDiscoveryNamespace) {
          await this.applyResource(this.buildClientSecret(this.namespace), context);
        }
        await this.applyResource(this.buildA2AExchangePolicy(), context);
        this.log(
          `Token exchange policy '${this.exchangePolicyName}-a2a' applied, targeting ${this.a2aAgentNames.length} A2A Backend(s): ${this.a2aAgentNames.map(n => `${n}-a2a`).join(', ')}`,
          'success'
        );
      }
    }
    this.log(
      `JWT policy '${this.policyName}' applied, targeting HTTPRoute '${this.targetHTTPRoute}'`,
      'success'
    );
  }

  async cleanup() {
    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];
    for (const context of contextsToDeploy) {
      await this.deleteResource(
        'enterpriseagentgatewaypolicy',
        this.policyName,
        this.namespace,
        context
      );
      await this.deleteResource(
        'enterpriseagentgatewaypolicy',
        this.exchangePolicyName,
        this.backendDiscoveryNamespace,
        context
      );
      await this.deleteResource(
        'enterpriseagentgatewaypolicy',
        `${this.exchangePolicyName}-a2a`,
        this.namespace,
        context
      );
      await this.deleteResource(
        'referencegrant',
        `${this.policyName}-to-keycloak`,
        this.keycloakNamespace,
        context
      );
      await this.deleteResource(
        'backendtlspolicy',
        `${this.policyName}-keycloak-exchange-tls`,
        this.keycloakNamespace,
        context
      );
      await this.deleteResource(
        'secret',
        this.clientSecretName,
        this.backendDiscoveryNamespace,
        context
      );
      if (this.a2aAgentNames.length > 0 && this.namespace !== this.backendDiscoveryNamespace) {
        await this.deleteResource('secret', this.clientSecretName, this.namespace, context);
      }
    }
    this.log(
      `Token exchange policies '${this.policyName}'/'${this.exchangePolicyName}' removed`,
      'success'
    );
  }
}
