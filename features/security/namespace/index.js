import { Feature } from '../../../src/lib/feature.js';

/**
 * NamespaceFeature
 *
 * Ensures a namespace exists (idempotently) and is labeled for Ambient mode,
 * independent of any application manifest or addon install. Needed when a
 * usecase's features write directly into a namespace (e.g. env-secret's
 * Secret) but no application in `requires.applications` happens to target
 * that namespace on that cluster to trigger the same as a side effect.
 *
 * Configuration:
 * {
 *   namespace: string,  // Required (the standard per-feature `namespace` field)
 * }
 */
export class NamespaceFeature extends Feature {
  validate() {
    if (!this.namespace) throw new Error('namespace: namespace is required');
    return true;
  }

  async deploy() {
    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];
    for (const context of contextsToDeploy) {
      await this.ensureNamespace(this.namespace, context);
    }
    this.log(`Namespace '${this.namespace}' ensured`, 'success');
  }

  async cleanup() {
    // Intentionally a no-op: this namespace is typically shared with other
    // features/applications in the same usecase; deleting it here could
    // remove state this feature doesn't own.
  }
}
