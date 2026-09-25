import { Feature } from '../../../src/lib/feature.js';

/**
 * Destination Rule Feature
 *
 * Deploys DestinationRule resources for traffic policies and TLS origination.
 *
 * Configuration:
 * {
 *   ruleName: string,             // Required: DestinationRule name
 *   namespace: string,            // Required: Namespace
 *   host: string,                 // Required: Target host
 *   trafficPolicy: {              // Optional: Traffic policy configuration
 *     tls: {                      // TLS settings
 *       mode: string,             // DISABLE, SIMPLE, MUTUAL, ISTIO_MUTUAL
 *       clientCertificate: string, // For MUTUAL mode
 *       privateKey: string,        // For MUTUAL mode
 *       caCertificates: string,    // CA cert path
 *     },
 *     connectionPool: object,     // Connection pool settings
 *     loadBalancer: object,       // Load balancer settings
 *     outlierDetection: object,   // Outlier detection settings
 *   },
 *   subsets: array,               // Optional: Version-based subsets
 * }
 */
export class DestinationRuleFeature extends Feature {
  validate() {
    if (!this.config.ruleName) {
      throw new Error('ruleName is required for DestinationRule feature');
    }
    if (!this.config.namespace) {
      throw new Error('namespace is required for DestinationRule feature');
    }
    if (!this.config.host) {
      throw new Error('host is required for DestinationRule feature');
    }
    return true;
  }

  async deploy() {
    const namespace = this.config.namespace;
    const ruleName = this.config.ruleName;

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Deploying DestinationRule feature: ${ruleName}`, 'info');
    this.log(`  Namespace: ${namespace}`, 'info');
    this.log(`  Host: ${this.config.host}`, 'info');

    for (const context of contextsToDeploy) {
      await this.ensureNamespace(namespace, context);
    }

    const spec = {
      host: this.config.host,
    };

    if (this.config.trafficPolicy) {
      spec.trafficPolicy = this.config.trafficPolicy;
    }

    if (this.config.subsets) {
      spec.subsets = this.config.subsets;
    }

    const destinationRule = {
      apiVersion: 'networking.istio.io/v1beta1',
      kind: 'DestinationRule',
      metadata: {
        name: ruleName,
        namespace: namespace,
      },
      spec: spec,
    };

    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';
      this.log(`Applying DestinationRule: ${ruleName}${contextInfo}...`, 'info');
      await this.applyResource(destinationRule, context);
    }
  }

  async cleanup() {
    const ruleName = this.config.ruleName;
    const namespace = this.config.namespace;

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Cleaning up DestinationRule feature: ${ruleName}`, 'info');

    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';
      this.log(`Deleting DestinationRule: ${ruleName}${contextInfo}...`, 'info');
      await this.deleteResource('destinationrule', ruleName, namespace, context);
    }
  }
}

export function createDestinationRuleFeature(config) {
  return new DestinationRuleFeature('destination-rule', config);
}
