import { Feature } from '../../../src/lib/feature.js';
import { KubernetesHelper, Logger } from '../../../src/lib/common.js';

// Maps gatewayClassName → valid backend kinds for mismatch warnings
const GATEWAY_BACKEND_AFFINITY = {
  agentgateway: ['Service', 'AgentgatewayBackend'],
  'enterprise-agentgateway': ['Service', 'AgentgatewayBackend', 'EnterpriseAgentgatewayBackend'],
  istio: ['Service'],
};

export class IngressHttpRouteFeature extends Feature {
  constructor(name, config = {}) {
    super(name, config);
    this.routeName = config.routeName || config.gatewayName;
    this.namespace = config.namespace;
    this.gatewayName = config.gatewayName;
    this.gatewayNamespace = config.gatewayNamespace || config.namespace;
    this.hostname = config.hostname;
    this.rules = config.rules || [];
  }

  validate() {
    if (!this.gatewayName) throw new Error('gatewayName is required');
    if (!this.routeName) throw new Error('routeName or gatewayName is required');
    if (!this.namespace) throw new Error('namespace is required');
    if (!this.rules.length) throw new Error('at least one rule with backendRefs is required');
    for (const rule of this.rules) {
      if (!rule.backendRefs?.length) {
        throw new Error('each rule must have at least one backendRef');
      }
    }
    return true;
  }

  /**
   * Read parent Gateway's spec.gatewayClassName from the cluster.
   */
  async readGatewayClassName(context) {
    const ctxArgs = context ? ['--context', context] : [];
    const r = await KubernetesHelper.kubectl(
      [
        'get',
        'gateway',
        this.gatewayName,
        '-n',
        this.gatewayNamespace,
        '-o',
        'jsonpath={.spec.gatewayClassName}',
        ...ctxArgs,
      ],
      { ignoreError: true }
    );
    const cls = r?.stdout?.trim();
    if (!cls) {
      throw new Error(
        `Gateway "${this.gatewayName}" not found or has no gatewayClassName in namespace "${this.gatewayNamespace}". Deploy ingress-gateway first.`
      );
    }
    return cls;
  }

  /**
   * Read GatewayClass controller name — used to distinguish
   * agentgateway OSS vs Enterprise for AgentgatewayBackend group resolution.
   */
  async readGatewayClassController(gatewayClassName, context) {
    const ctxArgs = context ? ['--context', context] : [];
    const r = await KubernetesHelper.kubectl(
      [
        'get',
        'gatewayclass',
        gatewayClassName,
        '-o',
        'jsonpath={.spec.controllerName}',
        ...ctxArgs,
      ],
      { ignoreError: true }
    );
    return r?.stdout?.trim() || '';
  }

  /**
   * Resolve { kind, group } for a single backendRef entry.
   * Default is Service for all gateway types.
   * AgentgatewayBackend (agentgateway) requires explicit backendKind in config.
   */
  async resolveBackendRef(backendRef, gatewayClassName, context) {
    const { name, port, backendKind } = backendRef;

    // Warn on mismatch between gateway type and backend kind
    const affinity = GATEWAY_BACKEND_AFFINITY[gatewayClassName] || ['Service'];
    const effectiveKind = backendKind || 'Service';
    if (!affinity.includes(effectiveKind)) {
      Logger.warn(
        `backendKind "${effectiveKind}" is unusual for gatewayClassName "${gatewayClassName}"`
      );
    }

    if (!backendKind || backendKind === 'Service') {
      return { name, port, kind: 'Service', group: '' };
    }

    if (backendKind === 'AgentgatewayBackend') {
      const controller = await this.readGatewayClassController(gatewayClassName, context);
      const enterprise = controller === 'solo.io/enterprise-agentgateway';
      const group = enterprise ? 'enterpriseagentgateway.solo.io' : 'agentgateway.dev';
      const kind = enterprise ? 'EnterpriseAgentgatewayBackend' : 'AgentgatewayBackend';
      return { name, kind, group };
    }

    throw new Error(`Unknown backendKind "${backendKind}". Use: Service, AgentgatewayBackend`);
  }

  async buildHttpRoute(gatewayClassName, context) {
    const resolvedRules = [];
    for (const rule of this.rules) {
      const resolvedRefs = [];
      for (const ref of rule.backendRefs) {
        const resolved = await this.resolveBackendRef(ref, gatewayClassName, context);
        resolvedRefs.push(resolved);
      }
      resolvedRules.push({ ...rule, backendRefs: resolvedRefs });
    }

    const route = {
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'HTTPRoute',
      metadata: {
        name: this.routeName,
        namespace: this.namespace,
      },
      spec: {
        parentRefs: [{ name: this.gatewayName, namespace: this.gatewayNamespace }],
        rules: resolvedRules,
      },
    };
    if (this.hostname) route.spec.hostnames = [this.hostname];
    return route;
  }

  static buildRunbook(config, options = {}) {
    const { enterprise = false } = options;
    const rules = (config.rules || []).map(rule => ({
      ...rule,
      backendRefs: (rule.backendRefs || []).map(ref => {
        if (!ref.backendKind || ref.backendKind === 'Service') {
          return {
            name: ref.name,
            ...(ref.port != null ? { port: ref.port } : {}),
            kind: 'Service',
            group: '',
          };
        }
        if (ref.backendKind === 'AgentgatewayBackend') {
          return enterprise
            ? {
                name: ref.name,
                kind: 'EnterpriseAgentgatewayBackend',
                group: 'enterpriseagentgateway.solo.io',
              }
            : { name: ref.name, kind: 'AgentgatewayBackend', group: 'agentgateway.dev' };
        }
        return { name: ref.name };
      }),
    }));

    const route = {
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'HTTPRoute',
      metadata: {
        name: config.routeName || config.gatewayName,
        namespace: config.namespace,
      },
      spec: {
        parentRefs: [
          { name: config.gatewayName, namespace: config.gatewayNamespace || config.namespace },
        ],
        rules,
      },
    };
    if (config.hostname) route.spec.hostnames = [config.hostname];
    return [route];
  }

  async deploy() {
    this.validate();

    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];

    for (const context of contextsToDeploy) {
      const gatewayClassName = await this.readGatewayClassName(context);

      await this.ensureNamespace(this.namespace, context);

      const route = await this.buildHttpRoute(gatewayClassName, context);
      this.log(
        `Applying HTTPRoute "${this.routeName}" → Gateway "${this.gatewayName}" (${gatewayClassName})`
      );
      await this.applyResource(route, context);
      this.log(`HTTPRoute "${this.routeName}" applied`, 'success');
    }
  }

  async cleanup() {
    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];

    for (const context of contextsToDeploy) {
      await this.deleteResource('httproute', this.routeName, this.namespace, context);
    }
    this.log(`HTTPRoute "${this.routeName}" removed`, 'success');
  }
}
