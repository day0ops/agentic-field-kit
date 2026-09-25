import { Feature } from '../../../src/lib/feature.js';
import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Authorization Policy Feature
 *
 * Deploys configurable AuthorizationPolicy resources for L4/L7 access control.
 * Supports both targetRefs (Gateway API style) and selector-based targeting.
 *
 * Configuration:
 * {
 *   policyName: string,          // Required: Policy name
 *   namespace: string,           // Required: Namespace
 *   action: string,              // Optional: ALLOW|DENY|CUSTOM (default: ALLOW)
 *   targetRefs: array,           // Optional: Gateway API targetRefs
 *   rules: array,                // Required: Authorization rules
 * }
 */
export class AuthorizationPolicyFeature extends Feature {
  validate() {
    if (!this.config.policyName) {
      throw new Error('policyName is required for AuthorizationPolicy feature');
    }
    if (!this.config.namespace) {
      throw new Error('namespace is required for AuthorizationPolicy feature');
    }
    if (!this.config.rules) {
      throw new Error('rules is required for AuthorizationPolicy feature');
    }
    return true;
  }

  loadPolicyFromConfig() {
    const configPath = path.join(__dirname, 'config', 'authorization-policy.yaml');
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf8');
      return yaml.load(content);
    }
    return null;
  }

  async deploy() {
    const namespace = this.config.namespace;
    const policyName = this.config.policyName;
    const action = this.config.action || 'ALLOW';

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Deploying AuthorizationPolicy feature: ${policyName}`, 'info');
    this.log(`  Namespace: ${namespace}`, 'info');
    this.log(`  Action: ${action}`, 'info');

    for (const context of contextsToDeploy) {
      await this.ensureNamespace(namespace, context);
    }

    const spec = {
      action: action,
      rules: this.config.rules,
    };

    // Add targetRefs if provided (Gateway API style)
    if (this.config.targetRefs) {
      spec.targetRefs = this.config.targetRefs;
    }

    const policy = {
      apiVersion: 'security.istio.io/v1',
      kind: 'AuthorizationPolicy',
      metadata: {
        name: policyName,
        namespace: namespace,
      },
      spec: spec,
    };

    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';
      this.log(`Applying AuthorizationPolicy: ${policyName}${contextInfo}...`, 'info');
      await this.applyResource(policy, context);
    }
  }

  async cleanup() {
    const policyName = this.config.policyName;
    const namespace = this.config.namespace;

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Cleaning up AuthorizationPolicy feature: ${policyName}`, 'info');

    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';
      this.log(`Deleting AuthorizationPolicy: ${policyName}${contextInfo}...`, 'info');
      await this.deleteResource('authorizationpolicy', policyName, namespace, context);
    }
  }
}

export function createAuthorizationPolicyFeature(config) {
  return new AuthorizationPolicyFeature('authorization-policy', config);
}
