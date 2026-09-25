import { Feature } from '../../../src/lib/feature.js';
import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Request Routing Feature
 *
 * Deploys HTTPRoute resources for request routing based on paths, headers, or other criteria.
 * Uses httproute.yaml as a template and only updates necessary fields dynamically.
 *
 * Configuration:
 * {
 *   routeName: string,              // Required: HTTPRoute name
 *   namespace: string,               // Required: Namespace
 *   parentRefs: array,               // Optional: Parent references (if not provided, uses gatewayName/gatewayNamespace)
 *   gatewayName: string,             // Optional: Parent Gateway name (required if parentRefs not provided)
 *   gatewayNamespace: string,         // Optional: Gateway namespace (defaults to route namespace)
 *   hostname: string,                // Optional: Hostname for the route (overrides template)
 *   rules: array,                    // Optional: HTTPRoute rules (overrides template)
 * }
 */
export class RequestRoutingFeature extends Feature {
  validate() {
    if (!this.config.routeName) {
      throw new Error('routeName is required for RequestRouting feature');
    }
    if (!this.config.namespace) {
      throw new Error('namespace is required for RequestRouting feature');
    }
    // Either parentRefs or gatewayName must be provided
    if (!this.config.parentRefs && !this.config.gatewayName) {
      throw new Error('Either parentRefs or gatewayName is required for RequestRouting feature');
    }
    return true;
  }

  /**
   * Load HTTPRoute from config file if it exists
   */
  loadHttpRouteFromConfig() {
    const configPath = path.join(__dirname, 'config', 'httproute.yaml');
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf8');
      return yaml.load(content);
    }
    return null;
  }

  async deploy() {
    const namespace = this.config.namespace;
    const routeName = this.config.routeName;

    // Determine which clusters to deploy to
    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null]; // null means current context

    this.log(`Deploying RequestRouting feature: ${routeName}`, 'info');
    this.log(`  Namespace: ${namespace}`, 'info');
    if (contextsToDeploy.length > 0 && contextsToDeploy[0]) {
      this.log(`  Clusters: ${contextsToDeploy.join(', ')}`, 'info');
    }

    // Ensure namespace exists and is labeled for Ambient mode in each cluster
    for (const context of contextsToDeploy) {
      await this.ensureNamespace(namespace, context);
    }

    // Load HTTPRoute template from config file
    const configHttpRoute = this.loadHttpRouteFromConfig();
    if (!configHttpRoute) {
      throw new Error('httproute.yaml config file is required for RequestRouting feature');
    }

    // Build parentRefs - use user-provided if exists, otherwise build from gatewayName
    let parentRefs;
    if (
      this.config.parentRefs &&
      Array.isArray(this.config.parentRefs) &&
      this.config.parentRefs.length > 0
    ) {
      parentRefs = this.config.parentRefs;
      this.log(`  Using provided parentRefs`, 'info');
    } else if (this.config.gatewayName) {
      const gatewayName = this.config.gatewayName;
      const gatewayNamespace = this.config.gatewayNamespace || namespace;
      parentRefs = [
        {
          name: gatewayName,
          namespace: gatewayNamespace !== namespace ? gatewayNamespace : undefined,
        },
      ];
      this.log(`  Gateway: ${gatewayName} (namespace: ${gatewayNamespace})`, 'info');
    } else {
      // Use parentRefs from template if available
      parentRefs = configHttpRoute.spec?.parentRefs;
    }

    // Build HTTPRoute from template, only updating necessary fields
    const httpRoute = {
      ...configHttpRoute,
      metadata: {
        ...configHttpRoute.metadata,
        name: routeName,
        namespace: namespace,
      },
      spec: {
        ...configHttpRoute.spec,
        parentRefs: parentRefs,
        hostnames: this.config.hostname
          ? [this.config.hostname]
          : this.config.rules
            ? []
            : configHttpRoute.spec?.hostnames || [],
        // Only override rules if provided in config
        rules:
          this.config.rules && Array.isArray(this.config.rules) && this.config.rules.length > 0
            ? this.config.rules.map(rule => {
                // Ensure backendRefs have namespace if not specified
                const processedRule = { ...rule };
                if (processedRule.backendRefs) {
                  processedRule.backendRefs = processedRule.backendRefs.map(ref => {
                    const backendRef = { ...ref };
                    if (!backendRef.namespace) {
                      backendRef.namespace = namespace;
                    }
                    return backendRef;
                  });
                }
                return processedRule;
              })
            : configHttpRoute.spec?.rules || [],
      },
    };

    if (httpRoute.spec.hostnames && httpRoute.spec.hostnames.length > 0) {
      this.log(`  Hostname: ${httpRoute.spec.hostnames[0]}`, 'info');
    }
    if (httpRoute.spec.rules && httpRoute.spec.rules.length > 0) {
      this.log(`  Rules: ${httpRoute.spec.rules.length}`, 'info');
    }

    // Deploy HTTPRoute to each cluster
    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';
      this.log(`Applying HTTPRoute: ${routeName}${contextInfo}...`, 'info');
      await this.applyResource(httpRoute, context);
    }
  }

  async cleanup() {
    const routeName = this.config.routeName;
    const namespace = this.config.namespace;

    // Determine which clusters to clean up
    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null]; // null means current context

    this.log(`Cleaning up RequestRouting feature: ${routeName}`, 'info');

    // Clean up from each cluster
    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';

      // Delete HTTPRoute
      this.log(`Deleting HTTPRoute: ${routeName}${contextInfo}...`, 'info');
      await this.deleteResource('httproute', routeName, namespace, context);
    }

    this.log(`✅ RequestRouting feature cleaned up successfully!`, 'success');
  }
}

// Export a factory function for easy instantiation
export function createRequestRoutingFeature(config) {
  return new RequestRoutingFeature('request-routing', config);
}
