import { Feature } from '../../../src/lib/feature.js';

/**
 * Egress Waypoint Feature
 *
 * Deploys a waypoint proxy in a dedicated egress namespace for controlling
 * outbound traffic. The egress namespace is labeled for ambient mode and
 * the waypoint handles traffic to ServiceEntry-registered external services.
 *
 * Configuration:
 * {
 *   waypointName: string,         // Optional: Waypoint name (default: 'egress-waypoint')
 *   namespace: string,            // Optional: Egress namespace (default: 'egress')
 * }
 */
export class EgressWaypointFeature extends Feature {
  validate() {
    return true;
  }

  async deploy() {
    const namespace = this.config.namespace || 'egress';
    const waypointName = this.config.waypointName || 'egress-waypoint';

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Deploying EgressWaypoint feature: ${waypointName}`, 'info');
    this.log(`  Namespace: ${namespace}`, 'info');

    for (const context of contextsToDeploy) {
      await this.ensureNamespace(namespace, context);
    }

    const gateway = {
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'Gateway',
      metadata: {
        name: waypointName,
        namespace: namespace,
      },
      spec: {
        gatewayClassName: 'istio-waypoint',
        listeners: [{ name: 'mesh', port: 15008, protocol: 'HBONE' }],
      },
    };

    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';
      this.log(`Applying egress waypoint Gateway: ${waypointName}${contextInfo}...`, 'info');
      await this.applyResource(gateway, context);
      await this.waitForGateway(waypointName, namespace, 60, context);
    }
  }

  async cleanup() {
    const namespace = this.config.namespace || 'egress';
    const waypointName = this.config.waypointName || 'egress-waypoint';

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Cleaning up EgressWaypoint feature: ${waypointName}`, 'info');

    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';
      this.log(`Deleting egress Gateway: ${waypointName}${contextInfo}...`, 'info');
      await this.deleteResource('gateway', waypointName, namespace, context);
    }
  }
}

export function createEgressWaypointFeature(config) {
  return new EgressWaypointFeature('egress-waypoint', config);
}
