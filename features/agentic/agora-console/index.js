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
 * Deliberately simpler than fraud-ops-console, not a direct copy: no
 * ServiceAccount/Role/RoleBinding, no Keycloak client-credentials wiring.
 * fraud-ops-console needs both because it queries kagent/Substrate CRDs
 * directly (live density telemetry) and calls kagent's gRPC API (real agent
 * invocation). agora-demo's console does neither yet - its AgentInvoker is
 * still a stub and its Operator Studio substrate section always resolves an
 * honest empty state, making no live K8s API calls at all. Building in
 * RBAC/Keycloak wiring for a capability that doesn't exist yet would be dead
 * configuration granted to an unused ServiceAccount. Add that wiring later,
 * if and when agora-demo's console gains real substrate-querying or real
 * kagent-invocation code.
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
    this.sourceRanges = config.sourceRanges || null;
    this.catalogApiPort = config.catalogApiPort || 18080;
    this.consolePort = config.consolePort || 18090;
  }

  getFeaturePath() {
    return 'agentic/agora-console';
  }

  validate() {
    if (!this.catalogApiImage) throw new Error('agora-console: catalogApiImage is required');
    if (!this.consoleImage) throw new Error('agora-console: consoleImage is required');
    if (!this.hostname) throw new Error('agora-console: hostname is required');
    return true;
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

  buildHTTPRoute() {
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
          {
            matches: [{ path: { type: 'PathPrefix', value: '/' } }],
            backendRefs: [{ group: '', kind: 'Service', name: 'console', port: this.consolePort }],
          },
        ],
      },
    };
  }

  async deploy() {
    await this.applyResource(this.buildCatalogApiDeployment());
    await this.applyResource(this.buildCatalogApiService());
    await this.applyResource(this.buildConsoleDeployment());
    await this.applyResource(this.buildConsoleService());
    await this.applyResource(this.buildCertificate());
    const gatewayParams = this.buildGatewayParameters();
    if (gatewayParams) await this.applyResource(gatewayParams);
    await this.applyResource(this.buildGateway());
    await this.applyResource(this.buildHTTPRoute());
    this.log(
      `agora-console deployed at https://${this.hostname} in '${this.namespace}'`,
      'success'
    );
  }

  async cleanup() {
    await this.deleteResource('httproute', 'agora-console', this.namespace);
    await this.deleteResource('gateway', 'agora-console-https', this.namespace);
    await this.deleteResource(
      'enterpriseagentgatewayparameters',
      'agora-console-https-params',
      this.namespace
    );
    await this.deleteResource('certificate', 'agora-console-tls', this.namespace);
    await this.deleteResource('service', 'console', this.namespace);
    await this.deleteResource('deployment', 'console', this.namespace);
    await this.deleteResource('service', 'catalog-api', this.namespace);
    await this.deleteResource('deployment', 'catalog-api', this.namespace);
    this.log('agora-console cleaned up', 'success');
  }
}
