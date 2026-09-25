import { Feature } from '../../../src/lib/feature.js';
import { CommandRunner } from '../../../src/lib/common.js';

/**
 * Istiod Metrics Feature
 *
 * Inspection feature that port-forwards to istiod pods and scrapes metrics.
 * Does not deploy persistent resources — used for observability verification.
 *
 * Configuration:
 * {
 *   namespace: string,            // Optional: Istiod namespace (default: 'istio-system')
 *   metricsPort: number,          // Optional: Metrics port (default: 15014)
 * }
 */
export class IstiodMetricsFeature extends Feature {
  validate() {
    return true;
  }

  async deploy() {
    const namespace = this.config.namespace || 'istio-system';
    const metricsPort = this.config.metricsPort || 15014;

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Deploying IstiodMetrics feature (inspection)`, 'info');
    this.log(`  Namespace: ${namespace}`, 'info');
    this.log(`  Metrics port: ${metricsPort}`, 'info');

    for (const context of contextsToDeploy) {
      const contextFlag = context ? `--context=${context}` : '';
      const contextInfo = context ? ` (context: ${context})` : '';

      // Verify istiod pods exist
      this.log(`Checking istiod pods${contextInfo}...`, 'info');
      try {
        const result = await CommandRunner.exec(
          `kubectl ${contextFlag} get pods -n ${namespace} -l app=istiod -o name`
        );
        const pods = result.stdout.trim().split('\n').filter(Boolean);
        this.log(`  Found ${pods.length} istiod pod(s)`, 'info');

        if (pods.length > 0) {
          const podName = pods[0].replace('pod/', '');
          this.log(`Fetching metrics from ${podName}${contextInfo}...`, 'info');
          try {
            await CommandRunner.exec(
              `kubectl ${contextFlag} exec -n ${namespace} ${podName} -- curl -s localhost:${metricsPort}/metrics | head -50`
            );
            this.log(`  Metrics sample retrieved successfully`, 'success');
          } catch (error) {
            this.log(`Warning: Could not fetch metrics: ${error.message}`, 'warn');
          }
        }
      } catch (error) {
        this.log(`Warning: Could not find istiod pods: ${error.message}`, 'warn');
      }
    }
  }

  async cleanup() {
    // Inspection feature — nothing to clean up
    this.log(`IstiodMetrics is an inspection feature — nothing to clean up`, 'info');
  }
}

export function createIstiodMetricsFeature(config) {
  return new IstiodMetricsFeature('istiod-metrics', config);
}
