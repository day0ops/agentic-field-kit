import { Feature } from '../../../src/lib/feature.js';

/**
 * EnvSecretFeature
 *
 * Applies a plain Kubernetes Secret whose value comes from a named
 * environment variable — never a literal in profile/usecase YAML. Small and
 * generic on purpose: several usecases need "one secret value, sourced from
 * one env var" (e.g. a demo user's bootstrap password) without the weight of
 * a bespoke feature each time.
 *
 * Configuration:
 * {
 *   secretName: string,   // Required
 *   namespace: string,    // Required
 *   key: string,          // Secret data key (default: 'password')
 *   envVar: string,       // Required — name of the environment variable to read
 * }
 */
export class EnvSecretFeature extends Feature {
  constructor(name, config = {}) {
    super(name, config);
    this.secretName = config.secretName;
    this.key = config.key || 'password';
    this.envVar = config.envVar;
    this.value = this.envVar ? process.env[this.envVar] || '' : '';
  }

  validate() {
    if (!this.secretName) throw new Error('env-secret: secretName is required');
    if (!this.namespace) throw new Error('env-secret: namespace is required');
    if (!this.envVar) throw new Error('env-secret: envVar is required');
    if (!this.value) throw new Error(`env-secret: environment variable ${this.envVar} is not set`);
    return true;
  }

  buildSecret() {
    return {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: this.secretName,
        namespace: this.namespace,
        labels: { 'app.kubernetes.io/managed-by': 'agentic-demo', 'agentic.demo/feature': this.name },
      },
      type: 'Opaque',
      stringData: { [this.key]: this.value },
    };
  }

  async deploy() {
    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];
    for (const context of contextsToDeploy) {
      await this.applyResource(this.buildSecret(), context);
    }
    this.log(`Secret '${this.secretName}' applied from env var '${this.envVar}'`, 'success');
  }

  async cleanup() {
    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];
    for (const context of contextsToDeploy) {
      await this.deleteResource('secret', this.secretName, this.namespace, context);
    }
    this.log(`Secret '${this.secretName}' removed`, 'success');
  }
}
