import { Feature } from '../../../src/lib/feature.js';
import { CommandRunner } from '../../../src/lib/common.js';

/**
 * McpToolPolicyFeature
 *
 * Applies one EnterpriseAgentgatewayPolicy targeting a single MCP server's live
 * EnterpriseAgentgatewayBackend (discovered by label, same pattern as
 * token-exchange-policy's discoverBackendName -- the per-server Backend name
 * AgentRegistry creates is hash-suffixed and not knowable ahead of time).
 *
 * Stage 4 of the guided tour (tool policy): a hard dollar cap on refund_payment
 * enforced at agentgateway itself, independent of what the calling agent's LLM
 * decides -- unlike Stage 3's ask_user threshold (which the LLM doesn't always
 * honor), this is a gateway-level backstop no agent instruction can talk around.
 *
 * Two mutually exclusive modes, selected by `mode`:
 *
 * - 'authorization' (default) -- spec.backend.mcp.authorization. CEL only sees
 *   mcp.tool.name/target and jwt.* -- never the call's arguments (confirmed
 *   against the agentgateway-enterprise source: McpAuthorizationSet::validate
 *   builds MCPInfo from a bare ResourceType). Referencing mcp.tool.arguments
 *   here fails closed: denies every call and hides the tool from tools/list.
 * - 'guardrails' -- spec.backend.mcp.guardrails.processors. Runs after
 *   argument parsing, so mcp.tool.arguments IS populated (dot access only,
 *   e.g. `mcp.tool.arguments.buyer_id`). Use this for any check needing the
 *   call's own arguments, e.g. an LLM-supplied buyer_id vs jwt.fixture_id.
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
 *   mode: string,                     // Default: 'authorization' -- 'authorization'|'guardrails'
 *   action: string,                   // authorization mode only. Default: 'Deny' -- Allow|Deny|Require
 *   matchExpressions: string[],       // authorization mode only. Required -- CEL expressions
 *   guardrailMethods: object,         // guardrails mode only. Default: { 'tools/call': 'Request' } --
 *                                      // map of MCP method pattern -> Phase (Off|Request|Response|Full)
 *   condition: string,                // guardrails mode only. Required -- CEL expression; true rejects
 *   reject: string,                   // guardrails mode only. Required -- message returned on rejection
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
    this.mode = config.mode || 'authorization';
    this.action = config.action || 'Deny';
    this.matchExpressions = config.matchExpressions || [];
    this.guardrailMethods = config.guardrailMethods || { 'tools/call': 'Request' };
    this.condition = config.condition;
    this.reject = config.reject;
  }

  validate() {
    if (!this.policyName) throw new Error('mcp-tool-policy: policyName is required');
    if (!this.namespace) throw new Error('mcp-tool-policy: namespace is required');
    if (!this.mcpServerName && !this.staticBackendName)
      throw new Error('mcp-tool-policy: mcpServerName is required unless staticBackendName is set');
    if (!['authorization', 'guardrails'].includes(this.mode))
      throw new Error(`mcp-tool-policy: mode must be 'authorization' or 'guardrails', got '${this.mode}'`);
    if (this.mode === 'authorization' && this.matchExpressions.length === 0)
      throw new Error('mcp-tool-policy: matchExpressions is required (non-empty) in authorization mode');
    if (this.mode === 'guardrails' && (!this.condition || !this.reject))
      throw new Error('mcp-tool-policy: condition and reject are required in guardrails mode');
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
    const mcp =
      this.mode === 'guardrails'
        ? {
            guardrails: {
              processors: [
                {
                  methods: this.guardrailMethods,
                  expression: { condition: this.condition, reject: this.reject },
                },
              ],
            },
          }
        : {
            authorization: {
              action: this.action,
              policy: { matchExpressions: this.matchExpressions },
            },
          };
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
        backend: { mcp },
      },
    };
  }

  async deploy() {
    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];
    for (const context of contextsToDeploy) {
      const backendName = this.staticBackendName || (await this.discoverBackendName(context));
      await this.applyResource(this.buildPolicy(backendName), context);
      const summary =
        this.mode === 'guardrails' ? 'guardrails reject-on-match' : `authorization ${this.action}`;
      this.log(
        `Tool policy '${this.policyName}' applied (${summary}), targeting Backend '${backendName}'`,
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
