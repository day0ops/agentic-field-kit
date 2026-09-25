import { Feature } from '../../../src/lib/feature.js';
import { nlbSourceRangeAnnotations } from '../../../src/lib/common.js';

/**
 * OidcGatewayFeature
 *
 * Publicly exposes one existing Service behind its own dedicated Gateway, gated by
 * Keycloak login via agentgateway Enterprise's native OIDC ExtAuth mechanism
 * (spec.traffic.entExtAuth on an EnterpriseAgentgatewayPolicy, backed by the
 * already-deployed `ext-auth-service-enterprise-agentgateway` in agentgateway-system --
 * no custom auth service).
 *
 * Session storage uses `session.redis`, pointed at the already-deployed
 * `ext-cache-enterprise-agentgateway` Redis instance (agentgateway-system) -- NOT
 * `session.cookie`, despite that looking like the simpler, stateless choice on paper.
 * `session.cookie` validates fine and looks accepted, but on this cluster's deployed
 * ext-auth-service version it silently never sets a Set-Cookie header on the /callback
 * response, so the browser bounces straight back into another login redirect forever
 * (confirmed live: 0 Set-Cookie headers across 20+ requests in the loop). Switching to
 * `session.redis` with no other change immediately fixed it. Revisit `session.cookie`
 * only after confirming a newer ext-auth-service build actually persists it.
 *
 * The Gateway/HTTPRoute/Certificate/Policy this feature creates are all dedicated to
 * this one backend Service (a brand-new Gateway, not the shared hub-agentgateway-proxy),
 * so gating them has no effect on any other route. targetRefs still points at the
 * HTTPRoute specifically (not the Gateway) so the policy's blast radius stays scoped
 * to actual traffic even if more routes are ever attached to this Gateway later.
 *
 * AuthConfig field names/nesting (spec.configs[].oauth2.oidcAuthorizationCode.*) and
 * the EnterpriseAgentgatewayPolicy's traffic.entExtAuth shape were verified directly
 * against agentgateway-enterprise's own proto-generated Go types and e2e testdata --
 * there is no existing usage of either CRD elsewhere in this repo to copy from.
 *
 * Configuration:
 * {
 *   namespace: string,        // Required — where every resource this feature creates lives
 *                             // (must match the backend Service's namespace: HTTPRoute
 *                             // backendRefs don't cross namespaces without a ReferenceGrant,
 *                             // and entExtAuth's own backendRef defaults to the provisioned
 *                             // ext-auth-service with no ReferenceGrant needed regardless)
 *   hostname: string,         // Required — public hostname for the new Gateway's listener
 *   tlsIssuer: string,        // Default: 'letsencrypt-dns' (repo-wide ClusterIssuer)
 *   gatewayName: string,      // Required
 *   routeName: string,        // Required
 *   sourceRanges: string[],   // Optional — CIDR allowlist for the public NLB (e.g.
 *                             // env.security.vpnSourceRanges), same nlbSourceRangeAnnotations
 *                             // helper the shared hub-agentgateway-proxy Gateway uses. Also
 *                             // what actually pins the NLB scheme to internet-facing --
 *                             // without this feature wiring an EnterpriseAgentgatewayParameters
 *                             // object at all, AWS LBC's own default (internal) silently makes
 *                             // this Gateway's Service unreachable from outside the VPC
 *                             // regardless of source IP; confirmed live.
 *   backend: {                // Required — existing Service this route sends traffic to
 *     name: string,           // Required
 *     port: number,           // Required
 *   },
 *   ambientEnabled: boolean,  // Default: false — set when `namespace` has Ambient dataplane
 *                             // mode enabled. Applies the same `ambient.istio.io/
 *                             // bypass-inbound-capture` annotation the agentgateway addon
 *                             // already sets on its own Gateways (hub/spoke-agentgateway-proxy)
 *                             // when ambient -- without it, requests to this Gateway
 *                             // intermittently failed with "connection reset by peer" ~10s
 *                             // in (confirmed live against retail-returns-ui-https,
 *                             // 2026-09-12; root cause not fully isolated, but this
 *                             // annotation reliably fixed it, matching the addon's existing
 *                             // precedent for the same class of workload).
 *   authConfigName: string,   // Default: `${routeName}-oidc`
 *   policyName: string,       // Default: `${routeName}-oidc-gate`
 *   oidc: {
 *     clientId: string,       // Required — Keycloak client (confidential, authorization-code)
 *     clientSecret: string,   // Required — plaintext value; the feature creates the
 *                             // Kubernetes Secret itself (same pattern as
 *                             // features/agentic/token-exchange-policy)
 *     issuerUrl: string,      // Required — e.g. https://<keycloak>/realms/<realm>
 *     appUrl: string,         // Default: `https://${hostname}`
 *     callbackPath: string,   // Default: '/callback'
 *     scopes: string[],       // Default: ['openid', 'profile', 'email']
 *     redisHost: string,      // Default: the provisioned ext-cache-enterprise-agentgateway
 *                             // instance (agentgateway-system) -- override only if a
 *                             // different Redis should back this AuthConfig's sessions
 *     forwardAccessTokenHeader: string, // Optional — if set, ext-auth-service forwards the
 *                             // authenticated visitor's raw access token to the backend
 *                             // Service under this header name (no 'Bearer ' prefix), so
 *                             // the backend can read the already-established identity
 *                             // instead of running its own separate login
 *     logoutPath: string,     // Optional — if set, ext-auth-service intercepts requests to
 *                             // this path itself (never forwarded to the backend Service):
 *                             // it revokes the token, calls the issuer's end_session_endpoint
 *                             // server-side (killing the Keycloak SSO session, not just this
 *                             // gate's own), deletes the redis session, then redirects the
 *                             // browser to afterLogoutUrl. Omit to leave logout unsupported.
 *     afterLogoutUrl: string, // Optional — where ext-auth-service redirects the browser once
 *                             // logoutPath's flow completes. Defaults to appUrl if unset.
 *   },
 * }
 */
export class OidcGatewayFeature extends Feature {
  constructor(name, config = {}) {
    super(name, config);
    this.hostname = config.hostname;
    this.ambientEnabled = config.ambientEnabled === true;
    this.tlsIssuer = config.tlsIssuer || 'letsencrypt-dns';
    this.tlsSecretName = config.gatewayName ? `${config.gatewayName}-tls` : undefined;
    this.gatewayName = config.gatewayName;
    this.routeName = config.routeName;
    this.paramsName = config.gatewayName ? `${config.gatewayName}-params` : undefined;
    this.sourceRanges = config.sourceRanges || [];
    this.backend = config.backend || {};
    this.authConfigName = config.authConfigName || `${config.routeName}-oidc`;
    this.policyName = config.policyName || `${config.routeName}-oidc-gate`;
    this.clientSecretName = `${this.authConfigName}-client`;
    const oidc = config.oidc || {};
    this.clientId = oidc.clientId;
    this.clientSecret = oidc.clientSecret;
    this.issuerUrl = oidc.issuerUrl;
    this.appUrl = oidc.appUrl || (this.hostname ? `https://${this.hostname}` : undefined);
    this.callbackPath = oidc.callbackPath || '/callback';
    this.scopes = oidc.scopes || ['openid', 'profile', 'email'];
    // The Redis cache the enterprise-agentgateway chart already provisions for
    // ext-auth-service's own use (agentgateway-system namespace) -- reused here as the
    // OIDC session store rather than standing up a separate one.
    this.redisHost =
      oidc.redisHost ||
      'ext-cache-enterprise-agentgateway.agentgateway-system.svc.cluster.local:6379';
    this.forwardAccessTokenHeader = oidc.forwardAccessTokenHeader || null;
    this.logoutPath = oidc.logoutPath || null;
    this.afterLogoutUrl = oidc.afterLogoutUrl || null;
  }

  validate() {
    if (!this.namespace) throw new Error('oidc-gateway: namespace is required');
    if (!this.hostname) throw new Error('oidc-gateway: hostname is required');
    if (!this.gatewayName) throw new Error('oidc-gateway: gatewayName is required');
    if (!this.routeName) throw new Error('oidc-gateway: routeName is required');
    if (!this.backend.name) throw new Error('oidc-gateway: backend.name is required');
    if (!this.backend.port) throw new Error('oidc-gateway: backend.port is required');
    // config.oidc is optional -- omit it entirely for a plain public Gateway (correct
    // NLB annotations, TLS, no login gating) when the backend handles its own auth,
    // e.g. an app doing its own OIDC Authorization Code flow directly. Once any oidc.*
    // field is set, all three become required together (a half-configured ExtAuth gate
    // is worse than none).
    if (this.clientId || this.clientSecret || this.issuerUrl) {
      if (!this.clientId) throw new Error('oidc-gateway: oidc.clientId is required');
      if (!this.clientSecret) throw new Error('oidc-gateway: oidc.clientSecret is required');
      if (!this.issuerUrl) throw new Error('oidc-gateway: oidc.issuerUrl is required');
    }
    return true;
  }

  buildCertificate() {
    return {
      apiVersion: 'cert-manager.io/v1',
      kind: 'Certificate',
      metadata: {
        name: this.tlsSecretName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentic-demo',
          'agentic.demo/feature': this.name,
        },
      },
      spec: {
        secretName: this.tlsSecretName,
        issuerRef: { name: this.tlsIssuer, kind: 'ClusterIssuer' },
        dnsNames: [this.hostname],
      },
    };
  }

  buildGateway() {
    return {
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'Gateway',
      metadata: {
        name: this.gatewayName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentic-demo',
          'agentic.demo/feature': this.name,
        },
      },
      spec: {
        // enterprise-agentgateway, not istio -- entExtAuth (like every other
        // EnterpriseAgentgatewayPolicy traffic.* field) only takes effect on routes
        // served by an agentgateway-class Gateway (confirmed by precedent: kagent-ui-https
        // and agentregistry-ui-https, the only other UI-app public Gateways in this
        // cluster, both use this class; Grafana's own Gateway uses gatewayClassName:
        // istio and has no ExtAuth of any kind).
        gatewayClassName: 'enterprise-agentgateway',
        // Without this, AWS LBC's own default (internal) applies to the auto-generated
        // Service, making this Gateway unreachable from outside the VPC regardless of
        // source IP -- confirmed live. See buildGatewayParameters().
        infrastructure: {
          parametersRef: {
            name: this.paramsName,
            group: 'enterpriseagentgateway.solo.io',
            kind: 'EnterpriseAgentgatewayParameters',
          },
          // See the `ambientEnabled` doc comment above -- same annotation the
          // agentgateway addon sets on hub/spoke-agentgateway-proxy when ambient.
          ...(this.ambientEnabled && {
            annotations: { 'ambient.istio.io/bypass-inbound-capture': 'true' },
          }),
        },
        listeners: [
          {
            name: 'https',
            port: 443,
            protocol: 'HTTPS',
            hostname: this.hostname,
            tls: {
              mode: 'Terminate',
              certificateRefs: [{ name: this.tlsSecretName, kind: 'Secret' }],
            },
            allowedRoutes: { namespaces: { from: 'All' } },
          },
        ],
      },
    };
  }

  // Same mechanism the shared hub-agentgateway-proxy Gateway uses (addons/agentgateway):
  // AWS LBC annotations for a Gateway's auto-generated Service live on this CRD's
  // spec.service.metadata, not spec.infrastructure.annotations on the Gateway itself.
  buildGatewayParameters() {
    return {
      apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
      kind: 'EnterpriseAgentgatewayParameters',
      metadata: {
        name: this.paramsName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentic-demo',
          'agentic.demo/feature': this.name,
        },
      },
      spec: {
        service: {
          metadata: { annotations: nlbSourceRangeAnnotations(this.sourceRanges) },
        },
      },
    };
  }

  buildHttpRoute() {
    return {
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'HTTPRoute',
      metadata: {
        name: this.routeName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentic-demo',
          'agentic.demo/feature': this.name,
        },
      },
      spec: {
        parentRefs: [
          { group: 'gateway.networking.k8s.io', kind: 'Gateway', name: this.gatewayName },
        ],
        hostnames: [this.hostname],
        rules: [
          {
            backendRefs: [{ name: this.backend.name, port: this.backend.port }],
            matches: [{ path: { type: 'PathPrefix', value: '/' } }],
          },
        ],
      },
    };
  }

  buildClientSecret() {
    return {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: this.clientSecretName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentic-demo',
          'agentic.demo/feature': this.name,
        },
      },
      // extauth.solo.io/oauth is the well-known Secret type ext-auth-service reads a
      // client secret from (docs.solo.io/agentgateway/kubernetes/latest/security/
      // extauth/oauth/about/); the data key is the fixed 'client-secret', not
      // configurable via clientSecretRef (which only carries name/namespace).
      type: 'extauth.solo.io/oauth',
      stringData: { 'client-secret': this.clientSecret },
    };
  }

  buildAuthConfig() {
    return {
      apiVersion: 'extauth.solo.io/v1',
      kind: 'AuthConfig',
      metadata: {
        name: this.authConfigName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentic-demo',
          'agentic.demo/feature': this.name,
        },
      },
      spec: {
        configs: [
          {
            oauth2: {
              oidcAuthorizationCode: {
                clientId: this.clientId,
                // Deprecated field name, used here over the newer nested
                // clientAuthentication.clientSecret.clientSecretRef -- the latter was
                // rejected live ("missing or incomplete required secret reference") by
                // this cluster's deployed ext-auth-service version, which apparently
                // doesn't recognize clientAuthentication yet.
                clientSecretRef: { name: this.clientSecretName, namespace: this.namespace },
                issuerUrl: this.issuerUrl,
                appUrl: this.appUrl,
                callbackPath: this.callbackPath,
                scopes: this.scopes,
                // See the class doc comment -- session.cookie silently drops the session
                // on this cluster's ext-auth-service build; redis is what actually works.
                // allowRefreshing defaults to false (ext-auth-service discards the
                // refresh_token at callback time unless this is set), which otherwise
                // forces a full re-login on every access-token expiry -- 5 minutes on
                // this realm's stock Keycloak accessTokenLifespan.
                session: { redis: { options: { host: this.redisHost }, allowRefreshing: true } },
                ...(this.forwardAccessTokenHeader && {
                  headers: { accessTokenHeader: this.forwardAccessTokenHeader },
                }),
                ...(this.logoutPath && { logoutPath: this.logoutPath }),
                ...(this.afterLogoutUrl && { afterLogoutUrl: this.afterLogoutUrl }),
              },
            },
          },
        ],
      },
    };
  }

  buildExtAuthPolicy() {
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
        targetRefs: [
          { group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', name: this.routeName },
        ],
        traffic: {
          // backendRef intentionally omitted -- defaults to the provisioned
          // ext-auth-service-enterprise-agentgateway (agentgateway-system), and per its
          // own CRD doc comment, no ReferenceGrant is required for that default path.
          entExtAuth: { authConfigRef: { name: this.authConfigName } },
        },
      },
    };
  }

  async deploy() {
    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];
    for (const context of contextsToDeploy) {
      await this.applyResource(this.buildCertificate(), context);
      await this.applyResource(this.buildGatewayParameters(), context);
      await this.applyResource(this.buildGateway(), context);
      await this.applyResource(this.buildHttpRoute(), context);
      if (this.clientId) {
        await this.applyResource(this.buildClientSecret(), context);
        await this.applyResource(this.buildAuthConfig(), context);
        await this.applyResource(this.buildExtAuthPolicy(), context);
      }
    }
    if (this.clientId) {
      this.log(
        `OIDC gate '${this.policyName}' applied: https://${this.hostname} -> ${this.backend.name}:${this.backend.port}, login required via ${this.issuerUrl}`,
        'success'
      );
    } else {
      this.log(
        `Public gateway applied: https://${this.hostname} -> ${this.backend.name}:${this.backend.port}, no login gate (backend handles its own auth)`,
        'success'
      );
    }
  }

  async cleanup() {
    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];
    for (const context of contextsToDeploy) {
      if (this.clientId) {
        await this.deleteResource(
          'enterpriseagentgatewaypolicy',
          this.policyName,
          this.namespace,
          context
        );
        await this.deleteResource('authconfig', this.authConfigName, this.namespace, context);
        await this.deleteResource('secret', this.clientSecretName, this.namespace, context);
      }
      await this.deleteResource('httproute', this.routeName, this.namespace, context);
      await this.deleteResource('gateway', this.gatewayName, this.namespace, context);
      await this.deleteResource(
        'enterpriseagentgatewayparameters',
        this.paramsName,
        this.namespace,
        context
      );
      await this.deleteResource('certificate', this.tlsSecretName, this.namespace, context);
    }
    this.log(`Gateway '${this.gatewayName}' removed`, 'success');
  }
}
