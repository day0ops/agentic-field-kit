import { Feature } from '../../../src/lib/feature.js';

// For enterprise, mcp config maps to spec.entMcp (EntMCPBackend)
// For OSS,        mcp config maps to spec.mcp
export class AgentgatewayBackendFeature extends Feature {
  constructor(name, config = {}) {
    super(name, config);
    this.backendName = config.backendName;
    this.namespace = config.namespace;
    this.enterprise = config.enterprise === true;
    this.mcp = config.mcp || null;
    this.ai = config.ai || null;
    this.a2a = config.a2a || null;
  }

  validate() {
    if (!this.backendName) throw new Error('agentgateway-backend: backendName is required');
    if (!this.namespace) throw new Error('agentgateway-backend: namespace is required');
    const types = [this.mcp, this.ai, this.a2a].filter(Boolean);
    if (types.length === 0)
      throw new Error('agentgateway-backend: one of mcp, ai, or a2a is required');
    if (types.length > 1)
      throw new Error('agentgateway-backend: only one of mcp, ai, or a2a may be set');
    return true;
  }

  buildResource() {
    const apiVersion = this.enterprise
      ? 'enterpriseagentgateway.solo.io/v1alpha1'
      : 'agentgateway.dev/v1alpha1';
    const kind = this.enterprise ? 'EnterpriseAgentgatewayBackend' : 'AgentgatewayBackend';

    const spec = {};
    if (this.mcp) {
      // enterprise: entMcp (EntMCPBackend); oss: mcp
      spec[this.enterprise ? 'entMcp' : 'mcp'] = this.mcp;
    }
    if (this.ai) spec.ai = this.ai;
    if (this.a2a) spec.a2a = this.a2a;

    return {
      apiVersion,
      kind,
      metadata: { name: this.backendName, namespace: this.namespace },
      spec,
    };
  }

  static buildRunbook(config, _options = {}) {
    const feature = new AgentgatewayBackendFeature('agentgateway-backend', config);
    return [feature.buildResource()];
  }

  async deploy() {
    this.validate();

    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];

    for (const context of contextsToDeploy) {
      const resource = this.buildResource();
      this.log(`Applying ${resource.kind} "${this.backendName}" (ns: ${this.namespace})`);
      await this.applyResource(resource, context);
      this.log(`${resource.kind} "${this.backendName}" applied`, 'success');
    }
  }

  async cleanup() {
    const kind = this.enterprise ? 'enterpriseagentgatewaybackend' : 'agentgatewaybackend';

    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];

    for (const context of contextsToDeploy) {
      await this.deleteResource(kind, this.backendName, this.namespace, context);
    }
    this.log(`${kind} "${this.backendName}" removed`, 'success');
  }
}
