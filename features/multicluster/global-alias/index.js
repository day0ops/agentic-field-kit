import { Feature } from '../../../src/lib/feature.js';
import { CommandRunner } from '../../../src/lib/common.js';

/**
 * Global Alias Feature
 *
 * Patches existing Segment CRs with DNS alias patterns for cross-cluster
 * service resolution. Supports 4 alias pattern types from the workshop.
 *
 * Configuration:
 * {
 *   segmentName: string,          // Required: Segment to patch
 *   namespace: string,            // Optional: Segment CR namespace (default: 'gloo-mesh')
 *   aliases: array,               // Required: Alias patterns [{pattern}]
 *     // Pattern types:
 *     // - "{name}.{namespace}.svc.cluster.local" (full Kubernetes DNS)
 *     // - "{name}.{namespace}.svc" (short DNS)
 *     // - "{name}.{namespace}" (minimal)
 *     // - Custom patterns
 * }
 */
export class GlobalAliasFeature extends Feature {
  validate() {
    if (!this.config.segmentName) {
      throw new Error('segmentName is required for GlobalAlias feature');
    }
    if (!this.config.aliases || !this.config.aliases.length) {
      throw new Error('aliases is required for GlobalAlias feature');
    }
    return true;
  }

  async deploy() {
    const namespace = this.config.namespace || 'gloo-mesh';
    const segmentName = this.config.segmentName;
    const aliases = this.config.aliases;

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Deploying GlobalAlias feature: ${segmentName}`, 'info');
    this.log(`  Namespace: ${namespace}`, 'info');
    this.log(`  Aliases: ${aliases.map(a => a.pattern).join(', ')}`, 'info');

    // Build the JSON merge patch
    const patch = {
      spec: {
        config: {
          dns: {
            aliases: aliases,
          },
        },
      },
    };

    const patchJson = JSON.stringify(patch);

    for (const context of contextsToDeploy) {
      const contextFlag = context ? `--context=${context}` : '';
      const contextInfo = context ? ` (context: ${context})` : '';

      this.log(`Patching Segment ${segmentName} with aliases${contextInfo}...`, 'info');
      try {
        await CommandRunner.exec(
          `kubectl ${contextFlag} patch segment ${segmentName} -n ${namespace} --type=merge -p '${patchJson}'`
        );
      } catch (error) {
        this.log(`Warning: Could not patch segment: ${error.message}`, 'warn');
      }
    }
  }

  async cleanup() {
    const namespace = this.config.namespace || 'gloo-mesh';
    const segmentName = this.config.segmentName;

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Cleaning up GlobalAlias feature: ${segmentName}`, 'info');

    // Remove aliases by patching with empty array
    const patch = JSON.stringify({ spec: { config: { dns: { aliases: [] } } } });

    for (const context of contextsToDeploy) {
      const contextFlag = context ? `--context=${context}` : '';

      try {
        await CommandRunner.exec(
          `kubectl ${contextFlag} patch segment ${segmentName} -n ${namespace} --type=merge -p '${patch}'`
        );
      } catch {
        /* ignore */
      }
    }
  }
}

export function createGlobalAliasFeature(config) {
  return new GlobalAliasFeature('global-alias', config);
}
