import { Feature } from '../../../src/lib/feature.js';

/**
 * AgoraConsoleFeature
 *
 * Deploys agora-demo's two Go binaries - catalog-api (internal, owns all
 * marketplace domain data) and console (public, the buyer/seller/operator
 * web UI) - as plain Deployments/Services, with the console exposed via
 * cert-manager + Gateway API, matching the live kagent-ui/fraud-ops-console
 * exposure pattern (gatewayClassName: enterprise-agentgateway, ClusterIssuer:
 * letsencrypt-dns).
 *
 * Visitor chat calls kagent Agents over A2A through agentgateway as the
 * logged-in visitor's own forwarded token (see oidc-gateway/substrate-a2a-
 * route/token-exchange-policy/kagent-rbac-policy in the usecase spec) - no
 * service-account identity needed for that path.
 *
 * Two optional, independently-opt-in capabilities add a ServiceAccount/RBAC
 * and/or a Keycloak client-credentials identity when configured (presence
 * triggers wiring, same convention as agentGatewayBaseUrl below - omitting
 * both preserves this feature's original "no SA/RBAC at all" behavior):
 * - `ateApiEndpoint` set: Operator Studio's "Agent Substrate" panel gets real
 *   actor/worker-pool status (console/source.go shells out to kubectl-ate,
 *   mirroring fraud-ops-console's own proven RBAC shape - a ServiceAccount in
 *   this feature's namespace, plus a cross-namespace Role/RoleBinding in
 *   ateNamespace granting serviceaccounts/token:create on ate-client).
 * - `systemKeycloak` set: Operator Studio's isolation-check probe gets a real
 *   client-credentials identity to call trust-safety/auto-bidder directly
 *   in-cluster (never through the public agentgateway route those sub-agents
 *   are deliberately never exposed on - see console/isolation_probe.go).
 *   Needs no K8s RBAC of its own, only the Keycloak client (config/profiles
 *   realm config) and a kagent-rbac-policy grant for its group.
 *
 * Deliberately a Feature, not an `extras/applications` entry, for the same
 * reason fraud-ops-console is: `requires.applications`' whole-namespace-delete
 * semantics on `usecase clean` would risk deleting more than this feature's
 * own resources unless the namespace happens to be in
 * UseCaseManager's PROTECTED_NAMESPACES.
 *
 * CATALOG_API_URL is hardcoded to catalog-api's in-cluster Service DNS name -
 * the established convention confirmed across every existing multi-service
 * demo in this repo (e.g. sre-incident-response-system's AGENT_URL,
 * retail-returns-agent-system's STAGE_POLICY_CONTROLLER_URL) - there is no
 * service-discovery abstraction layer to go through instead.
 *
 * Configuration:
 * {
 *   namespace: string,         // Default: 'agora-demo'
 *   catalogApiImage: string,   // Required
 *   consoleImage: string,      // Required
 *   hostname: string,          // Required -- public hostname for the console
 *   clusterIssuer: string,     // Default: 'letsencrypt-dns'
 *   gatewayClassName: string,  // Default: 'enterprise-agentgateway'
 *   sourceRanges: string[],    // Optional -- CIDR allowlist applied to the Gateway's
 *                              // LoadBalancer Service via an EnterpriseAgentgatewayParameters
 *                              // object. Omit to leave the LoadBalancer open to the internet.
 *   catalogApiPort: number,    // Default: 18080
 *   consolePort: number,       // Default: 18090
 *   exposeDirectly: boolean,   // Default: true. Set false when a separate oidc-gateway
 *                              // feature step owns this hostname's Gateway/Certificate/
 *                              // HTTPRoute instead (e.g. to gate the whole app behind
 *                              // Keycloak login) - two Gateway objects cannot both claim
 *                              // the same hostname.
 *   agentGatewayBaseUrl: string, // Optional -- base URL the console calls out to for
 *                              // A2A agent invocation (console/agent_invoker.go's
 *                              // AGENTGATEWAY_BASE_URL). Omit to leave chat on the stub
 *                              // invoker. Must be this feature's own public hostname+scheme
 *                              // (the usecase's substrate-a2a-route shares that Gateway/
 *                              // hostname -- a different hostname or an in-cluster Service
 *                              // DNS name won't match the A2A HTTPRoute's hostname match)
 *                              // PLUS kagent-controller's own path-mux prefix,
 *                              // /agents/<namespace the agents run in> -- agent_invoker.go
 *                              // appends only `/<agentName>` to this value, so a bare
 *                              // hostname with no /agents/<namespace> suffix makes every
 *                              // call fall through to this feature's own catch-all route
 *                              // instead of reaching the agent (confirmed live: it returns
 *                              // this console's own SPA shell with a 200, not an error).
 *   gatedPaths: string[],      // Default: ['/account'] -- extra PathPrefix matches added to
 *                              // the 'gated' HTTPRoute rule oidc-gateway targets via
 *                              // sectionName. Gateway API's matches field is a list, so
 *                              // adding a path here (e.g. '/shop') extends the OIDC login
 *                              // gate's coverage with no change needed in oidc-gateway
 *                              // itself - it stays scoped to this one named rule regardless
 *                              // of how many paths match it. '/account' is always included
 *                              // even if omitted here: every account handler already assumes
 *                              // oidc-gateway reaches it (see account_handlers.go).
 *   ateApiEndpoint: string,    // Optional -- presence enables real Operator Studio substrate
 *                              // status (ServiceAccount/RBAC, serviceAccountName, ATE_* env).
 *                              // Omit to leave Operator Studio's Agent Substrate panel on its
 *                              // honest-empty state.
 *   ateNamespace: string,      // Default: 'ate-system' -- where the ate-client token-request
 *                              // RBAC is granted (only relevant when ateApiEndpoint is set)
 *   agentNamespace: string,    // Default: 'kagent-system' -- the kagent namespace the agents/
 *                              // WorkerPool/atespace actually live in. NOT this feature's own
 *                              // `namespace` (where the console itself is deployed) -- the two
 *                              // are different concepts that only happen to coincide in
 *                              // agora-demo-local today (final review finding #4). Drives both
 *                              // AGORA_ATESPACE (deliberately not ATE_NAMESPACE -- kubectl-ate
 *                              // itself reads ATE_NAMESPACE from its own process environment as
 *                              // its control-plane target; reusing that name here would silently
 *                              // redirect kubectl-ate away from the real ate-system control
 *                              // plane) and kagentControllerBaseUrl's default below.
 *   workerPoolName: string,    // Default: 'agora-workers' -- only relevant when ateApiEndpoint
 *                              // is set
 *   systemKeycloak: {          // Optional -- presence enables the Operator Studio isolation-
 *                              // check probe's client-credentials identity. Omit to leave the
 *                              // probe unconfigured (returns 501).
 *     hostname: string,         // Required (within this block) -- Keycloak's PUBLIC hostname,
 *                              // never an internal Service DNS name (same rule as every other
 *                              // OIDC client in this repo - kagent-controller validates a
 *                              // token's iss claim against its own configured public issuer).
 *     realm: string,            // Default: 'kagent'
 *     clientId: string,         // Required (within this block)
 *     clientSecret: string,     // Required (within this block)
 *   },
 *   kagentControllerBaseUrl: string, // Optional -- the in-cluster URL the isolation probe
 *                              // calls (never the public agentgateway-routed one trust-safety/
 *                              // auto-bidder are deliberately never exposed on). Default:
 *                              // http://kagent-controller.<agentNamespace>.svc.cluster.local:8083/agents/<agentNamespace>
 * }
 */
export class AgoraConsoleFeature extends Feature {
  constructor(name, config = {}) {
    super(name, config);
    this.namespace = config.namespace || 'agora-demo';
    this.catalogApiImage = config.catalogApiImage;
    this.consoleImage = config.consoleImage;
    this.hostname = config.hostname;
    this.clusterIssuer = config.clusterIssuer || 'letsencrypt-dns';
    this.gatewayClassName = config.gatewayClassName || 'enterprise-agentgateway';
    // Profile YAML may mix a whole-list template token (resolves to an array) with
    // individual CIDR tokens in the same list -- .flat() collapses that one level so this
    // is always a flat string[], never a jagged array (the Gateway controller rejects a
    // nested array for the native k8s loadBalancerSourceRanges field; confirmed live).
    this.sourceRanges = Array.isArray(config.sourceRanges)
      ? config.sourceRanges.flat().filter(Boolean)
      : config.sourceRanges || null;
    this.catalogApiPort = config.catalogApiPort || 18080;
    this.consolePort = config.consolePort || 18090;
    this.exposeDirectly = config.exposeDirectly !== false;
    this.agentGatewayBaseUrl = config.agentGatewayBaseUrl || null;
    const extraGatedPaths = (config.gatedPaths || []).filter(p => p !== '/account');
    this.gatedPaths = ['/account', ...extraGatedPaths];

    this.ateApiEndpoint = config.ateApiEndpoint || null;
    this.ateNamespace = config.ateNamespace || 'ate-system';
    // The agents' own namespace -- a different concept from this.namespace
    // (where the console itself is deployed); only coincidentally the same
    // value in agora-demo-local today.
    this.agentNamespace = config.agentNamespace || 'kagent-system';
    this.workerPoolName = config.workerPoolName || 'agora-workers';

    this.systemKeycloak = config.systemKeycloak || null;
    this.systemKeycloakSecretName = 'agora-console-system-keycloak';
    this.kagentControllerBaseUrl =
      config.kagentControllerBaseUrl ||
      `http://kagent-controller.${this.agentNamespace}.svc.cluster.local:8083/agents/${this.agentNamespace}`;
  }

  getFeaturePath() {
    return 'agentic/agora-console';
  }

  validate() {
    if (!this.catalogApiImage) throw new Error('agora-console: catalogApiImage is required');
    if (!this.consoleImage) throw new Error('agora-console: consoleImage is required');
    if (!this.hostname) throw new Error('agora-console: hostname is required');
    if (this.systemKeycloak) {
      if (!this.systemKeycloak.hostname)
        throw new Error('agora-console: systemKeycloak.hostname is required');
      if (!this.systemKeycloak.clientId)
        throw new Error('agora-console: systemKeycloak.clientId is required');
      if (!this.systemKeycloak.clientSecret)
        throw new Error('agora-console: systemKeycloak.clientSecret is required');
    }
    return true;
  }

  get systemKeycloakTokenUrl() {
    const realm = this.systemKeycloak.realm || 'kagent';
    return `https://${this.systemKeycloak.hostname}/realms/${realm}/protocol/openid-connect/token`;
  }

  // buildServiceAccount/buildRole/buildRoleBinding/buildAteTokenRole/
  // buildAteTokenRoleBinding mirror fraud-ops-console's own RBAC methods of
  // the same shape - only applied by deploy() when ateApiEndpoint is set
  // (see the class doc comment).
  buildServiceAccount() {
    return {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: { name: 'agora-console', namespace: this.namespace },
    };
  }

  buildRole() {
    return {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'Role',
      metadata: { name: 'agora-console', namespace: this.namespace },
      rules: [
        {
          apiGroups: ['kagent.dev', 'ate.dev'],
          resources: ['agenttemplates', 'harnesses', 'workerpools'],
          verbs: ['get', 'list', 'watch'],
        },
      ],
    };
  }

  buildRoleBinding() {
    return {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: { name: 'agora-console', namespace: this.namespace },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'agora-console' },
      subjects: [{ kind: 'ServiceAccount', name: 'agora-console', namespace: this.namespace }],
    };
  }

  // buildAteTokenRole/buildAteTokenRoleBinding grant this feature's own
  // ServiceAccount permission to request a token for `ate-client` -- the
  // identity kubectl-ate actually authenticates to ate-api as. Placed in
  // ateNamespace, not this.namespace.
  //
  // This grants whatever `ate-client` itself is authorized for on ate-api,
  // not narrowly "read-only actor/worker listing" -- the same characteristic
  // the sibling fraud-ops-console feature already accepts (it mints an
  // identically-scoped token). A public-facing console minting this token
  // should be understood to carry `ate-client`'s full authorization, not a
  // custom read-only grant -- flagged during final review, worth
  // re-confirming `ate-client`'s own ate-api authorization scope before this
  // feature is deployed anywhere with a lower trust bar than this demo.
  buildAteTokenRole() {
    return {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'Role',
      metadata: { name: 'agora-console-ate-token', namespace: this.ateNamespace },
      rules: [
        {
          apiGroups: [''],
          resources: ['serviceaccounts/token'],
          resourceNames: ['ate-client'],
          verbs: ['create'],
        },
      ],
    };
  }

  buildAteTokenRoleBinding() {
    return {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: { name: 'agora-console-ate-token', namespace: this.ateNamespace },
      roleRef: {
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'Role',
        name: 'agora-console-ate-token',
      },
      subjects: [{ kind: 'ServiceAccount', name: 'agora-console', namespace: this.namespace }],
    };
  }

  buildCatalogApiDeployment() {
    return {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: 'catalog-api',
        namespace: this.namespace,
        labels: { app: 'catalog-api', 'app.kubernetes.io/managed-by': 'agentic-demo' },
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: 'catalog-api' } },
        template: {
          metadata: { labels: { app: 'catalog-api' } },
          spec: {
            containers: [
              {
                name: 'catalog-api',
                image: this.catalogApiImage,
                ports: [{ containerPort: this.catalogApiPort }],
                env: [{ name: 'PORT', value: String(this.catalogApiPort) }],
                readinessProbe: {
                  tcpSocket: { port: this.catalogApiPort },
                  initialDelaySeconds: 5,
                  periodSeconds: 10,
                },
              },
            ],
          },
        },
      },
    };
  }

  buildCatalogApiService() {
    return {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'catalog-api', namespace: this.namespace },
      spec: {
        selector: { app: 'catalog-api' },
        ports: [{ name: 'http', port: this.catalogApiPort, targetPort: this.catalogApiPort }],
      },
    };
  }

  buildSystemKeycloakSecret() {
    return {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: this.systemKeycloakSecretName, namespace: this.namespace },
      type: 'Opaque',
      stringData: { 'client-secret': this.systemKeycloak.clientSecret },
    };
  }

  buildConsoleDeployment() {
    return {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: 'console',
        namespace: this.namespace,
        labels: { app: 'console', 'app.kubernetes.io/managed-by': 'agentic-demo' },
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: 'console' } },
        template: {
          metadata: { labels: { app: 'console' } },
          spec: {
            ...(this.ateApiEndpoint ? { serviceAccountName: 'agora-console' } : {}),
            containers: [
              {
                name: 'console',
                image: this.consoleImage,
                ports: [{ containerPort: this.consolePort }],
                env: [
                  { name: 'PORT', value: String(this.consolePort) },
                  {
                    name: 'CATALOG_API_URL',
                    value: `http://catalog-api.${this.namespace}.svc.cluster.local:${this.catalogApiPort}`,
                  },
                  ...(this.agentGatewayBaseUrl
                    ? [{ name: 'AGENTGATEWAY_BASE_URL', value: this.agentGatewayBaseUrl }]
                    : []),
                  ...(this.ateApiEndpoint
                    ? [
                        { name: 'ATE_API_ENDPOINT', value: this.ateApiEndpoint },
                        { name: 'AGORA_ATESPACE', value: this.agentNamespace },
                        { name: 'ATE_WORKER_POOL_NAME', value: this.workerPoolName },
                      ]
                    : []),
                  ...(this.systemKeycloak
                    ? [
                        { name: 'AGORA_SYSTEM_OIDC_TOKEN_URL', value: this.systemKeycloakTokenUrl },
                        {
                          name: 'AGORA_SYSTEM_OIDC_CLIENT_ID',
                          value: this.systemKeycloak.clientId,
                        },
                        {
                          name: 'AGORA_SYSTEM_OIDC_CLIENT_SECRET',
                          valueFrom: {
                            secretKeyRef: {
                              name: this.systemKeycloakSecretName,
                              key: 'client-secret',
                            },
                          },
                        },
                        { name: 'KAGENT_PROBE_BASE_URL', value: this.kagentControllerBaseUrl },
                      ]
                    : []),
                ],
                readinessProbe: {
                  tcpSocket: { port: this.consolePort },
                  initialDelaySeconds: 5,
                  periodSeconds: 10,
                },
              },
            ],
          },
        },
      },
    };
  }

  buildConsoleService() {
    return {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'console', namespace: this.namespace },
      spec: {
        selector: { app: 'console' },
        ports: [{ name: 'http', port: this.consolePort, targetPort: this.consolePort }],
      },
    };
  }

  buildCertificate() {
    return {
      apiVersion: 'cert-manager.io/v1',
      kind: 'Certificate',
      metadata: { name: 'agora-console-tls', namespace: this.namespace },
      spec: {
        secretName: 'agora-console-tls',
        issuerRef: { name: this.clusterIssuer, kind: 'ClusterIssuer' },
        dnsNames: [this.hostname],
      },
    };
  }

  // buildGatewayParameters returns an EnterpriseAgentgatewayParameters object
  // restricting the Gateway's LoadBalancer Service to sourceRanges, or
  // undefined when sourceRanges isn't set (leaves the LB open). Same pattern
  // as fraud-ops-console's buildGatewayParameters().
  buildGatewayParameters() {
    if (!this.sourceRanges) return undefined;
    return {
      apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
      kind: 'EnterpriseAgentgatewayParameters',
      metadata: { name: 'agora-console-https-params', namespace: this.namespace },
      spec: { service: { spec: { loadBalancerSourceRanges: this.sourceRanges } } },
    };
  }

  buildGateway() {
    const spec = {
      gatewayClassName: this.gatewayClassName,
      listeners: [
        {
          name: 'https',
          port: 443,
          protocol: 'HTTPS',
          hostname: this.hostname,
          tls: {
            mode: 'Terminate',
            certificateRefs: [{ kind: 'Secret', name: 'agora-console-tls' }],
          },
          allowedRoutes: { namespaces: { from: 'Same' } },
        },
      ],
    };
    if (this.sourceRanges) {
      spec.infrastructure = {
        parametersRef: {
          name: 'agora-console-https-params',
          group: 'enterpriseagentgateway.solo.io',
          kind: 'EnterpriseAgentgatewayParameters',
        },
      };
    }
    return {
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'Gateway',
      metadata: { name: 'agora-console-https', namespace: this.namespace },
      spec,
    };
  }

  // Two named rules sharing one backend: 'gated' (PathPrefix: /account, plus
  // any extra gatedPaths) lets oidc-gateway (in attach-only mode) target just
  // that rule via sectionName, so login is required for those paths without
  // splitting the console across a second hostname/Gateway. Gateway API's
  // longest-prefix-match means 'gated' wins for anything under one of its
  // own prefixes regardless of rule order.
  buildHTTPRoute() {
    const backendRefs = [{ group: '', kind: 'Service', name: 'console', port: this.consolePort }];
    return {
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'HTTPRoute',
      metadata: { name: 'agora-console', namespace: this.namespace },
      spec: {
        parentRefs: [
          {
            group: 'gateway.networking.k8s.io',
            kind: 'Gateway',
            name: 'agora-console-https',
            namespace: this.namespace,
          },
        ],
        hostnames: [this.hostname],
        rules: [
          { name: 'public', matches: [{ path: { type: 'PathPrefix', value: '/' } }], backendRefs },
          {
            name: 'gated',
            matches: this.gatedPaths.map(path => ({ path: { type: 'PathPrefix', value: path } })),
            backendRefs,
          },
        ],
      },
    };
  }

  async deploy() {
    if (this.ateApiEndpoint) {
      await this.applyResource(this.buildServiceAccount());
      await this.applyResource(this.buildRole());
      await this.applyResource(this.buildRoleBinding());
      await this.applyResource(this.buildAteTokenRole());
      await this.applyResource(this.buildAteTokenRoleBinding());
    }
    if (this.systemKeycloak) {
      await this.applyResource(this.buildSystemKeycloakSecret());
    }
    await this.applyResource(this.buildCatalogApiDeployment());
    await this.applyResource(this.buildCatalogApiService());
    await this.applyResource(this.buildConsoleDeployment());
    await this.applyResource(this.buildConsoleService());
    if (this.exposeDirectly) {
      await this.applyResource(this.buildCertificate());
      const gatewayParams = this.buildGatewayParameters();
      if (gatewayParams) await this.applyResource(gatewayParams);
      await this.applyResource(this.buildGateway());
      await this.applyResource(this.buildHTTPRoute());
    }
    this.log(
      `agora-console deployed at https://${this.hostname} in '${this.namespace}'`,
      'success'
    );
  }

  async cleanup() {
    if (this.exposeDirectly) {
      await this.deleteResource('httproute', 'agora-console', this.namespace);
      await this.deleteResource('gateway', 'agora-console-https', this.namespace);
      await this.deleteResource(
        'enterpriseagentgatewayparameters',
        'agora-console-https-params',
        this.namespace
      );
      await this.deleteResource('certificate', 'agora-console-tls', this.namespace);
    }
    await this.deleteResource('service', 'console', this.namespace);
    await this.deleteResource('deployment', 'console', this.namespace);
    await this.deleteResource('service', 'catalog-api', this.namespace);
    await this.deleteResource('deployment', 'catalog-api', this.namespace);
    if (this.systemKeycloak) {
      await this.deleteResource('secret', this.systemKeycloakSecretName, this.namespace);
    }
    if (this.ateApiEndpoint) {
      await this.deleteResource('rolebinding', 'agora-console-ate-token', this.ateNamespace);
      await this.deleteResource('role', 'agora-console-ate-token', this.ateNamespace);
      await this.deleteResource('rolebinding', 'agora-console', this.namespace);
      await this.deleteResource('role', 'agora-console', this.namespace);
      await this.deleteResource('serviceaccount', 'agora-console', this.namespace);
    }
    this.log('agora-console cleaned up', 'success');
  }
}
