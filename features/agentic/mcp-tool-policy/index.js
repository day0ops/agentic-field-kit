import { Feature } from '../../../src/lib/feature.js';
import { CommandRunner } from '../../../src/lib/common.js';

/**
 * McpToolPolicyFeature
 *
 * Applies one EnterpriseAgentgatewayPolicy with spec.backend.mcp.authorization,
 * targeting a single MCP server's live EnterpriseAgentgatewayBackend (discovered
 * by label, same pattern as token-exchange-policy's discoverBackendName -- the
 * per-server Backend name AgentRegistry creates is hash-suffixed and not
 * knowable ahead of time).
 *
 * Stage 4 of the guided tour (tool policy): a hard dollar cap on refund_payment
 * enforced at agentgateway itself, independent of what the calling agent's LLM
 * decides -- unlike Stage 3's ask_user threshold (which the LLM doesn't always
 * honor), this is a gateway-level backstop no agent instruction can talk around.
 *
 * Configuration:
 * {
 *   policyName: string,               // Required
 *   namespace: string,                // Required
 *   mcpServerName: string,            // Required unless staticBackendName is set --
 *                                      // agentregistry serverName (e.g. 'payment')
 *   staticBackendName: string,        // Optional -- alternative to mcpServerName for
 *                                      // callers not using AgentRegistry: the exact
 *                                      // EnterpriseAgentgatewayBackend name to target
 *                                      // directly, skipping discoverBackendName(). When
 *                                      // set, this policy lives in config.namespace, not
 *                                      // backendDiscoveryNamespace.
 *   backendDiscoveryNamespace: string, // Default: 'agentregistry-system' (ignored when
 *                                      // staticBackendName is set)
 *   action: string,                   // Default: 'Deny' -- Allow|Deny|Require
 *   matchExpressions: string[],       // Required -- CEL expressions
 * }
 */
export class McpToolPolicyFeature extends Feature {
  constructor(name, config = {}) {
    super(name, config);
    this.policyName = config.policyName;
    this.mcpServerName = config.mcpServerName;
    this.staticBackendName = config.staticBackendName || null;
    this.backendDiscoveryNamespace = this.staticBackendName
      ? this.namespace
      : config.backendDiscoveryNamespace || 'agentregistry-system';
    this.action = config.action || 'Deny';
    this.matchExpressions = config.matchExpressions || [];
  }

  validate() {
    if (!this.policyName) throw new Error('mcp-tool-policy: policyName is required');
    if (!this.namespace) throw new Error('mcp-tool-policy: namespace is required');
    if (!this.mcpServerName && !this.staticBackendName)
      throw new Error(
        'mcp-tool-policy: mcpServerName is required unless staticBackendName is set'
      );
    if (this.matchExpressions.length === 0)
      throw new Error('mcp-tool-policy: matchExpressions is required (non-empty)');
    return true;
  }

  /**
   * Discover the live EnterpriseAgentgatewayBackend name AgentRegistry created for
   * this.mcpServerName (labeled agentregistry.solo.io/ownerName=<serverName> in
   * backendDiscoveryNamespace). Throws if none or more than one match is found.
   *
   * Filters on ownerKind=Deployment too -- see the identical comment on
   * token-exchange-policy's own discoverBackendName for why (AgentRegistry now also
   * creates a second, MCPServer-owned Backend+HTTPRoute per server at a DIFFERENT path
   * ('/mcp', a separate discovery mechanism), not a replacement for the Deployment-owned
   * one this use case's actual per-server routes rely on).
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
        `mcp-tool-policy: expected exactly 1 EnterpriseAgentgatewayBackend for ` +
          `MCP server '${this.mcpServerName}' in namespace '${this.backendDiscoveryNamespace}', found ${names.length}` +
          (names.length > 0 ? ` (${names.join(', ')})` : '')
      );
    }
    return names[0];
  }

  buildPolicy(backendName) {
    return {
      apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
      kind: 'EnterpriseAgentgatewayPolicy',
      metadata: {
        name: this.policyName,
        namespace: this.backendDiscoveryNamespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentic-demo',
          'agentic.demo/feature': this.name,
        },
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
            authorization: {
              action: this.action,
              policy: { matchExpressions: this.matchExpressions },
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
      const backendName = this.staticBackendName || (await this.discoverBackendName(context));
      await this.applyResource(this.buildPolicy(backendName), context);
      this.log(
        `Tool policy '${this.policyName}' applied (${this.action}), targeting Backend '${backendName}'`,
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
    }
    this.log(`Tool policy '${this.policyName}' removed`, 'success');
  }
}
