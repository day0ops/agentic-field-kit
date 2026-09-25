import { Feature } from '../../../src/lib/feature.js';

/**
 * AccessPolicyTestHarnessFeature
 *
 * Deploys one tiny HTTP test-harness Deployment+Service per configured
 * identity, each running under an EXISTING ServiceAccount (reused, not
 * created) so a demo can prove a kagent AccessPolicy really discriminates by
 * real caller identity -- calling a target MCP server directly (no gateway
 * hop, so the SPIFFE identity presented is the reused ServiceAccount's own,
 * never flattened to a gateway's identity the way a gateway-routed call
 * would be) and reporting whether the call was allowed or denied.
 *
 * Deploys into an EXISTING namespace (e.g. an addon-owned namespace like
 * kagent-system) -- unlike most features, this never creates or labels the
 * namespace itself; it's assumed to already exist and already be
 * Ambient-enabled by whatever owns it.
 *
 * Configuration:
 * {
 *   namespace: string,        // Required -- existing namespace to deploy into
 *   image: string,            // Required -- harness container image
 *   imagePullPolicy: string,  // Default: 'IfNotPresent'
 *   port: number,             // Default: 8080
 *   targetUrl: string,        // Required -- MCP server URL every harness Deployment calls
 *   targetUrlEnvVar: string,  // Default: 'RETURNS_ELIGIBILITY_URL' -- env var name the harness
 *                             // binary reads for the target URL (matches the current
 *                             // retail-returns-agent-system harness image; override if a
 *                             // different harness image expects a different name)
 *   identities: [{            // Required, non-empty -- one Deployment+Service per entry
 *     name: string,           // Required -- object name suffix + IDENTITY env var value
 *     serviceAccountName: string, // Required -- EXISTING ServiceAccount to run under
 *   }],
 * }
 */
export class AccessPolicyTestHarnessFeature extends Feature {
  constructor(name, config = {}) {
    super(name, config);
    this.image = config.image;
    this.imagePullPolicy = config.imagePullPolicy || 'IfNotPresent';
    this.port = config.port || 8080;
    this.targetUrl = config.targetUrl;
    this.targetUrlEnvVar = config.targetUrlEnvVar || 'RETURNS_ELIGIBILITY_URL';
    this.identities = config.identities || [];
  }

  validate() {
    if (!this.namespace) throw new Error('access-policy-test-harness: namespace is required');
    if (!this.image) throw new Error('access-policy-test-harness: image is required');
    if (!this.targetUrl) throw new Error('access-policy-test-harness: targetUrl is required');
    if (this.identities.length === 0)
      throw new Error('access-policy-test-harness: identities is required (non-empty)');
    for (const identity of this.identities) {
      if (!identity.name)
        throw new Error('access-policy-test-harness: identities[].name is required');
      if (!identity.serviceAccountName)
        throw new Error('access-policy-test-harness: identities[].serviceAccountName is required');
    }
    return true;
  }

  labels() {
    return {
      'app.kubernetes.io/managed-by': 'agentic-demo',
      'agentic.demo/feature': this.name,
    };
  }

  objectName(identityName) {
    return `access-policy-harness-${identityName}`;
  }

  buildDeployment(identity) {
    const name = this.objectName(identity.name);
    return {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name, namespace: this.namespace, labels: { ...this.labels(), app: name } },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: name } },
        template: {
          metadata: { labels: { app: name } },
          spec: {
            serviceAccountName: identity.serviceAccountName,
            containers: [
              {
                name: 'harness',
                image: this.image,
                imagePullPolicy: this.imagePullPolicy,
                ports: [{ containerPort: this.port }],
                env: [
                  { name: 'IDENTITY', value: identity.name },
                  { name: this.targetUrlEnvVar, value: this.targetUrl },
                ],
                resources: {
                  requests: { memory: '32Mi', cpu: '25m' },
                  limits: { memory: '64Mi', cpu: '100m' },
                },
                readinessProbe: {
                  tcpSocket: { port: this.port },
                  initialDelaySeconds: 3,
                  periodSeconds: 10,
                },
                livenessProbe: {
                  tcpSocket: { port: this.port },
                  initialDelaySeconds: 10,
                  periodSeconds: 30,
                },
              },
            ],
          },
        },
      },
    };
  }

  buildService(identity) {
    const name = this.objectName(identity.name);
    return {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name, namespace: this.namespace, labels: { ...this.labels(), app: name } },
      spec: {
        selector: { app: name },
        ports: [{ name: 'http', port: this.port, targetPort: this.port, appProtocol: 'http' }],
        type: 'ClusterIP',
      },
    };
  }

  async deploy() {
    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];
    for (const context of contextsToDeploy) {
      for (const identity of this.identities) {
        await this.applyResource(this.buildDeployment(identity), context);
        await this.applyResource(this.buildService(identity), context);
      }
    }
    this.log(
      `access-policy-test-harness deployed: ${this.identities.map(i => i.name).join(', ')} (namespace '${this.namespace}')`,
      'success'
    );
  }

  async cleanup() {
    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];
    for (const context of contextsToDeploy) {
      for (const identity of this.identities) {
        const name = this.objectName(identity.name);
        await this.deleteResource('Deployment', name, this.namespace, context);
        await this.deleteResource('Service', name, this.namespace, context);
      }
    }
    this.log('access-policy-test-harness cleaned up', 'success');
  }
}
