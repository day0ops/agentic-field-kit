import { Feature } from '../../../src/lib/feature.js';

/**
 * KagentAccessPolicyFeature
 *
 * Applies a native kagent `AccessPolicy` CR (policy.kagent-enterprise.solo.io/
 * v1alpha1) -- fine-grained authorization enforced at the Istio ambient
 * waypoint in front of the target Agent or MCPServer (Stage 11).
 *
 * Not to be confused with AgentRegistry's own `ar.dev/v1alpha1 AccessPolicy`
 * (Role-based control-plane RBAC, applied via arctl) or its
 * `RuntimeAccessPolicy` (identity-based tool authz for BedrockAgentCore
 * Runtimes only -- confirmed live that Kagent-type Runtimes have no
 * gatewayRef field to resolve it against, so it can never attach for this
 * project's agents). This is a distinct, purely Kubernetes-native mechanism
 * with its own CRD and controller, unrelated to AgentRegistry.
 *
 * Subject kinds:
 *   - Agent: matches the direct mTLS/SPIFFE peer identity. Only meaningful
 *     when the caller connects straight to the target's waypoint with no
 *     intermediate proxy hop -- confirmed live that a caller routed through
 *     hub-agentgateway-proxy (as this project's A2A hops are, by design, for
 *     token exchange) always presents as the *gateway's* own identity to the
 *     target's waypoint, never the true origin agent's.
 *   - UserGroup: matches a claim on a validated JWT (`jwt.<claimName> ==
 *     <claimValue>`) -- hop-independent, since the claim rides inside the
 *     request rather than depending on who terminated the connection.
 *
 * Configuration:
 * {
 *   policyName: string,       // Required
 *   namespace: string,        // Default: 'kagent-system'
 *   action: string,           // 'ALLOW' | 'DENY', default: 'ALLOW'
 *   subjects: [{              // Required, at least one
 *     kind: string,            // 'Agent' | 'UserGroup'
 *     name: string,            // Agent kind: the Agent CR name
 *     namespace: string,       // Agent kind: default this.namespace
 *     issuer: string,          // UserGroup kind: JWT issuer
 *     claimName: string,       // UserGroup kind: claim to match
 *     claimValue: string,      // UserGroup kind: expected claim value
 *     jwks: {                  // UserGroup kind: JWKS source
 *       serviceName: string, serviceNamespace: string, port: number, path: string,
 *     },
 *   }],
 *   targetKind: string,       // Required -- 'Agent' | 'MCPServer'
 *   targetName: string,       // Required
 *   tools: string[],          // Optional -- MCPServer targets only
 * }
 */
export class KagentAccessPolicyFeature extends Feature {
  constructor(name, config = {}) {
    super(name, config);
    this.policyName = config.policyName;
    this.namespace = config.namespace || 'kagent-system';
    this.action = config.action || 'ALLOW';
    this.subjects = config.subjects || [];
    this.targetKind = config.targetKind;
    this.targetName = config.targetName;
    this.tools = config.tools;
  }

  validate() {
    if (!this.policyName) throw new Error('kagent-access-policy: policyName is required');
    if (this.subjects.length === 0)
      throw new Error('kagent-access-policy: at least one subject is required');
    if (!this.targetKind) throw new Error('kagent-access-policy: targetKind is required');
    if (!this.targetName) throw new Error('kagent-access-policy: targetName is required');
    if (this.tools && this.targetKind !== 'MCPServer') {
      throw new Error('kagent-access-policy: tools is only valid when targetKind is MCPServer');
    }
    return true;
  }

  buildSubject(subject) {
    if (subject.kind === 'UserGroup') {
      return {
        kind: 'UserGroup',
        userGroup: {
          issuer: subject.issuer,
          claimName: subject.claimName,
          claimValue: subject.claimValue,
          jwksKey: {
            remote: {
              serviceRef: {
                name: subject.jwks.serviceName,
                namespace: subject.jwks.serviceNamespace,
                port: subject.jwks.port,
              },
              path: subject.jwks.path,
            },
          },
        },
      };
    }
    // Agent (default) -- direct mTLS/SPIFFE peer identity.
    return {
      kind: 'Agent',
      name: subject.name,
      namespace: subject.namespace || this.namespace,
    };
  }

  buildAccessPolicy() {
    return {
      apiVersion: 'policy.kagent-enterprise.solo.io/v1alpha1',
      kind: 'AccessPolicy',
      metadata: {
        name: this.policyName,
        namespace: this.namespace,
        labels: { 'app.kubernetes.io/managed-by': 'agentic-demo' },
      },
      spec: {
        action: this.action,
        from: { subjects: this.subjects.map(s => this.buildSubject(s)) },
        targetRef: {
          kind: this.targetKind,
          name: this.targetName,
          ...(this.tools && { tools: this.tools }),
        },
      },
    };
  }

  async deploy() {
    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];
    for (const context of contextsToDeploy) {
      await this.applyResource(this.buildAccessPolicy(), context);
      this.log(
        `AccessPolicy '${this.policyName}' applied (${this.action} -> ${this.targetKind}/${this.targetName})`,
        'success'
      );
    }
  }

  async cleanup() {
    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];
    for (const context of contextsToDeploy) {
      await this.deleteResource('accesspolicy', this.policyName, this.namespace, context);
    }
    this.log(`kagent-access-policy '${this.policyName}' cleaned up`, 'success');
  }
}

export function createKagentAccessPolicyFeature(config) {
  return new KagentAccessPolicyFeature('kagent-access-policy', config);
}
