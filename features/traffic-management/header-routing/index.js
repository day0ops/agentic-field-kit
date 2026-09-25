import { Feature } from '../../../src/lib/feature.js';

/**
 * Header Routing Feature
 *
 * Deploys HTTPRoute with header-based matching rules via a waypoint proxy.
 *
 * Configuration:
 * {
 *   routeName: string,            // Required: HTTPRoute name
 *   namespace: string,            // Required: Namespace
 *   parentRefs: array,            // Optional: Parent references
 *   waypointName: string,         // Optional: Waypoint Gateway name
 *   rules: array,                 // Required: Header match rules with backendRefs
 * }
 */
export class HeaderRoutingFeature extends Feature {
  validate() {
    if (!this.config.routeName) {
      throw new Error('routeName is required for HeaderRouting feature');
    }
    if (!this.config.namespace) {
      throw new Error('namespace is required for HeaderRouting feature');
    }
    if (!this.config.rules) {
      throw new Error('rules is required for HeaderRouting feature');
    }
    return true;
  }

  async deploy() {
    const namespace = this.config.namespace;
    const routeName = this.config.routeName;

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Deploying HeaderRouting feature: ${routeName}`, 'info');
    this.log(`  Namespace: ${namespace}`, 'info');

    for (const context of contextsToDeploy) {
      await this.ensureNamespace(namespace, context);
    }

    let parentRefs;
    if (this.config.parentRefs) {
      parentRefs = this.config.parentRefs;
    } else if (this.config.waypointName) {
      parentRefs = [
        {
          name: this.config.waypointName,
          kind: 'Gateway',
          group: 'gateway.networking.k8s.io',
        },
      ];
    } else {
      parentRefs = [
        {
          name: 'waypoint',
          kind: 'Gateway',
          group: 'gateway.networking.k8s.io',
        },
      ];
    }

    const rules = this.config.rules.map(rule => {
      const processed = { ...rule };
      if (processed.backendRefs) {
        processed.backendRefs = processed.backendRefs.map(ref => ({
          ...ref,
          namespace: ref.namespace || namespace,
        }));
      }
      return processed;
    });

    const httpRoute = {
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'HTTPRoute',
      metadata: {
        name: routeName,
        namespace: namespace,
      },
      spec: {
        parentRefs: parentRefs,
        rules: rules,
      },
    };

    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';
      this.log(`Applying header-match HTTPRoute: ${routeName}${contextInfo}...`, 'info');
      await this.applyResource(httpRoute, context);
    }
  }

  async cleanup() {
    const routeName = this.config.routeName;
    const namespace = this.config.namespace;

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Cleaning up HeaderRouting feature: ${routeName}`, 'info');

    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';
      this.log(`Deleting HTTPRoute: ${routeName}${contextInfo}...`, 'info');
      await this.deleteResource('httproute', routeName, namespace, context);
    }
  }
}

export function createHeaderRoutingFeature(config) {
  return new HeaderRoutingFeature('header-routing', config);
}
