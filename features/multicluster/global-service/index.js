import { Feature } from '../../../src/lib/feature.js';
import { CommandRunner } from '../../../src/lib/common.js';

/**
 * Global Service Feature
 *
 * Labels Kubernetes services with solo.io/service-scope to control
 * cross-cluster service visibility. This is label-driven (no YAML configs).
 *
 * Configuration:
 * {
 *   namespace: string,            // Required: Namespace containing the services
 *   ensureAmbient: boolean,       // Label the namespace istio.io/dataplane-mode=ambient before
 *                                 // labeling services -- a solo.io/service-scope label has no
 *                                 // effect on a workload whose namespace isn't ambient-enabled,
 *                                 // and *.mesh.internal names don't resolve for callers outside
 *                                 // the ambient mesh either (confirmed live: NXDOMAIN from a
 *                                 // non-ambient namespace vs. a real answer from an ambient one).
 *                                 // Default: true.
 *   services: array,              // Optional: [{name, scope, labels?, annotations?}] -- omit
 *                                 //   when the only goal is making this namespace's own pods
 *                                 //   able to reach OTHER clusters' global services (ensureAmbient
 *                                 //   alone), not exposing any service of its own.
 *                                 //   scope: 'global'|'segment'|'global-only'
 *                                 //   labels: optional key/value map applied to the service
 *                                 //   annotations: optional key/value map applied to the service
 *   deploymentPatches: array,     // Optional: patch env vars on deployments
 *                                 //   [{deployment, container, env: {KEY: value}}]
 * }
 */
function contextArgs(context) {
  return context ? [`--context=${context}`] : [];
}

/** Each key=value pair is its own argv element, so label/annotation values containing spaces or shell metacharacters pass through intact. */
export function buildServiceLabelArgs(context, namespace, serviceName, labels) {
  const pairs = Object.entries(labels).map(([k, v]) => `${k}=${v}`);
  return [
    ...contextArgs(context),
    'label',
    'service',
    serviceName,
    '-n',
    namespace,
    ...pairs,
    '--overwrite',
  ];
}

export function buildServiceAnnotationArgs(context, namespace, serviceName, annotations) {
  const pairs = Object.entries(annotations).map(([k, v]) => `${k}=${v}`);
  return [
    ...contextArgs(context),
    'annotate',
    'service',
    serviceName,
    '-n',
    namespace,
    ...pairs,
    '--overwrite',
  ];
}

/** Removing a label/annotation a resource doesn't have is a no-op in kubectl; label/annotate don't support --ignore-not-found (that's a get/delete-only flag). */
export function buildServiceLabelRemoveArgs(context, namespace, serviceName, keys) {
  return [
    ...contextArgs(context),
    'label',
    'service',
    serviceName,
    '-n',
    namespace,
    ...keys.map(k => `${k}-`),
  ];
}

export function buildServiceAnnotationRemoveArgs(context, namespace, serviceName, keys) {
  return [
    ...contextArgs(context),
    'annotate',
    'service',
    serviceName,
    '-n',
    namespace,
    ...keys.map(k => `${k}-`),
  ];
}

export class GlobalServiceFeature extends Feature {
  validate() {
    if (!this.config.namespace) {
      throw new Error('namespace is required for GlobalService feature');
    }
    const hasServices = this.config.services && this.config.services.length > 0;
    if (!hasServices && this.config.ensureAmbient === false) {
      throw new Error(
        'GlobalService feature requires services and/or ensureAmbient to do anything'
      );
    }
    return true;
  }

  async deploy() {
    const namespace = this.config.namespace;
    const services = this.config.services || [];
    const ensureAmbient = this.config.ensureAmbient !== false;

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Deploying GlobalService feature`, 'info');
    this.log(`  Namespace: ${namespace}`, 'info');
    if (services.length > 0) {
      this.log(
        `  Services: ${services.map(s => `${s.name} (${s.scope || 'global'})`).join(', ')}`,
        'info'
      );
    }

    const deploymentPatches = this.config.deploymentPatches || [];

    for (const context of contextsToDeploy) {
      const contextFlag = context ? `--context=${context}` : '';
      const contextInfo = context ? ` (context: ${context})` : '';

      if (ensureAmbient) {
        this.log(`Labeling namespace ${namespace} for ambient dataplane${contextInfo}...`, 'info');
        try {
          await CommandRunner.exec(
            `kubectl ${contextFlag} label namespace ${namespace} istio.io/dataplane-mode=ambient --overwrite`
          );
        } catch (error) {
          this.log(`Warning: Could not label namespace ${namespace}: ${error.message}`, 'warn');
        }
      }

      for (const svc of services) {
        const scope = svc.scope || 'global';
        this.log(`Labeling service ${svc.name} with scope=${scope}${contextInfo}...`, 'info');
        try {
          await CommandRunner.exec(
            `kubectl ${contextFlag} label service ${svc.name} -n ${namespace} solo.io/service-scope=${scope} --overwrite`
          );
        } catch (error) {
          this.log(`Warning: Could not label service ${svc.name}: ${error.message}`, 'warn');
        }

        if (svc.labels && Object.keys(svc.labels).length > 0) {
          this.log(`Labeling service ${svc.name} with extra labels${contextInfo}...`, 'info');
          try {
            await CommandRunner.run(
              'kubectl',
              buildServiceLabelArgs(context, namespace, svc.name, svc.labels)
            );
          } catch (error) {
            this.log(
              `Warning: Could not apply labels to service ${svc.name}: ${error.message}`,
              'warn'
            );
          }
        }

        if (svc.annotations && Object.keys(svc.annotations).length > 0) {
          this.log(`Annotating service ${svc.name}${contextInfo}...`, 'info');
          try {
            await CommandRunner.run(
              'kubectl',
              buildServiceAnnotationArgs(context, namespace, svc.name, svc.annotations)
            );
          } catch (error) {
            this.log(`Warning: Could not annotate service ${svc.name}: ${error.message}`, 'warn');
          }
        }
      }

      for (const patch of deploymentPatches) {
        if (!patch.env || Object.keys(patch.env).length === 0) continue;
        const envArgs = Object.entries(patch.env)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ');
        this.log(`Patching deployment ${patch.deployment} env${contextInfo}...`, 'info');
        try {
          await CommandRunner.exec(
            `kubectl ${contextFlag} set env deployment/${patch.deployment} -n ${namespace} ${envArgs}`
          );
        } catch (error) {
          this.log(
            `Warning: Could not patch deployment ${patch.deployment}: ${error.message}`,
            'warn'
          );
        }
      }
    }
  }

  async cleanup() {
    const namespace = this.config.namespace;
    const services = this.config.services || [];
    const deploymentPatches = this.config.deploymentPatches || [];

    const contextsToDeploy =
      this.clusterContexts && this.clusterContexts.length > 0
        ? this.clusterContexts.map(c => c.context)
        : [null];

    this.log(`Cleaning up GlobalService feature`, 'info');

    for (const context of contextsToDeploy) {
      const contextFlag = context ? `--context=${context}` : '';

      for (const svc of services) {
        try {
          await CommandRunner.run(
            'kubectl',
            buildServiceLabelRemoveArgs(context, namespace, svc.name, ['solo.io/service-scope'])
          );
        } catch {
          /* ignore */
        }

        if (svc.labels && Object.keys(svc.labels).length > 0) {
          try {
            await CommandRunner.run(
              'kubectl',
              buildServiceLabelRemoveArgs(context, namespace, svc.name, Object.keys(svc.labels))
            );
          } catch {
            /* ignore */
          }
        }

        if (svc.annotations && Object.keys(svc.annotations).length > 0) {
          try {
            await CommandRunner.run(
              'kubectl',
              buildServiceAnnotationRemoveArgs(
                context,
                namespace,
                svc.name,
                Object.keys(svc.annotations)
              )
            );
          } catch {
            /* ignore */
          }
        }
      }

      for (const patch of deploymentPatches) {
        if (!patch.env || Object.keys(patch.env).length === 0) continue;
        // Remove env vars by appending '-' to each key
        const envRemoveArgs = Object.keys(patch.env)
          .map(k => `${k}-`)
          .join(' ');
        try {
          await CommandRunner.exec(
            `kubectl ${contextFlag} set env deployment/${patch.deployment} -n ${namespace} ${envRemoveArgs}`
          );
        } catch {
          /* ignore */
        }
      }
    }
  }
}

export function createGlobalServiceFeature(config) {
  return new GlobalServiceFeature('global-service', config);
}
