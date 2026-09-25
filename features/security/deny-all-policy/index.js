import { Feature } from '../../../src/lib/feature.js';
import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Deny All Policy Feature
 *
 * Deploys an empty-spec AuthorizationPolicy that denies all traffic to a namespace.
 * This is the foundation for zero-trust security posture.
 *
 * Configuration:
 * {
 *   policyName: string,          // Optional: Policy name (default: 'deny-all')
 *   namespace: string,           // Required: Namespace to protect
 * }
 */
export class DenyAllPolicyFeature extends Feature {
  validate() {
    if (!this.config.namespace) {
      throw new Error('namespace is required for DenyAllPolicy feature');
    }
    return true;
  }

  loadPolicyFromConfig() {
    const configPath = path.join(__dirname, 'config', 'deny-all.yaml');
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf8');
      return yaml.load(content);
    }
    return null;
  }

  async deploy() {
    const namespace = this.config.namespace;
    const policyName = this.config.policyName || 'deny-all';

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Deploying DenyAllPolicy feature: ${policyName}`, 'info');
    this.log(`  Namespace: ${namespace}`, 'info');

    for (const context of contextsToDeploy) {
      await this.ensureNamespace(namespace, context);
    }

    const configPolicy = this.loadPolicyFromConfig();

    const policy = configPolicy
      ? {
          ...configPolicy,
          metadata: {
            ...configPolicy.metadata,
            name: policyName,
            namespace: namespace,
          },
        }
      : {
          apiVersion: 'security.istio.io/v1',
          kind: 'AuthorizationPolicy',
          metadata: {
            name: policyName,
            namespace: namespace,
          },
          spec: {},
        };

    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';
      this.log(`Applying deny-all AuthorizationPolicy: ${policyName}${contextInfo}...`, 'info');
      await this.applyResource(policy, context);
    }
  }

  async cleanup() {
    const policyName = this.config.policyName || 'deny-all';
    const namespace = this.config.namespace;

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Cleaning up DenyAllPolicy feature: ${policyName}`, 'info');

    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';
      this.log(`Deleting AuthorizationPolicy: ${policyName}${contextInfo}...`, 'info');
      await this.deleteResource('authorizationpolicy', policyName, namespace, context);
    }
  }
}

export function createDenyAllPolicyFeature(config) {
  return new DenyAllPolicyFeature('deny-all-policy', config);
}
