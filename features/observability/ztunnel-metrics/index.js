import { Feature } from '../../../src/lib/feature.js';
import { CommandRunner } from '../../../src/lib/common.js';

/**
 * Ztunnel Metrics Feature
 *
 * Inspection feature that port-forwards to ztunnel pods and scrapes metrics.
 * Does not deploy persistent resources — used for observability verification.
 *
 * Configuration:
 * {
 *   namespace: string,            // Optional: Ztunnel namespace (default: 'istio-system')
 *   metricsPort: number,          // Optional: Metrics port (default: 15020)
 *   localPort: number,            // Optional: Local port for forwarding (default: 15020)
 * }
 */
export class ZtunnelMetricsFeature extends Feature {
  validate() {
    return true;
  }

  async deploy() {
    const namespace = this.config.namespace || 'istio-system';
    const metricsPort = this.config.metricsPort || 15020;

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Deploying ZtunnelMetrics feature (inspection)`, 'info');
    this.log(`  Namespace: ${namespace}`, 'info');
    this.log(`  Metrics port: ${metricsPort}`, 'info');

    for (const context of contextsToDeploy) {
      const contextFlag = context ? `--context=${context}` : '';
      const contextInfo = context ? ` (context: ${context})` : '';

      // Verify ztunnel pods exist
      this.log(`Checking ztunnel pods${contextInfo}...`, 'info');
      try {
        const result = await CommandRunner.exec(
          `kubectl ${contextFlag} get pods -n ${namespace} -l app=ztunnel -o name`
        );
        const pods = result.stdout.trim().split('\n').filter(Boolean);
        this.log(`  Found ${pods.length} ztunnel pod(s)`, 'info');

        if (pods.length > 0) {
          // Fetch metrics snapshot from the first ztunnel pod
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
        this.log(`Warning: Could not find ztunnel pods: ${error.message}`, 'warn');
      }
    }
  }

  async cleanup() {
    // Inspection feature — nothing to clean up
    this.log(`ZtunnelMetrics is an inspection feature — nothing to clean up`, 'info');
  }
}

export function createZtunnelMetricsFeature(config) {
  return new ZtunnelMetricsFeature('ztunnel-metrics', config);
}
