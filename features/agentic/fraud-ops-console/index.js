import { Feature } from '../../../src/lib/feature.js';

/**
 * FraudOpsConsoleFeature
 *
 * Deploys the Fraud Ops Console (Go backend + embedded Vite SPA) as a plain
 * Deployment/Service, exposed via cert-manager + Gateway API, matching the
 * live kagent-ui exposure pattern (gatewayClassName: enterprise-agentgateway,
 * ClusterIssuer: letsencrypt-dns).
 *
 * Deliberately a Feature, not an `extras/applications` entry: `requires.applications`
 * with an explicit `namespace: kagent` would register that namespace for
 * whole-namespace deletion on `usecase clean` (deployApplication/cleanup's
 * namespacesToDelete path) unless the namespace is in UseCaseManager's
 * PROTECTED_NAMESPACES -- which `kagent` (this profile's addon namespace,
 * distinct from `kagent-system`) is not. A Feature's cleanup() only ever
 * deletes its own named resources, never the namespace, avoiding that risk
 * entirely. Assumes the kagent addon already created and owns `namespace`,
 * matching kagent-mcp-server and substrate-agent.
 *
 * RBAC: live-confirmed (2026-09-28) that `kubectl-ate` authenticates to
 * ate-api by requesting a TokenRequest for the `ate-client` ServiceAccount in
 * `ate-system` -- not a self-token for whatever SA the pod runs as. A fresh
 * ServiceAccount with no grant gets `serviceaccounts "ate-client" is
 * forbidden`. This feature grants exactly that: a Role scoped to
 * `resourceNames: [ate-client]` placed in `ateNamespace` (cross-namespace,
 * since this feature's own ServiceAccount lives in `namespace`), bound via a
 * RoleBinding also in `ateNamespace`.
 *
 * Configuration:
 * {
 *   namespace: string,        // Default: 'kagent'
 *   ateNamespace: string,     // Default: 'ate-system' -- where the ate-client token-request RBAC is granted
 *   image: string,            // Required -- fraud-ops-console container image
 *   hostname: string,         // Required -- public hostname for the Gateway/Certificate/HTTPRoute
 *   clusterIssuer: string,    // Default: 'letsencrypt-dns'
 *   gatewayClassName: string, // Default: 'enterprise-agentgateway'
 *   sourceRanges: string[],  // Optional -- CIDR allowlist applied to the Gateway's LoadBalancer
 *                            // Service (spec.loadBalancerSourceRanges) via an
 *                            // EnterpriseAgentgatewayParameters object. Omit to leave the
 *                            // LoadBalancer open to the internet.
 *   ateApiEndpoint: string,   // Default: 'api.ate-system.svc.cluster.local:443'
 *   workerPoolName: string,   // Default: 'fraud-workers' -- the console counts only this pool's workers, since `get workers -n <namespace>` returns every pool sharing that namespace (e.g. kagent-default too)
 *   clickhouseDsn: string,    // Required -- ClickHouse DSN for the span source
 *   harnessName: string,          // Default: 'fraud-swarm' -- Harness the lead investigator's AgentTemplate is bound to
 *   agentTemplateName: string,    // Default: 'fraud-lead-investigator'
 *   kagentGrpcTarget: string,     // Default: 'kagent-controller.<namespace>.svc.cluster.local:8083'
 *   keycloak: {                   // Required -- client-credentials token for kagent's OIDC-protected gRPC API
 *     hostname: string,            // Required -- Keycloak's PUBLIC hostname, not an internal Service DNS
 *                                  // name: kagent-enterprise validates the token's `iss` claim against
 *                                  // its own configured public issuer (https://<hostname>/realms/<realm>),
 *                                  // and Keycloak stamps `iss` from the hostname/scheme/port the token
 *                                  // request actually came in on -- live-confirmed (2026-10-02) that a
 *                                  // token fetched via the internal keycloak.<ns>.svc:8080 Service gets
 *                                  // an `iss` that can never match, failing with Unauthenticated.
 *     tlsEnabled: boolean,         // Default: true
 *     realm: string,               // Default: 'kagent'
 *     clientId: string,            // Required -- confidential client with service accounts enabled (see the keycloak addon's 'kagent' realm config)
 *     clientSecret: string,        // Required
 *   },
 *   port: number,             // Default: 8090
 * }
 */
export class FraudOpsConsoleFeature extends Feature {
  constructor(name, config = {}) {
    super(name, config);
    this.ateNamespace = config.ateNamespace || 'ate-system';
    this.image = config.image;
    this.hostname = config.hostname;
    this.clusterIssuer = config.clusterIssuer || 'letsencrypt-dns';
    this.gatewayClassName = config.gatewayClassName || 'enterprise-agentgateway';
    this.sourceRanges = config.sourceRanges || null;
    this.ateApiEndpoint = config.ateApiEndpoint || 'api.ate-system.svc.cluster.local:443';
    this.workerPoolName = config.workerPoolName || 'fraud-workers';
    this.clickhouseDsn = config.clickhouseDsn;
    this.harnessName = config.harnessName || 'fraud-swarm';
    this.agentTemplateName = config.agentTemplateName || 'fraud-lead-investigator';
    this.kagentGrpcTarget =
      config.kagentGrpcTarget || `kagent-controller.${this.namespace}.svc.cluster.local:8083`;
    this.keycloak = config.keycloak || {};
    this.keycloakTlsEnabled = this.keycloak.tlsEnabled !== false;
    this.keycloakRealm = this.keycloak.realm || 'kagent';
    this.port = config.port || 8090;
  }

  getFeaturePath() {
    return 'agentic/fraud-ops-console';
  }

  validate() {
    if (!this.image) throw new Error('fraud-ops-console: image is required');
    if (!this.hostname) throw new Error('fraud-ops-console: hostname is required');
    if (!this.clickhouseDsn) throw new Error('fraud-ops-console: clickhouseDsn is required');
    if (!this.keycloak.hostname) throw new Error('fraud-ops-console: keycloak.hostname is required');
    if (!this.keycloak.clientId) throw new Error('fraud-ops-console: keycloak.clientId is required');
    if (!this.keycloak.clientSecret) throw new Error('fraud-ops-console: keycloak.clientSecret is required');
    return true;
  }

  get keycloakTokenUrl() {
    const scheme = this.keycloakTlsEnabled ? 'https' : 'http';
    return `${scheme}://${this.keycloak.hostname}/realms/${this.keycloakRealm}/protocol/openid-connect/token`;
  }

  buildServiceAccount() {
    return {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: { name: 'fraud-ops-console', namespace: this.namespace },
    };
  }

  buildRole() {
    return {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'Role',
      metadata: { name: 'fraud-ops-console', namespace: this.namespace },
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
      metadata: { name: 'fraud-ops-console', namespace: this.namespace },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'fraud-ops-console' },
      subjects: [{ kind: 'ServiceAccount', name: 'fraud-ops-console', namespace: this.namespace }],
    };
  }

  // buildAteTokenRole/buildAteTokenRoleBinding grant this feature's own
  // ServiceAccount permission to request a token for `ate-client` -- the
  // identity kubectl-ate actually authenticates to ate-api as (see the class
  // doc comment). Placed in ateNamespace, not this.namespace.
  buildAteTokenRole() {
    return {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'Role',
      metadata: { name: 'fraud-ops-console-ate-token', namespace: this.ateNamespace },
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
      metadata: { name: 'fraud-ops-console-ate-token', namespace: this.ateNamespace },
      roleRef: {
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'Role',
        name: 'fraud-ops-console-ate-token',
      },
      subjects: [{ kind: 'ServiceAccount', name: 'fraud-ops-console', namespace: this.namespace }],
    };
  }

  buildDeployment() {
    return {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: 'fraud-ops-console',
        namespace: this.namespace,
        labels: { app: 'fraud-ops-console', 'app.kubernetes.io/managed-by': 'agentic-demo' },
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: 'fraud-ops-console' } },
        template: {
          metadata: { labels: { app: 'fraud-ops-console' } },
          spec: {
            serviceAccountName: 'fraud-ops-console',
            containers: [
              {
                name: 'console',
                image: this.image,
                ports: [{ containerPort: this.port }],
                env: [
                  { name: 'PORT', value: String(this.port) },
                  { name: 'ATE_API_ENDPOINT', value: this.ateApiEndpoint },
                  { name: 'ATE_NAMESPACE', value: this.namespace },
                  { name: 'WORKER_POOL_NAME', value: this.workerPoolName },
                  { name: 'CLICKHOUSE_DSN', value: this.clickhouseDsn },
                  { name: 'KAGENT_GRPC_TARGET', value: this.kagentGrpcTarget },
                  { name: 'FRAUD_SWARM_HARNESS', value: this.harnessName },
                  { name: 'FRAUD_LEAD_AGENT_TEMPLATE', value: this.agentTemplateName },
                  { name: 'KEYCLOAK_TOKEN_URL', value: this.keycloakTokenUrl },
                  { name: 'KEYCLOAK_CLIENT_ID', value: this.keycloak.clientId },
                  { name: 'KEYCLOAK_CLIENT_SECRET', value: this.keycloak.clientSecret },
                ],
              },
            ],
          },
        },
      },
    };
  }

  buildService() {
    return {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'fraud-ops-console', namespace: this.namespace },
      spec: {
        selector: { app: 'fraud-ops-console' },
        ports: [{ name: 'http', port: this.port, targetPort: this.port }],
      },
    };
  }

  buildCertificate() {
    return {
      apiVersion: 'cert-manager.io/v1',
      kind: 'Certificate',
      metadata: { name: 'fraud-ops-console-tls', namespace: this.namespace },
      spec: {
        secretName: 'fraud-ops-console-tls',
        issuerRef: { name: this.clusterIssuer, kind: 'ClusterIssuer' },
        dnsNames: [this.hostname],
      },
    };
  }

  // buildGatewayParameters returns an EnterpriseAgentgatewayParameters object
  // restricting the Gateway's LoadBalancer Service to sourceRanges, or
  // undefined when sourceRanges isn't set (leaves the LB open, matching prior
  // behavior). Native spec.loadBalancerSourceRanges, not an AWS-only
  // annotation -- this Gateway's LB is a GCP one.
  buildGatewayParameters() {
    if (!this.sourceRanges) return undefined;
    return {
      apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
      kind: 'EnterpriseAgentgatewayParameters',
      metadata: { name: 'fraud-ops-console-https-params', namespace: this.namespace },
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
          tls: { mode: 'Terminate', certificateRefs: [{ kind: 'Secret', name: 'fraud-ops-console-tls' }] },
          allowedRoutes: { namespaces: { from: 'Same' } },
        },
      ],
    };
    if (this.sourceRanges) {
      spec.infrastructure = {
        parametersRef: {
          name: 'fraud-ops-console-https-params',
          group: 'enterpriseagentgateway.solo.io',
          kind: 'EnterpriseAgentgatewayParameters',
        },
      };
    }
    return {
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'Gateway',
      metadata: { name: 'fraud-ops-console-https', namespace: this.namespace },
      spec,
    };
  }

  buildHTTPRoute() {
    return {
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'HTTPRoute',
      metadata: { name: 'fraud-ops-console', namespace: this.namespace },
      spec: {
        parentRefs: [
          {
            group: 'gateway.networking.k8s.io',
            kind: 'Gateway',
            name: 'fraud-ops-console-https',
            namespace: this.namespace,
          },
        ],
        hostnames: [this.hostname],
        rules: [
          {
            matches: [{ path: { type: 'PathPrefix', value: '/' } }],
            backendRefs: [{ group: '', kind: 'Service', name: 'fraud-ops-console', port: this.port }],
          },
        ],
      },
    };
  }

  async deploy() {
    await this.applyResource(this.buildServiceAccount());
    await this.applyResource(this.buildRole());
    await this.applyResource(this.buildRoleBinding());
    await this.applyResource(this.buildAteTokenRole());
    await this.applyResource(this.buildAteTokenRoleBinding());
    await this.applyResource(this.buildDeployment());
    await this.applyResource(this.buildService());
    await this.applyResource(this.buildCertificate());
    const gatewayParams = this.buildGatewayParameters();
    if (gatewayParams) await this.applyResource(gatewayParams);
    await this.applyResource(this.buildGateway());
    await this.applyResource(this.buildHTTPRoute());
    this.log(`fraud-ops-console deployed at https://${this.hostname} in '${this.namespace}'`, 'success');
  }

  async cleanup() {
    await this.deleteResource('httproute', 'fraud-ops-console', this.namespace);
    await this.deleteResource('gateway', 'fraud-ops-console-https', this.namespace);
    await this.deleteResource(
      'enterpriseagentgatewayparameters',
      'fraud-ops-console-https-params',
      this.namespace
    );
    await this.deleteResource('certificate', 'fraud-ops-console-tls', this.namespace);
    await this.deleteResource('service', 'fraud-ops-console', this.namespace);
    await this.deleteResource('deployment', 'fraud-ops-console', this.namespace);
    await this.deleteResource('rolebinding', 'fraud-ops-console-ate-token', this.ateNamespace);
    await this.deleteResource('role', 'fraud-ops-console-ate-token', this.ateNamespace);
    await this.deleteResource('rolebinding', 'fraud-ops-console', this.namespace);
    await this.deleteResource('role', 'fraud-ops-console', this.namespace);
    await this.deleteResource('serviceaccount', 'fraud-ops-console', this.namespace);
    this.log('fraud-ops-console cleaned up', 'success');
  }
}
