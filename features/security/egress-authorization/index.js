import { Feature } from '../../../src/lib/feature.js';

/**
 * Egress Authorization Feature
 *
 * Deploys AuthorizationPolicy targeting an egress waypoint Gateway to control
 * which services can access external endpoints.
 *
 * Configuration:
 * {
 *   policyName: string,          // Required: Policy name
 *   namespace: string,           // Optional: Egress namespace (default: 'egress')
 *   waypointName: string,        // Optional: Target waypoint (default: 'egress-waypoint')
 *   action: string,              // Optional: ALLOW|DENY (default: ALLOW)
 *   rules: array,                // Required: Authorization rules
 * }
 */
export class EgressAuthorizationFeature extends Feature {
  validate() {
    if (!this.config.policyName) {
      throw new Error('policyName is required for EgressAuthorization feature');
    }
    if (!this.config.rules) {
      throw new Error('rules is required for EgressAuthorization feature');
    }
    return true;
  }

  async deploy() {
    const namespace = this.config.namespace || 'egress';
    const policyName = this.config.policyName;
    const waypointName = this.config.waypointName || 'egress-waypoint';
    const action = this.config.action || 'ALLOW';

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Deploying EgressAuthorization feature: ${policyName}`, 'info');
    this.log(`  Namespace: ${namespace}`, 'info');
    this.log(`  Target waypoint: ${waypointName}`, 'info');

    for (const context of contextsToDeploy) {
      await this.ensureNamespace(namespace, context);
    }

    const policy = {
      apiVersion: 'security.istio.io/v1',
      kind: 'AuthorizationPolicy',
      metadata: {
        name: policyName,
        namespace: namespace,
      },
      spec: {
        targetRefs: [
          {
            kind: 'Gateway',
            group: 'gateway.networking.k8s.io',
            name: waypointName,
          },
        ],
        action: action,
        rules: this.config.rules,
      },
    };

    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';
      this.log(`Applying egress AuthorizationPolicy: ${policyName}${contextInfo}...`, 'info');
      await this.applyResource(policy, context);
    }
  }

  async cleanup() {
    const policyName = this.config.policyName;
    const namespace = this.config.namespace || 'egress';

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Cleaning up EgressAuthorization feature: ${policyName}`, 'info');

    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';
      this.log(`Deleting AuthorizationPolicy: ${policyName}${contextInfo}...`, 'info');
      await this.deleteResource('authorizationpolicy', policyName, namespace, context);
    }
  }
}

export function createEgressAuthorizationFeature(config) {
  return new EgressAuthorizationFeature('egress-authorization', config);
}
