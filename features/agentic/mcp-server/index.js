import { Feature } from '../../../src/lib/feature.js';
import { KubernetesHelper } from '../../../src/lib/common.js';

/**
 * McpServerFeature
 *
 * Deploys a containerised MCP server (Deployment + Service) into a namespace.
 * Designed for demo MCP backends exposed via agentgateway.
 *
 * Configuration:
 * {
 *   serverName: string,   // Name for Deployment/Service (default: 'mcp-server')
 *   namespace: string,    // Target namespace (default: 'mcp-backend')
 *   image: string,        // Container image — required
 *   port: number,         // Service + container port (default: 3001)
 *   protocol: string,     // appProtocol on Service port (default: 'agentgateway.dev/mcp')
 *   ambient: boolean,     // Label namespace for Ambient mesh (default: true)
 *   env: object,          // Extra env vars as { KEY: value } map (optional)
 * }
 */
export class McpServerFeature extends Feature {
  constructor(name, config = {}) {
    super(name, config);
    this.serverName = config.serverName || 'mcp-server';
    this.namespace = config.namespace || 'mcp-backend';
    this.image = config.image;
    this.port = config.port || 3001;
    this.protocol = config.protocol || 'agentgateway.dev/mcp';
    this.ambient = config.ambient !== false;
    this.extraEnv = config.env || {};
  }

  validate() {
    if (!this.image) throw new Error('mcp-server: image is required');
    return true;
  }

  buildDeployment() {
    const env = [
      { name: 'PORT', value: String(this.port) },
      ...Object.entries(this.extraEnv).map(([name, value]) => ({ name, value: String(value) })),
    ];
    return {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: this.serverName,
        namespace: this.namespace,
        labels: { app: this.serverName },
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: this.serverName } },
        template: {
          metadata: { labels: { app: this.serverName } },
          spec: {
            containers: [
              {
                name: this.serverName,
                image: this.image,
                ports: [{ containerPort: this.port }],
                env,
                readinessProbe: {
                  tcpSocket: { port: this.port },
                  initialDelaySeconds: 10,
                  periodSeconds: 5,
                },
              },
            ],
          },
        },
      },
    };
  }

  buildService() {
    return {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: this.serverName,
        namespace: this.namespace,
        labels: { app: this.serverName },
      },
      spec: {
        selector: { app: this.serverName },
        ports: [
          {
            name: 'mcp',
            protocol: 'TCP',
            port: this.port,
            targetPort: this.port,
            appProtocol: this.protocol,
          },
        ],
        type: 'ClusterIP',
      },
    };
  }

  async deploy() {
    this.validate();

    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];

    for (const context of contextsToDeploy) {
      if (this.ambient) {
        await this.ensureNamespace(this.namespace, context);
      } else {
        await KubernetesHelper.ensureNamespace(this.namespace, null, context);
      }
      this.log(`Deploying MCP server "${this.serverName}" (${this.image})`);
      await this.applyResource(this.buildDeployment(), context);
      await this.applyResource(this.buildService(), context);

      // Wait for pod readiness
      const ctxArgs = context ? [`--context=${context}`] : [];
      try {
        await KubernetesHelper.kubectl([
          ...ctxArgs,
          'wait',
          '--for=condition=Available',
          'deployment',
          this.serverName,
          '-n',
          this.namespace,
          '--timeout=120s',
        ]);
      } catch (err) {
        this.log(`MCP server may not be fully ready: ${err.message}`, 'warn');
      }

      this.log(`MCP server "${this.serverName}" deployed`, 'success');
    }
  }

  async cleanup() {
    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];

    for (const context of contextsToDeploy) {
      await this.deleteResource('deployment', this.serverName, this.namespace, context);
      await this.deleteResource('service', this.serverName, this.namespace, context);
    }
    this.log(`MCP server "${this.serverName}" removed`, 'success');
  }
}
