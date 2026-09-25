import { Feature } from '../../../src/lib/feature.js';
import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Gateway Feature
 *
 * Generates Gateway resources dynamically for each application.
 * HTTPRoute resources should be created using the request-routing feature.
 *
 * Configuration:
 * {
 *   gatewayName: string,          // Required: Gateway name (or use gwName for backward compatibility)
 *   namespace: string,            // Required: Namespace
 *   gateway: {                    // Gateway configuration
 *     gatewayClassName: string,   // Optional: Gateway class name (default: istio)
 *     serviceType: string,        // Optional: Service type for annotation (ClusterIP, LoadBalancer, etc.)
 *     listeners: array            // Required: Listener configurations
 *   }
 * }
 */
export class GatewayFeature extends Feature {
  validate() {
    const gatewayName = this.config.gatewayName || this.config.gwName;
    if (!gatewayName) {
      throw new Error('gatewayName (or gwName) is required for Gateway feature');
    }
    if (!this.config.namespace) {
      throw new Error('namespace is required for Gateway feature');
    }
    if (!this.config.gateway || !this.config.gateway.listeners) {
      throw new Error('gateway.listeners is required for Gateway feature');
    }
    return true;
  }

  /**
   * Load Gateway from config file if it exists
   */
  loadGatewayFromConfig() {
    const configPath = path.join(__dirname, 'config', 'gateway.yaml');
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf8');
      return yaml.load(content);
    }
    return null;
  }

  async deploy() {
    const namespace = this.config.namespace;
    const gatewayName = this.config.gatewayName || this.config.gwName;

    // Determine which clusters to deploy to
    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null]; // null means current context

    this.log(`Deploying Gateway feature: ${gatewayName}`, 'info');
    this.log(`  Namespace: ${namespace}`, 'info');
    if (contextsToDeploy.length > 0 && contextsToDeploy[0]) {
      this.log(`  Clusters: ${contextsToDeploy.join(', ')}`, 'info');
    }

    // Ensure namespace exists and is labeled for Ambient mode in each cluster
    for (const context of contextsToDeploy) {
      await this.ensureNamespace(namespace, context);
    }

    // Load Gateway template from config file or build from config
    const gatewayConfig = this.config.gateway;
    const configGateway = this.loadGatewayFromConfig();

    let gateway;
    if (configGateway) {
      // Use config file as base, override with spec config
      const gatewayClassName =
        gatewayConfig.gatewayClassName ||
        this.config.gatewayClassName ||
        configGateway.spec?.gatewayClassName ||
        'istio';

      // Process listeners from config, merging with defaults
      const listeners = gatewayConfig.listeners.map(listener => {
        return {
          name: listener.name || 'http',
          port: listener.port || 80,
          protocol: listener.protocol || 'HTTP',
          allowedRoutes: listener.allowedRoutes || {
            namespaces: {
              from: 'Same',
            },
          },
          // Preserve hostname and any other fields from listener config
          ...listener,
        };
      });

      gateway = {
        ...configGateway,
        metadata: {
          ...configGateway.metadata,
          name: gatewayName,
          namespace: namespace,
        },
        spec: {
          ...configGateway.spec,
          gatewayClassName: gatewayClassName,
          listeners: listeners,
        },
      };
    } else {
      // Build from spec config if no config file exists
      const gatewayClassName =
        gatewayConfig.gatewayClassName || this.config.gatewayClassName || 'istio';

      const listeners = gatewayConfig.listeners.map(listener => {
        return {
          name: listener.name || 'http',
          port: listener.port || 80,
          protocol: listener.protocol || 'HTTP',
          allowedRoutes: listener.allowedRoutes || {
            namespaces: {
              from: 'Same',
            },
          },
          ...listener,
        };
      });

      gateway = {
        apiVersion: 'gateway.networking.k8s.io/v1',
        kind: 'Gateway',
        metadata: {
          name: gatewayName,
          namespace: namespace,
        },
        spec: {
          gatewayClassName: gatewayClassName,
          listeners: listeners,
        },
      };
    }

    this.log(`  Gateway: ${gatewayName}`, 'info');

    // Deploy to each cluster
    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';

      // Apply Gateway
      this.log(`Applying Gateway: ${gatewayName}${contextInfo}...`, 'info');
      await this.applyResource(gateway, context);

      // Wait for Gateway to be programmed
      await this.waitForGateway(gatewayName, namespace, 60, context);

      // Annotate gateway for Istio if service-type is specified
      const serviceType = gatewayConfig.serviceType;
      if (serviceType) {
        this.log(
          `Annotating gateway ${gatewayName} with service-type=${serviceType}${contextInfo}...`,
          'info'
        );
        try {
          const contextFlag = context ? `--context=${context} ` : '';
          execSync(
            `kubectl ${contextFlag}annotate gateway ${gatewayName} networking.istio.io/service-type=${serviceType} --namespace=${namespace} --overwrite`,
            { stdio: 'inherit' }
          );
        } catch (error) {
          this.log(`Warning: Could not annotate gateway${contextInfo}: ${error.message}`, 'warn');
        }
      } else {
        this.log(`Skipping gateway annotation (service-type not specified)${contextInfo}`, 'info');
      }
    }
  }

  async cleanup() {
    const gatewayName = this.config.gatewayName || this.config.gwName;
    const namespace = this.config.namespace;

    // Determine which clusters to clean up
    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null]; // null means current context

    this.log(`Cleaning up Gateway feature: ${gatewayName}`, 'info');

    // Clean up from each cluster
    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';

      // Delete Gateway
      this.log(`Deleting Gateway: ${gatewayName}${contextInfo}...`, 'info');
      await this.deleteResource('gateway', gatewayName, namespace, context);
    }

    this.log(`✅ Gateway feature cleaned up successfully!`, 'success');
  }
}

// Export a factory function for easy instantiation
export function createGatewayFeature(config) {
  return new GatewayFeature('gateway', config);
}
