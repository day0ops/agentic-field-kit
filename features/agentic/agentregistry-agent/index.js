import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import yaml from 'js-yaml';
import { Feature } from '../../../src/lib/feature.js';
import { ArctlHelper } from '../../../src/lib/arctl.js';

/**
 * AgentregistryAgentFeature
 *
 * Publishes an agent to AgentRegistry and deploys it against a named Runtime by applying:
 *   - Agent      (ar.dev/v1alpha1) — catalog entry with name, title, description, image, entrypoint
 *   - Deployment (ar.dev/v1alpha1): binds the Agent to a Runtime via runtimeRef + runtimeConfig
 *
 * Runtime-agnostic: the same Agent/Deployment shape works whether runtimeName points at a
 * `type: Kagent` Runtime (deploys a native kagent.dev BYO Agent, image required) or a
 * `type: BedrockAgentCore` Runtime (deploys to AWS, repositoryUrl required) -- AgentRegistry's
 * backend does the actual translation based on which Runtime the Deployment references.
 *
 * Uses arctl device-authorization login (interactive, user opens browser URL).
 *
 * Reference: https://docs.solo.io/agentregistry/latest/quickstart/agentcore/
 *
 * Configuration:
 * {
 *   agentName: string,            // Agent name in catalog (required)
 *   title: string,                // Display title (default: agentName)
 *   description: string,          // Agent description (optional)
 *   // Source: one of image (Kagent runtimes) or repository (BedrockAgentCore runtimes):
 *   image: string,                // Container image, for Kagent runtimes
 *   repositoryUrl: string,        // GitHub repo clone URL, for BedrockAgentCore (builds from source)
 *   repositoryBranch: string,     // Git branch (default: 'main')
 *   repositorySubfolder: string,  // Subfolder within repo (optional)
 *   entrypoint: string,           // Container entrypoint (default: 'uv run python main.py')
 *   runtimeName: string,          // Runtime name in agentregistry (required)
 *   region: string,               // AWS region for runtimeConfig (required)
 *   networkMode: string,          // 'vpc' or 'public' (default: 'vpc')
 *   workdir: string,              // Working directory (default: 'agentregistry/<agentName>')
 *   subnetIds: string[],          // VPC subnet IDs (required for networkMode: vpc)
 *   securityGroupIds: string[],   // VPC security group IDs (required for networkMode: vpc)
 *   deploymentRefs: string[],     // Names of MCP Deployment resources to link (optional)
 *   env: object,                  // Environment variables injected into the agent (optional)
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
export class AgentregistryAgentFeature extends Feature {
  constructor(name, config = {}) {
    super(name, config);
    this.agentName = config.agentName;
    this.title = config.title || config.agentName;
    this.description = config.description || '';
    this.repositoryUrl = config.repositoryUrl || null;
    this.repositoryBranch = config.repositoryBranch || 'main';
    this.repositorySubfolder = config.repositorySubfolder || null;
    this.image = config.image || null;
    this.entrypoint = config.entrypoint || 'uv run python main.py';
    this.runtimeName = config.runtimeName || config.platformId; // platformId kept for compat
    this.region = config.region;
    this.networkMode = config.networkMode || null;
    this.workdir = config.workdir || null;
    this.subnetIds = config.subnetIds || [];
    this.securityGroupIds = config.securityGroupIds || [];
    this.deploymentRefs = config.deploymentRefs || [];
    this.env = config.env || {};

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
    if (!this.agentName) throw new Error('agentregistry-agent: agentName is required');
    if (!this.repositoryUrl && !this.image)
      throw new Error(
        'agentregistry-agent: repositoryUrl (BedrockAgentCore) or image (Kagent) is required'
      );
    if (!this.runtimeName)
      throw new Error('agentregistry-agent: runtimeName (or platformId) is required');
    if (!this.region) throw new Error('agentregistry-agent: region is required');
    if (!this.arctlRegistryUrl)
      throw new Error('agentregistry-agent: arctl.registryUrl is required');
    if (!this.arctlOidcIssuerUrl)
      throw new Error(
        'agentregistry-agent: arctl.keycloakHostname or arctl.oidcIssuerUrl is required'
      );
    return true;
  }

  buildManifest() {
    const agent = {
      apiVersion: 'ar.dev/v1alpha1',
      kind: 'Agent',
      metadata: { name: this.agentName },
      spec: {
        title: this.title,
        ...(this.description && { description: this.description }),
        source: this.repositoryUrl
          ? {
              repository: {
                url: this.repositoryUrl,
                branch: this.repositoryBranch,
                ...(this.repositorySubfolder && { subfolder: this.repositorySubfolder }),
              },
            }
          : { image: this.image },
        entrypoint: this.entrypoint,
      },
    };

    const runtimeConfig = {
      region: this.region,
      ...(this.workdir && { workdir: this.workdir }),
      ...(this.networkMode && { networkMode: this.networkMode }),
      ...(this.subnetIds?.length > 0 && { subnetIds: this.subnetIds }),
      ...(this.securityGroupIds?.length > 0 && { securityGroupIds: this.securityGroupIds }),
    };

    const deployment = {
      apiVersion: 'ar.dev/v1alpha1',
      kind: 'Deployment',
      metadata: { name: this.agentName },
      spec: {
        targetRef: { kind: 'Agent', name: this.agentName },
        runtimeRef: { kind: 'Runtime', name: this.runtimeName },
        ...(this.deploymentRefs?.length > 0 && {
          deploymentRefs: this.deploymentRefs.map(n => ({ name: n })),
        }),
        ...(Object.keys(this.env).length > 0 && { env: this.env }),
        runtimeConfig,
      },
    };

    return (
      yaml.dump(agent, { lineWidth: -1, indent: 2 }) +
      '---\n' +
      yaml.dump(deployment, { lineWidth: -1, indent: 2 })
    );
  }

  async deploy() {
    this.validate();

    await ArctlHelper.resolve({ version: this.arctlVersion });

    const tempFile = join(tmpdir(), `agentregistry-agent-${this.agentName}-${Date.now()}.yaml`);
    try {
      await writeFile(tempFile, this.buildManifest(), 'utf8');

      this.log(`Deploying agent "${this.agentName}" via runtime "${this.runtimeName}"`);

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

      this.log(`Agent "${this.agentName}" deployed`, 'success');
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
          ['delete', 'deployment', this.agentName],
          loginOptions
        );
      } catch {
        /* best-effort */
      }

      try {
        await ArctlHelper.deviceLoginAndExec(['delete', 'agent', this.agentName], loginOptions);
      } catch {
        /* best-effort */
      }

      this.log(`Agent "${this.agentName}" removed from agentregistry`, 'success');
    } finally {
      if (this.spinner && spinnerText) this.spinner.start(spinnerText);
    }
  }
}
