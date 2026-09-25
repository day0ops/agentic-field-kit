import { Feature } from '../../../src/lib/feature.js';

/**
 * Service Entry Feature
 *
 * Deploys ServiceEntry resources for registering external services in the mesh.
 * Supports waypoint binding via labels for egress control.
 *
 * Configuration:
 * {
 *   entryName: string,            // Required: ServiceEntry name
 *   namespace: string,            // Required: Namespace
 *   hosts: array,                 // Required: External hostnames
 *   location: string,             // Optional: MESH_EXTERNAL or MESH_INTERNAL (default: MESH_EXTERNAL)
 *   resolution: string,           // Optional: DNS, STATIC, NONE (default: DNS)
 *   ports: array,                 // Required: Port definitions [{number, name, protocol, targetPort}]
 *   waypointName: string,         // Optional: Label ServiceEntry with waypoint
 * }
 */
export class ServiceEntryFeature extends Feature {
  validate() {
    if (!this.config.entryName) {
      throw new Error('entryName is required for ServiceEntry feature');
    }
    if (!this.config.namespace) {
      throw new Error('namespace is required for ServiceEntry feature');
    }
    if (!this.config.hosts || !this.config.hosts.length) {
      throw new Error('hosts is required for ServiceEntry feature');
    }
    if (!this.config.ports || !this.config.ports.length) {
      throw new Error('ports is required for ServiceEntry feature');
    }
    return true;
  }

  async deploy() {
    const namespace = this.config.namespace;
    const entryName = this.config.entryName;

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Deploying ServiceEntry feature: ${entryName}`, 'info');
    this.log(`  Namespace: ${namespace}`, 'info');
    this.log(`  Hosts: ${this.config.hosts.join(', ')}`, 'info');

    for (const context of contextsToDeploy) {
      await this.ensureNamespace(namespace, context);
    }

    const labels = {};
    if (this.config.waypointName) {
      labels['istio.io/use-waypoint'] = this.config.waypointName;
    }

    const serviceEntry = {
      apiVersion: 'networking.istio.io/v1beta1',
      kind: 'ServiceEntry',
      metadata: {
        name: entryName,
        namespace: namespace,
        ...(Object.keys(labels).length > 0 ? { labels } : {}),
      },
      spec: {
        hosts: this.config.hosts,
        location: this.config.location || 'MESH_EXTERNAL',
        resolution: this.config.resolution || 'DNS',
        ports: this.config.ports,
      },
    };

    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';
      this.log(`Applying ServiceEntry: ${entryName}${contextInfo}...`, 'info');
      await this.applyResource(serviceEntry, context);
    }
  }

  async cleanup() {
    const entryName = this.config.entryName;
    const namespace = this.config.namespace;

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Cleaning up ServiceEntry feature: ${entryName}`, 'info');

    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';
      this.log(`Deleting ServiceEntry: ${entryName}${contextInfo}...`, 'info');
      await this.deleteResource('serviceentry', entryName, namespace, context);
    }
  }
}

export function createServiceEntryFeature(config) {
  return new ServiceEntryFeature('service-entry', config);
}
