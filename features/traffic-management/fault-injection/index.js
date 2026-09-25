import { Feature } from '../../../src/lib/feature.js';

/**
 * Fault Injection Feature (Gateway API)
 *
 * Deploys fault injection via HTTPRoute filters through a waypoint proxy.
 * Supports both abort (error) and delay injection using Istio's HTTPRoute extensions.
 *
 * For ambient mode with waypoints, faults are injected as VirtualService
 * attached to the waypoint, since Gateway API HTTPRoute doesn't yet have
 * native fault injection filters.
 *
 * Configuration:
 * {
 *   routeName: string,           // Required: Route/VirtualService name
 *   namespace: string,           // Required: Namespace
 *   host: string,                // Required: Target service host
 *   faultType: 'abort'|'delay',  // Required: Type of fault injection
 *   abort: {                     // Required if faultType is 'abort'
 *     httpStatus: number,        // HTTP status code to inject
 *     percentage: number,        // Percentage of requests to fault (0-100)
 *   },
 *   delay: {                     // Required if faultType is 'delay'
 *     fixedDelay: string,        // Delay duration (e.g. '5s')
 *     percentage: number,        // Percentage of requests to delay (0-100)
 *   },
 *   destination: {               // Optional: Route destination overrides
 *     host: string,
 *     port: number,
 *   },
 * }
 */
export class FaultInjectionFeature extends Feature {
  validate() {
    if (!this.config.routeName) {
      throw new Error('routeName is required for FaultInjection feature');
    }
    if (!this.config.namespace) {
      throw new Error('namespace is required for FaultInjection feature');
    }
    if (!this.config.host) {
      throw new Error('host is required for FaultInjection feature');
    }
    if (!this.config.faultType) {
      throw new Error('faultType (abort|delay) is required for FaultInjection feature');
    }
    if (this.config.faultType === 'abort' && !this.config.abort) {
      throw new Error('abort config is required when faultType is abort');
    }
    if (this.config.faultType === 'delay' && !this.config.delay) {
      throw new Error('delay config is required when faultType is delay');
    }
    return true;
  }

  async deploy() {
    const namespace = this.config.namespace;
    const routeName = this.config.routeName;
    const host = this.config.host;

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Deploying FaultInjection feature: ${routeName}`, 'info');
    this.log(`  Namespace: ${namespace}`, 'info');
    this.log(`  Fault type: ${this.config.faultType}`, 'info');

    for (const context of contextsToDeploy) {
      await this.ensureNamespace(namespace, context);
    }

    // Build fault config
    const fault = {};
    if (this.config.faultType === 'abort') {
      fault.abort = {
        httpStatus: this.config.abort.httpStatus || 500,
        percentage: {
          value: this.config.abort.percentage || 100,
        },
      };
    } else if (this.config.faultType === 'delay') {
      fault.delay = {
        fixedDelay: this.config.delay.fixedDelay || '5s',
        percentage: {
          value: this.config.delay.percentage || 100,
        },
      };
    }

    // Build destination
    const destHost = this.config.destination?.host || host;
    const route = [{ destination: { host: destHost } }];
    if (this.config.destination?.port) {
      route[0].destination.port = { number: this.config.destination.port };
    }

    const virtualService = {
      apiVersion: 'networking.istio.io/v1beta1',
      kind: 'VirtualService',
      metadata: {
        name: routeName,
        namespace: namespace,
      },
      spec: {
        hosts: [host],
        http: [
          {
            fault: fault,
            route: route,
          },
        ],
      },
    };

    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';
      this.log(`Applying fault injection VirtualService: ${routeName}${contextInfo}...`, 'info');
      await this.applyResource(virtualService, context);
    }
  }

  async cleanup() {
    const routeName = this.config.routeName;
    const namespace = this.config.namespace;

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Cleaning up FaultInjection feature: ${routeName}`, 'info');

    for (const context of contextsToDeploy) {
      const contextInfo = context ? ` (context: ${context})` : '';
      this.log(`Deleting VirtualService: ${routeName}${contextInfo}...`, 'info');
      await this.deleteResource('virtualservice', routeName, namespace, context);
    }
  }
}

export function createFaultInjectionFeature(config) {
  return new FaultInjectionFeature('fault-injection', config);
}
