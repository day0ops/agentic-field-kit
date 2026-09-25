import { Feature } from '../../../src/lib/feature.js';
import { CommandRunner } from '../../../src/lib/common.js';

/**
 * PiiGuardrailPolicyFeature
 *
 * Deploys retail-returns-agent-system's mcp-servers/pii-guardrail (a small
 * ExtMcp policy server -- CheckRequest always passes, CheckResponse redacts
 * email/phone patterns from a tool result's JSON) and wires it into
 * AgentRegistry's live MCP Backend via spec.backend.mcp.guardrails.
 * processors[].remote, Response phase only -- Stage 5 of the guided tour
 * (PII masking). Tool-deny (Request phase) is a separate concern (Stage 4 /
 * mcp.authorization), out of scope here.
 *
 * The target EnterpriseAgentgatewayBackend is created by AgentRegistry at
 * deploy time with a generated name, not something we can hardcode -- this
 * feature discovers it live via the same kubectl label-selector lookup
 * token-exchange-policy already uses for its own per-server Backend
 * targeting (`agentregistry.solo.io/ownerName=<serverName>,ownerKind=
 * Deployment`). Because Backend-kind targetRefs must live in the same
 * namespace as the policy that targets them (confirmed live via token-
 * exchange-policy's buildExchangePolicy()), this policy is applied in
 * backendDiscoveryNamespace (agentregistry-system), not this.namespace.
 * The guardrail server itself lives in this.namespace (agentgateway-proxy)
 * and is referenced across namespaces via a plain backendRef (not a Gateway
 * API targetRef), which doesn't need a ReferenceGrant -- same pattern
 * budget-policy already uses for its cross-namespace Keycloak JWKS
 * backendRef.
 *
 * Configuration:
 * {
 *   namespace: string,                 // Default: 'agentgateway-proxy' -- guardrail server's namespace
 *   backendDiscoveryNamespace: string, // Default: 'agentregistry-system' -- where AgentRegistry creates Backends
 *   serverName: string,                // Deployment/Service/ServiceAccount name (default: 'pii-guardrail')
 *   image: string,                     // Required -- container image
 *   imagePullPolicy: string,           // Default: 'IfNotPresent'
 *   port: number,                      // Default: 4445
 *   policyName: string,                // Default: 'pii-guardrail'
 *   mcpServerName: string,             // Required -- agentregistry serverName to discover the Backend for (e.g. 'order-db')
 *   failureMode: string,               // Default: 'FailClosed'
 * }
 */
export class PiiGuardrailPolicyFeature extends Feature {
  constructor(name, config = {}) {
    super(name, config);
    this.namespace = config.namespace || 'agentgateway-proxy';
    this.backendDiscoveryNamespace = config.backendDiscoveryNamespace || 'agentregistry-system';
    this.serverName = config.serverName || 'pii-guardrail';
    this.image = config.image;
    this.imagePullPolicy = config.imagePullPolicy || 'IfNotPresent';
    this.port = config.port || 4445;
    this.policyName = config.policyName || 'pii-guardrail';
    this.mcpServerName = config.mcpServerName;
    this.failureMode = config.failureMode || 'FailClosed';
  }

  validate() {
    if (!this.image) throw new Error('pii-guardrail-policy: image is required');
    if (!this.mcpServerName) throw new Error('pii-guardrail-policy: mcpServerName is required');
    const validFailureModes = ['FailClosed', 'FailOpen'];
    if (!validFailureModes.includes(this.failureMode)) {
      throw new Error(
        `pii-guardrail-policy: failureMode must be one of: ${validFailureModes.join(', ')}`
      );
    }
    return true;
  }

  labels() {
    return {
      'app.kubernetes.io/managed-by': 'agentic-demo',
      'agentic.demo/feature': this.name,
    };
  }

  /**
   * Live-discovers the single EnterpriseAgentgatewayBackend AgentRegistry
   * created for this.mcpServerName -- mirrors token-exchange-policy's
   * discoverBackendName() exactly, since the naming is agentregistry's own
   * generated scheme, not something either feature controls.
   */
  async discoverBackendName(context) {
    const contextFlag = context ? `--context=${context}` : '';
    const result = await CommandRunner.exec(
      `kubectl ${contextFlag} get enterpriseagentgatewaybackend -n ${this.backendDiscoveryNamespace} ` +
        `-l agentregistry.solo.io/ownerName=${this.mcpServerName},agentregistry.solo.io/ownerKind=Deployment -o jsonpath='{.items[*].metadata.name}'`
    );
    const names = result.stdout.trim().split(/\s+/).filter(Boolean);
    if (names.length !== 1) {
      throw new Error(
        `pii-guardrail-policy: expected exactly 1 EnterpriseAgentgatewayBackend for MCP server ` +
          `'${this.mcpServerName}' in namespace '${this.backendDiscoveryNamespace}', found ${names.length}` +
          (names.length > 0 ? ` (${names.join(', ')})` : '')
      );
    }
    return names[0];
  }

  async deployServer(context) {
    await this.applyResource(
      {
        apiVersion: 'v1',
        kind: 'ServiceAccount',
        metadata: { name: this.serverName, namespace: this.namespace, labels: this.labels() },
      },
      context
    );

    await this.applyResource(
      {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: {
          name: this.serverName,
          namespace: this.namespace,
          labels: { ...this.labels(), app: this.serverName },
        },
        spec: {
          selector: { app: this.serverName },
          ports: [
            {
              port: this.port,
              targetPort: this.port,
              // ExtMCP is plaintext gRPC (h2c) -- no TLS/HTTP1 negotiation involved.
              appProtocol: 'kubernetes.io/h2c',
            },
          ],
        },
      },
      context
    );

    await this.applyResource(
      {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
          name: this.serverName,
          namespace: this.namespace,
          labels: { ...this.labels(), app: this.serverName },
        },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: this.serverName } },
          template: {
            metadata: { labels: { app: this.serverName } },
            spec: {
              serviceAccountName: this.serverName,
              containers: [
                {
                  name: 'server',
                  image: this.image,
                  imagePullPolicy: this.imagePullPolicy,
                  ports: [{ containerPort: this.port }],
                  env: [{ name: 'PORT', value: String(this.port) }],
                  resources: {
                    requests: { memory: '64Mi', cpu: '50m' },
                    limits: { memory: '128Mi', cpu: '200m' },
                  },
                  // No HTTP endpoint to probe -- the server only speaks gRPC.
                  readinessProbe: {
                    tcpSocket: { port: this.port },
                    initialDelaySeconds: 3,
                    periodSeconds: 10,
                  },
                  livenessProbe: {
                    tcpSocket: { port: this.port },
                    initialDelaySeconds: 5,
                    periodSeconds: 30,
                  },
                },
              ],
            },
          },
        },
      },
      context
    );

    this.log(`pii-guardrail server '${this.serverName}' deployed`, 'info');
  }

  buildGuardrailPolicy(backendName) {
    return {
      apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
      kind: 'EnterpriseAgentgatewayPolicy',
      metadata: {
        name: this.policyName,
        namespace: this.backendDiscoveryNamespace,
        labels: this.labels(),
      },
      spec: {
        targetRefs: [
          {
            group: 'enterpriseagentgateway.solo.io',
            kind: 'EnterpriseAgentgatewayBackend',
            name: backendName,
          },
        ],
        backend: {
          mcp: {
            guardrails: {
              processors: [
                {
                  remote: {
                    backendRef: {
                      name: this.serverName,
                      namespace: this.namespace,
                      port: this.port,
                    },
                    failureMode: this.failureMode,
                  },
                  methods: { 'tools/call': 'Response' },
                },
              ],
            },
          },
        },
      },
    };
  }

  async deploy() {
    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];
    for (const context of contextsToDeploy) {
      await this.deployServer(context);
      const backendName = await this.discoverBackendName(context);
      await this.applyResource(this.buildGuardrailPolicy(backendName), context);
      this.log(
        `Guardrail policy '${this.policyName}' applied, targeting live Backend '${backendName}' ` +
          `(MCP server '${this.mcpServerName}')`,
        'success'
      );
    }
  }

  async cleanup() {
    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];
    for (const context of contextsToDeploy) {
      await this.deleteResource(
        'enterpriseagentgatewaypolicy',
        this.policyName,
        this.backendDiscoveryNamespace,
        context
      );
      await this.deleteResource('Deployment', this.serverName, this.namespace, context);
      await this.deleteResource('Service', this.serverName, this.namespace, context);
      await this.deleteResource('ServiceAccount', this.serverName, this.namespace, context);
    }
    this.log('pii-guardrail-policy feature cleaned up', 'success');
  }
}
