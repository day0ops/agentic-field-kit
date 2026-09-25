import { Feature } from '../../../src/lib/feature.js';
import { CommandRunner } from '../../../src/lib/common.js';

/**
 * McpElicitationPolicyFeature
 *
 * Applies one EnterpriseAgentgatewayPolicy carrying agentgateway's real
 * `entElicitation.interactive.oauth` + `entTokenExchange.solo.elicitation: {}`,
 * targeting a single MCP server's live EnterpriseAgentgatewayBackend directly.
 *
 * Distinct from token-exchange-policy's oauthTokenExchange (RFC 8693, exchanges
 * the CUSTOMER's own JWT for a downstream token) -- this gates the first call to
 * a tool that needs a THIRD-PARTY consent grant the gateway has never held, and
 * only resolves once the customer completes a real OAuth flow with that third
 * party. Live-verified end to end (see the Phase 9 plan doc): a gated MCP
 * tools/call returns 400 {"url": "<callback>"} until the STS's own /elicitations
 * lifecycle (GET list, PUT complete with an OAuth code) marks it completed,
 * after which the retried call succeeds with a real banked token.
 *
 * Like token-exchange-policy's exchange policy, this MUST live in the same
 * namespace as the Backend it targets (Backend-kind targetRefs require it) --
 * backendDiscoveryNamespace, not a separate `namespace` config field.
 *
 * Configuration:
 * {
 *   policyName: string,        // Required
 *   mcpServerName: string,     // Required unless staticBackendName is set — agentregistry
 *                              // serverName (this use case's agentregistry-catalog step)
 *                              // whose live Backend object this policy targets
 *   staticBackendName: string, // Optional — alternative to mcpServerName for callers that
 *                              // aren't using AgentRegistry: the exact EnterpriseAgentgatewayBackend
 *                              // name to target directly, skipping discoverBackendName()'s label
 *                              // lookup entirely. When set, this policy lives in config.namespace
 *                              // (wherever the caller's Backend actually is), not backendDiscoveryNamespace.
 *   backendDiscoveryNamespace: string, // Default: 'agentregistry-system' (ignored when
 *                              // staticBackendName is set — see above)
 *   clientId: string,          // Required — third-party OAuth client id
 *   clientSecret: string,      // Plaintext; the feature creates the Kubernetes Secret
 *                              // itself (same pattern as token-exchange-policy), callers
 *                              // don't pre-create it out of band. Required unless
 *                              // clientSecretEnvVar is set.
 *   clientSecretEnvVar: string, // Alternative to clientSecret — name of a required env
 *                              // var (no default) to read the secret from at deploy time.
 *                              // Use this instead of a literal for a real external
 *                              // credential (e.g. a cloud IdP's client secret) that
 *                              // shouldn't be committed to profile/usecase YAML.
 *   redirectUri: string,       // Required — must be pre-registered on the
 *                              // OAuth client exactly, or Keycloak rejects the
 *                              // code exchange with invalid_grant
 *   authorizeUrl: string,      // Required
 *   accessTokenUrl: string,    // Required
 *   scopes: string[],          // Optional — default ['openid', 'profile']
 * }
 */
export class McpElicitationPolicyFeature extends Feature {
  constructor(name, config = {}) {
    super(name, config);
    this.policyName = config.policyName;
    this.mcpServerName = config.mcpServerName;
    this.staticBackendName = config.staticBackendName || null;
    // Backend-kind targetRefs must live in the same namespace as the Backend they
    // target — there's no separate "traffic" half of this policy the way
    // token-exchange-policy has, so this feature's own namespace IS the discovery
    // namespace. With AgentRegistry that's always backendDiscoveryNamespace (a
    // caller-supplied namespace would be wrong); with a static Backend it's wherever
    // the caller's own Backend actually lives (this.namespace, already set from
    // config.namespace by the base Feature constructor above).
    this.backendDiscoveryNamespace = this.staticBackendName
      ? this.namespace
      : config.backendDiscoveryNamespace || 'agentregistry-system';
    this.namespace = this.backendDiscoveryNamespace;
    this.clientId = config.clientId;
    this.clientSecretEnvVar = config.clientSecretEnvVar || null;
    this.clientSecret =
      config.clientSecret ||
      (this.clientSecretEnvVar ? process.env[this.clientSecretEnvVar] : undefined);
    this.clientSecretName = `${config.policyName}-oauth-client`;
    this.clientSecretKey = 'clientSecret';
    this.redirectUri = config.redirectUri;
    this.authorizeUrl = config.authorizeUrl;
    this.accessTokenUrl = config.accessTokenUrl;
    this.scopes = config.scopes || ['openid', 'profile'];
  }

  validate() {
    if (!this.policyName) throw new Error('mcp-elicitation-policy: policyName is required');
    if (!this.mcpServerName && !this.staticBackendName)
      throw new Error(
        'mcp-elicitation-policy: mcpServerName is required unless staticBackendName is set'
      );
    if (!this.clientId) throw new Error('mcp-elicitation-policy: clientId is required');
    if (!this.clientSecret) {
      throw new Error(
        this.clientSecretEnvVar
          ? `mcp-elicitation-policy: environment variable ${this.clientSecretEnvVar} is not set`
          : 'mcp-elicitation-policy: clientSecret is required'
      );
    }
    if (!this.redirectUri) throw new Error('mcp-elicitation-policy: redirectUri is required');
    if (!this.authorizeUrl) throw new Error('mcp-elicitation-policy: authorizeUrl is required');
    if (!this.accessTokenUrl) throw new Error('mcp-elicitation-policy: accessTokenUrl is required');
    return true;
  }

  /**
   * Same discovery pattern as token-exchange-policy: the live Backend name is
   * hash-suffixed and only knowable once agentregistry-catalog has actually run.
   * ownerKind=Deployment filters out the separate, unrelated gw-be-mcpserver-*
   * Backend agentregistry also creates per server (see token-exchange-policy's
   * discoverBackendName doc comment for the full story).
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
        `mcp-elicitation-policy: expected exactly 1 EnterpriseAgentgatewayBackend for ` +
          `MCP server '${this.mcpServerName}' in namespace '${this.backendDiscoveryNamespace}', found ${names.length}` +
          (names.length > 0 ? ` (${names.join(', ')})` : '')
      );
    }
    return names[0];
  }

  buildClientSecret() {
    return {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: this.clientSecretName,
        namespace: this.backendDiscoveryNamespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentic-demo',
          'agentic.demo/feature': this.name,
        },
      },
      type: 'Opaque',
      stringData: { [this.clientSecretKey]: this.clientSecret },
    };
  }

  buildElicitationPolicy(backendName) {
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
          entElicitation: {
            interactive: {
              oauth: {
                clientId: this.clientId,
                clientSecretRef: { name: this.clientSecretName },
                scopes: this.scopes,
                redirectUri: this.redirectUri,
                authorizeUrl: this.authorizeUrl,
                accessTokenUrl: this.accessTokenUrl,
              },
            },
          },
          // Generic per-backend "elicit and exchange" behavior: the data plane
          // derives the resource key from the target Backend automatically and
          // calls the controller's own STS at its default backendRef — no
          // explicit backendRef needed here (confirmed live).
          entTokenExchange: { solo: { elicitation: {} } },
        },
      },
    };
  }

  async deploy() {
    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];
    for (const context of contextsToDeploy) {
      await this.applyResource(this.buildClientSecret(), context);
      const backendName = this.staticBackendName || (await this.discoverBackendName(context));
      await this.applyResource(this.buildElicitationPolicy(backendName), context);
      this.log(
        `Elicitation policy '${this.policyName}' applied, targeting live Backend '${backendName}'`,
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
      await this.deleteResource(
        'secret',
        this.clientSecretName,
        this.backendDiscoveryNamespace,
        context
      );
    }
    this.log(`Elicitation policy '${this.policyName}' removed`, 'success');
  }
}
