import { Feature } from '../../../src/lib/feature.js';

/**
 * Segment Feature
 *
 * Creates admin.solo.io/v1alpha1 Segment CRs for DNS domain isolation
 * across clusters. Segments provide namespace-scoped multicluster grouping.
 *
 * Configuration:
 * {
 *   segmentName: string,          // Required: Segment name
 *   namespace: string,            // Optional: Segment CR namespace (default: 'gloo-mesh')
 *   clusterSelector: object,      // Optional: Cluster label selector
 *   namespaceSelector: object,    // Optional: Namespace label selector
 *   domain: string,               // Required: DNS domain for the segment (e.g. 'team-a.global')
 * }
 */
export class SegmentFeature extends Feature {
  validate() {
    if (!this.config.segmentName) {
      throw new Error('segmentName is required for Segment feature');
    }
    if (!this.config.domain) {
      throw new Error('domain is required for Segment feature');
    }
    return true;
  }

  async deploy() {
    const namespace = this.config.namespace || 'gloo-mesh';
    const segmentName = this.config.segmentName;

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Deploying Segment feature: ${segmentName}`, 'info');
    this.log(`  Namespace: ${namespace}`, 'info');
    this.log(`  Domain: ${this.config.domain}`, 'info');

    const spec = {
      config: {
        dns: {
          domain: this.config.domain,
        },
      },
    };

    if (this.config.clusterSelector) {
      spec.clusterSelector = this.config.clusterSelector;
    }

    if (this.config.namespaceSelector) {
      spec.namespaceSelector = this.config.namespaceSelector;
    }

    const segment = {
      apiVersion: 'admin.solo.io/v1alpha1',
      kind: 'Segment',
      metadata: {
        name: segmentName,
        namespace: namespace,
      },
      spec: spec,
    };

    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';
      this.log(`Applying Segment: ${segmentName}${contextInfo}...`, 'info');
      await this.applyResource(segment, context);
    }
  }

  async cleanup() {
    const segmentName = this.config.segmentName;
    const namespace = this.config.namespace || 'gloo-mesh';

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Cleaning up Segment feature: ${segmentName}`, 'info');

    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';
      this.log(`Deleting Segment: ${segmentName}${contextInfo}...`, 'info');
      await this.deleteResource('segment', segmentName, namespace, context);
    }
  }
}

export function createSegmentFeature(config) {
  return new SegmentFeature('segment', config);
}
