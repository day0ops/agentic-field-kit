import { Feature } from '../../../src/lib/feature.js';

/**
 * Retry Policy Feature
 *
 * Deploys VirtualService with retry configuration through a waypoint proxy.
 * Uses VirtualService since Gateway API HTTPRoute doesn't yet standardize retry filters.
 *
 * Configuration:
 * {
 *   routeName: string,           // Required: VirtualService name
 *   namespace: string,           // Required: Namespace
 *   host: string,                // Required: Target service host
 *   retries: {                   // Required: Retry configuration
 *     attempts: number,          // Number of retry attempts (default: 3)
 *     perTryTimeout: string,     // Timeout per attempt (default: '2s')
 *     retryOn: string,           // Retry conditions (default: '5xx,reset,connect-failure')
 *   },
 *   destination: {               // Optional: Route destination overrides
 *     host: string,
 *     port: number,
 *   },
 * }
 */
export class RetryPolicyFeature extends Feature {
  validate() {
    if (!this.config.routeName) {
      throw new Error('routeName is required for RetryPolicy feature');
    }
    if (!this.config.namespace) {
      throw new Error('namespace is required for RetryPolicy feature');
    }
    if (!this.config.host) {
      throw new Error('host is required for RetryPolicy feature');
    }
    return true;
  }

  async deploy() {
    const namespace = this.config.namespace;
    const routeName = this.config.routeName;
    const host = this.config.host;

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Deploying RetryPolicy feature: ${routeName}`, 'info');
    this.log(`  Namespace: ${namespace}`, 'info');
    this.log(`  Host: ${host}`, 'info');

    for (const context of contextsToDeploy) {
      await this.ensureNamespace(namespace, context);
    }

    const retries = {
      attempts: this.config.retries?.attempts || 3,
      perTryTimeout: this.config.retries?.perTryTimeout || '2s',
      retryOn: this.config.retries?.retryOn || '5xx,reset,connect-failure',
    };

    const destHost = this.config.destination?.host || host;
    const route = [{ destination: { host: destHost } }];
    if (this.config.destination?.port) {
      route[0].destination.port = { number: this.config.destination.port };
    }

    const virtualService = {
      apiVersion: 'networking.istio.io/v1beta1',
      kind: 'VirtualService',
      metadata: {
        name: routeName,
        namespace: namespace,
      },
      spec: {
        hosts: [host],
        http: [
          {
            retries: retries,
            route: route,
          },
        ],
      },
    };

    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';
      this.log(`Applying retry VirtualService: ${routeName}${contextInfo}...`, 'info');
      await this.applyResource(virtualService, context);
    }
  }

  async cleanup() {
    const routeName = this.config.routeName;
    const namespace = this.config.namespace;

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Cleaning up RetryPolicy feature: ${routeName}`, 'info');

    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';
      this.log(`Deleting VirtualService: ${routeName}${contextInfo}...`, 'info');
      await this.deleteResource('virtualservice', routeName, namespace, context);
    }
  }
}

export function createRetryPolicyFeature(config) {
  return new RetryPolicyFeature('retry-policy', config);
}
