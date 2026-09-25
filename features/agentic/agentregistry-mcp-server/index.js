import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import yaml from 'js-yaml';
import { Feature } from '../../../src/lib/feature.js';
import { ArctlHelper } from '../../../src/lib/arctl.js';

/**
 * AgentregistryMcpServerFeature
 *
 * Publishes an MCP server to AgentRegistry's catalog and deploys it against a
 * named Kagent Runtime by applying:
 *   - MCPServer (ar.dev/v1alpha1) — catalog entry with name, title, image, transport
 *   - Deployment (ar.dev/v1alpha1) — binds the MCPServer to a Runtime via runtimeRef
 *
 * Distinct from the `agentregistry-catalog` feature, which only registers an
 * already-running Service's URL (spec.remote.url) as routing metadata over an
 * existing workload. This feature's MCPServer instead carries
 * spec.source.package (a real OCI image reference + transport), so
 * AgentRegistry provisions the pod itself on the target Kagent Runtime — the
 * MCP-server equivalent of `agentregistry-agent`.
 *
 * spec.source.image (a flat shorthand) is NOT a valid field on this API — it
 * is silently accepted and discarded server-side (confirmed live: `arctl
 * apply` reports success but the stored resource comes back with
 * `source: {}`). The nested spec.source.package.origin/transport shape below
 * is the only shape that actually persists the image reference.
 *
 * Reference: https://docs.solo.io/agentregistry/latest/mcp/local/publish/
 *            https://docs.solo.io/agentregistry/latest/mcp/local/deploy/kagent/
 *
 * Configuration:
 * {
 *   serverName: string,      // MCPServer name in catalog (required)
 *   title: string,           // Display title (default: serverName)
 *   description: string,     // Optional
 *   image: string,           // Container image (required)
 *   transportType: string,   // Default: 'http'
 *   port: number,            // Container port the MCP server listens on (required)
 *   path: string,            // MCP endpoint path (default: '/mcp')
 *   launchCommand: string,   // Optional — only needed if the image's own
 *                            // ENTRYPOINT/CMD doesn't already start the server
 *   launchArgs: string[],    // Optional positional args for launchCommand
 *   runtimeName: string,     // Kagent Runtime name in agentregistry (required)
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
export class AgentregistryMcpServerFeature extends Feature {
  constructor(name, config = {}) {
    super(name, config);
    this.serverName = config.serverName;
    this.title = config.title || config.serverName;
    this.description = config.description || '';
    this.image = config.image || null;
    this.transportType = config.transportType || 'http';
    this.port = config.port || null;
    this.path = config.path || '/mcp';
    this.launchCommand = config.launchCommand || null;
    this.launchArgs = config.launchArgs || [];
    this.runtimeName = config.runtimeName;

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
    if (!this.serverName) throw new Error('agentregistry-mcp-server: serverName is required');
    if (!this.image) throw new Error('agentregistry-mcp-server: image is required');
    if (!this.port) throw new Error('agentregistry-mcp-server: port is required');
    if (!this.runtimeName) throw new Error('agentregistry-mcp-server: runtimeName is required');
    if (!this.arctlRegistryUrl)
      throw new Error('agentregistry-mcp-server: arctl.registryUrl is required');
    if (!this.arctlOidcIssuerUrl)
      throw new Error(
        'agentregistry-mcp-server: arctl.keycloakHostname or arctl.oidcIssuerUrl is required'
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
        source: {
          package: {
            origin: {
              type: 'oci',
              identifier: this.image,
              oci: { serverName: this.serverName },
            },
            transport: {
              type: this.transportType,
              port: this.port,
              path: this.path,
            },
            ...(this.launchCommand && {
              launch: {
                command: this.launchCommand,
                args: this.launchArgs.map(value => ({ type: 'positional', value })),
              },
            }),
          },
        },
      },
    };

    const deployment = {
      apiVersion: 'ar.dev/v1alpha1',
      kind: 'Deployment',
      metadata: { name: this.serverName },
      spec: {
        targetRef: { kind: 'MCPServer', name: this.serverName },
        runtimeRef: { kind: 'Runtime', name: this.runtimeName },
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

    const tempFile = join(
      tmpdir(),
      `agentregistry-mcp-server-${this.serverName}-${Date.now()}.yaml`
    );
    try {
      await writeFile(tempFile, this.buildManifest(), 'utf8');

      this.log(`Deploying MCP server "${this.serverName}" via runtime "${this.runtimeName}"`);

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

      this.log(`MCP server "${this.serverName}" deployed`, 'success');
    } finally {
      try {
        await unlink(tempFile);
      } catch {
        /* ignore */
      }
    }
  }

  async cleanup() {
    const loginOptions = {
      registryUrl: this.arctlRegistryUrl,
      oidcIssuerUrl: this.arctlOidcIssuerUrl,
      oidcClientId: this.arctlClientId,
      version: this.arctlVersion,
    };

    const spinnerText = this.spinner?.text;
    this.spinner?.stop();

    try {
      try {
        await ArctlHelper.deviceLoginAndExec(
          ['delete', 'deployment', this.serverName],
          loginOptions
        );
      } catch {
        /* best-effort */
      }

      try {
        await ArctlHelper.deviceLoginAndExec(['delete', 'mcp', this.serverName], loginOptions);
      } catch {
        /* best-effort */
      }

      this.log(`MCP server "${this.serverName}" removed from agentregistry`, 'success');
    } finally {
      if (this.spinner && spinnerText) this.spinner.start(spinnerText);
    }
  }
}
