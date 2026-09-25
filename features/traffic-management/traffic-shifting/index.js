import { Feature } from '../../../src/lib/feature.js';
import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Traffic Shifting Feature
 *
 * Deploys HTTPRoute with weighted backendRefs for canary/traffic splitting.
 * Targets a waypoint proxy via parentRefs.
 *
 * Configuration:
 * {
 *   routeName: string,            // Required: HTTPRoute name
 *   namespace: string,            // Required: Namespace
 *   parentRefs: array,            // Optional: Parent references (default: waypoint in same namespace)
 *   waypointName: string,         // Optional: Waypoint Gateway name (shorthand for parentRefs)
 *   hostnames: array,             // Optional: Hostnames to match
 *   rules: array,                 // Required: Weighted backendRefs rules
 * }
 */
export class TrafficShiftingFeature extends Feature {
  validate() {
    if (!this.config.routeName) {
      throw new Error('routeName is required for TrafficShifting feature');
    }
    if (!this.config.namespace) {
      throw new Error('namespace is required for TrafficShifting feature');
    }
    if (!this.config.rules) {
      throw new Error('rules is required for TrafficShifting feature');
    }
    return true;
  }

  loadRouteFromConfig() {
    const configPath = path.join(__dirname, 'config', 'httproute-weighted.yaml');
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf8');
      return yaml.load(content);
    }
    return null;
  }

  async deploy() {
    const namespace = this.config.namespace;
    const routeName = this.config.routeName;

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Deploying TrafficShifting feature: ${routeName}`, 'info');
    this.log(`  Namespace: ${namespace}`, 'info');

    for (const context of contextsToDeploy) {
      await this.ensureNamespace(namespace, context);
    }

    // Build parentRefs
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

    // Ensure backendRefs have namespace
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
        ...(this.config.hostnames ? { hostnames: this.config.hostnames } : {}),
        rules: rules,
      },
    };

    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';
      this.log(`Applying weighted HTTPRoute: ${routeName}${contextInfo}...`, 'info');
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

    this.log(`Cleaning up TrafficShifting feature: ${routeName}`, 'info');

    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';
      this.log(`Deleting HTTPRoute: ${routeName}${contextInfo}...`, 'info');
      await this.deleteResource('httproute', routeName, namespace, context);
    }
  }
}

export function createTrafficShiftingFeature(config) {
  return new TrafficShiftingFeature('traffic-shifting', config);
}
