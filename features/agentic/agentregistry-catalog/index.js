import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import yaml from 'js-yaml';
import { Feature } from '../../../src/lib/feature.js';
import { ArctlHelper } from '../../../src/lib/arctl.js';

const DEPLOYMENT_READY_TIMEOUT_MS = 120_000;
const DEPLOYMENT_POLL_INTERVAL_MS = 5_000;

/**
 * AgentregistryCatalogFeature
 *
 * Registers an MCP server in agentregistry by applying:
 *   - MCPServer (ar.dev/v1alpha1) — describes the server and its remote URL
 *   - Deployment  (ar.dev/v1alpha1) — binds MCPServer to a Runtime with a route pathSuffix
 *
 * Uses arctl device-authorization login (interactive, user opens browser URL).
 *
 * Configuration:
 * {
 *   serverName: string,        // MCPServer + Deployment metadata.name (required)
 *   title: string,             // MCPServer spec.title (default: serverName)
 *   description: string,       // MCPServer spec.description (optional)
 *   // URL — either provide explicit url OR service coordinates
 *   url: string,               // Explicit remote URL (overrides service coords)
 *   serviceName: string,       // K8s Service name (default: serverName)
 *   serviceNamespace: string,  // K8s Service namespace (required if no url)
 *   servicePort: number,       // Service port (default: 3001)
 *   mcpPath: string,           // MCP endpoint path (default: '/mcp')
 *   // Deployment
 *   runtimeName: string,       // Runtime to bind to (default: 'mcp-gateway')
 *   pathSuffix: string,        // Route pathSuffix (default: '/<serverName>')
 *   tag: string,               // Deployment tag (default: 'latest')
 *   // arctl auth (same as agentregistry-route)
 *   arctl: {
 *     version: string,             // arctl version (default: v2026.5.3)
 *     registryUrl: string,         // AgentRegistry URL e.g. https://agentregistry.example.com (required)
 *     keycloakHostname: string,    // Keycloak hostname — issuer URL computed from this
 *     keycloakTlsEnabled: boolean, // Whether Keycloak uses HTTPS (default: true)
 *     realm: string,               // Keycloak realm (default: 'agentregistry')
 *     clientId: string,            // OIDC client ID (default: 'ar-cli')
 *   }
 * }
 */
export class AgentregistryCatalogFeature extends Feature {
  constructor(name, config = {}) {
    super(name, config);
    this.serverName = config.serverName;
    this.title = config.title || config.serverName;
    this.description = config.description || '';
    this.runtimeName = config.runtimeName || 'mcp-gateway';
    this.pathSuffix = config.pathSuffix || (config.serverName ? `/${config.serverName}` : null);
    this.tag = config.tag || 'latest';

    // Remote URL: explicit override or computed from service coordinates
    if (config.url) {
      this.remoteUrl = config.url;
    } else {
      const svcName = config.serviceName || config.serverName;
      const svcNs = config.serviceNamespace;
      const svcPort = config.servicePort || 3001;
      const mcpPath = config.mcpPath || '/mcp';
      this.remoteUrl = svcNs
        ? `http://${svcName}.${svcNs}.svc.cluster.local:${svcPort}${mcpPath}`
        : null;
    }

    const arctl = config.arctl || {};
    this.arctlVersion = arctl.version || undefined;
    this.arctlRegistryUrl = arctl.registryUrl;
    this.arctlClientId = arctl.clientId || 'ar-cli';
    if (arctl.keycloakHostname) {
      const scheme = arctl.keycloakTlsEnabled !== false ? 'https' : 'http';
      const realm = arctl.realm || 'agentregistry';
      this.arctlOidcIssuerUrl = `${scheme}://${arctl.keycloakHostname}/realms/${realm}`;
    } else {
      this.arctlOidcIssuerUrl = arctl.oidcIssuerUrl || null;
    }
  }

  validate() {
    if (!this.serverName) throw new Error('agentregistry-catalog: serverName is required');
    if (!this.remoteUrl)
      throw new Error(
        'agentregistry-catalog: url or serviceNamespace is required to compute remote URL'
      );
    if (!this.pathSuffix) throw new Error('agentregistry-catalog: pathSuffix is required');
    if (!this.arctlRegistryUrl)
      throw new Error('agentregistry-catalog: arctl.registryUrl is required');
    if (!this.arctlOidcIssuerUrl)
      throw new Error(
        'agentregistry-catalog: arctl.keycloakHostname or arctl.oidcIssuerUrl is required'
      );
    return true;
  }

  buildManifest() {
    const mcpServer = {
      apiVersion: 'ar.dev/v1alpha1',
      kind: 'MCPServer',
      metadata: { name: this.serverName },
      spec: {
        title: this.title,
        ...(this.description && { description: this.description }),
        remote: {
          type: 'streamable-http',
          url: this.remoteUrl,
        },
      },
    };

    const deployment = {
      apiVersion: 'ar.dev/v1alpha1',
      kind: 'Deployment',
      metadata: { name: this.serverName },
      spec: {
        targetRef: {
          kind: 'MCPServer',
          name: this.serverName,
          tag: this.tag,
        },
        runtimeRef: {
          name: this.runtimeName,
          kind: 'Runtime',
        },
        runtimeConfig: {
          route: {
            pathSuffix: this.pathSuffix,
          },
        },
      },
    };

    return (
      yaml.dump(mcpServer, { lineWidth: -1, indent: 2 }) +
      '---\n' +
      yaml.dump(deployment, { lineWidth: -1, indent: 2 })
    );
  }

  async deploy() {
    this.validate();

    await ArctlHelper.resolve({ version: this.arctlVersion });

    const tempFile = join(tmpdir(), `agentregistry-catalog-${this.serverName}-${Date.now()}.yaml`);
    try {
      await writeFile(tempFile, this.buildManifest(), 'utf8');

      this.log(`Cataloging MCP server "${this.serverName}" in agentregistry (${this.remoteUrl})`);

      const spinnerText = this.spinner?.text;
      this.spinner?.stop();

      try {
        await ArctlHelper.deviceLoginAndApplyFile(tempFile, {
          registryUrl: this.arctlRegistryUrl,
          oidcIssuerUrl: this.arctlOidcIssuerUrl,
          oidcClientId: this.arctlClientId,
          version: this.arctlVersion,
        });
      } finally {
        if (this.spinner && spinnerText) this.spinner.start(spinnerText);
      }

      this.log(`MCP server "${this.serverName}" cataloged in agentregistry`, 'success');
    } finally {
      try {
        await unlink(tempFile);
      } catch {
        /* ignore */
      }
    }
  }

  async #deviceLogin() {
    const { spawn } = await import('child_process');
    const binPath = await ArctlHelper.resolve({ version: this.arctlVersion });
    const bin = binPath.replace(/^"|"$/g, '');
    const spinnerText = this.spinner?.text;
    this.spinner?.stop();
    try {
      await new Promise((resolve, reject) => {
        const proc = spawn(
          bin,
          [
            'user',
            'login',
            '--registry-url',
            this.arctlRegistryUrl,
            '--oidc-issuer-url',
            this.arctlOidcIssuerUrl,
            '--oidc-flow',
            'device-authorization',
            '--oidc-client-id',
            this.arctlClientId,
          ],
          { stdio: 'inherit' }
        );
        proc.on('close', code =>
          code === 0 ? resolve() : reject(new Error(`arctl login failed: exit ${code}`))
        );
        proc.on('error', reject);
      });
    } finally {
      if (this.spinner && spinnerText) this.spinner.start(spinnerText);
    }
  }

  /**
   * Poll `arctl get deployment <name>` until status.conditions[type=Ready].status === "True"
   * or timeout. Logs the exposed URLs when ready.
   */
  async waitForDeployment() {
    this.log(`Waiting for Deployment "${this.serverName}" to be ready...`, 'info');
    const deadline = Date.now() + DEPLOYMENT_READY_TIMEOUT_MS;

    while (Date.now() < deadline) {
      try {
        const out = await ArctlHelper.exec(['get', 'deployment', this.serverName, '-o', 'yaml'], {
          registryUrl: this.arctlRegistryUrl,
          version: this.arctlVersion,
        });
        this.log(`arctl get deployment output:\n${out}`, 'info');
        const obj = yaml.load(out);
        const conditions = obj?.status?.conditions || [];
        const ready = conditions.find(c => c.type === 'Ready');

        if (ready?.status === 'True') {
          this.log(`Deployment "${this.serverName}" ready: ${ready.message}`, 'success');
          const urls = obj?.status?.details?.agentgateway?.exposedAt || [];
          for (const entry of urls) {
            this.log(`  exposed at [${entry.listener}]: ${entry.url}`, 'info');
          }
          return;
        }

        if (ready) {
          this.log(`Deployment not ready yet: ${ready.message || ready.reason}`, 'info');
        }
      } catch (err) {
        const msg = err.message || '';
        if (/session expired|re-authenticate|authentication failed/i.test(msg)) {
          this.log('arctl session expired — re-authenticating...', 'info');
          await this.#deviceLogin();
        } else {
          this.log(`Deployment status check: ${msg}`, 'info');
        }
      }

      await new Promise(r => setTimeout(r, DEPLOYMENT_POLL_INTERVAL_MS));
    }

    this.log(`Deployment "${this.serverName}" did not become ready within timeout`, 'warn');
  }

  async cleanup() {
    // MCPServer/Deployment are agentregistry-managed resources reachable only through
    // its own API (arctl), not Kubernetes CRs -- there is no ar.dev CRD installed on
    // any cluster to kubectl-delete. Mirrors agentregistry-provider's cleanup pattern.
    const loginOptions = {
      registryUrl: this.arctlRegistryUrl,
      oidcIssuerUrl: this.arctlOidcIssuerUrl,
      oidcClientId: this.arctlClientId,
      version: this.arctlVersion,
    };

    const spinnerText = this.spinner?.text;
    this.spinner?.stop();

    try {
      // Delete the Deployment (binding to the Runtime) before the MCPServer it
      // targets, matching the dependency direction -- deleting the MCPServer first
      // fails while a Deployment still references it.
      try {
        await ArctlHelper.deviceLoginAndExec(['delete', 'deployment', this.serverName], loginOptions);
      } catch (err) {
        this.log(`agentregistry-catalog deployment cleanup warning: ${err.message}`, 'warn');
      }

      try {
        await ArctlHelper.deviceLoginAndExec(['delete', 'mcp', this.serverName], loginOptions);
        this.log(`MCP server "${this.serverName}" removed from agentregistry catalog`, 'success');
      } catch (err) {
        this.log(`agentregistry-catalog cleanup warning: ${err.message}`, 'warn');
      }
    } finally {
      if (this.spinner && spinnerText) this.spinner.start(spinnerText);
    }
  }
}
