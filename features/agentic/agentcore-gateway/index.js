import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import yaml from 'js-yaml';
import { Feature } from '../../../src/lib/feature.js';
import { ArctlHelper } from '../../../src/lib/arctl.js';

/**
 * AgentcoreGatewayFeature
 *
 * Creates a managed AgentCore Gateway inside the customer VPC. The gateway
 * provisions an EC2 instance running the agentgateway binary in a private
 * subnet, validates JWT tokens via a remote JWKS endpoint, and routes
 * agent traffic to AgentCore runtimes without exposing MCP servers publicly.
 *
 * Applies: Gateway (ar.dev/v1alpha1)
 *
 * Reference: https://docs.solo.io/agentregistry/latest/quickstart/agentcore/#create-gateway
 *
 * Configuration:
 * {
 *   gatewayName: string,          // Gateway resource name (default: 'gateway-agentcore')
 *   runtimeName: string,          // BedrockAgentCore Runtime name in agentregistry (required)
 *   networkId: string,            // AWS VPC ID (required)
 *   subnetId: string,             // Single private subnet ID (required)
 *   securityGroupIds: string[],   // Security groups for agent/MCP communication (required)
 *   sts: {
 *     allowedSubjectClaims: string[], // JWT claims to pass through (default: ['Groups'])
 *     keycloakHostname: string,   // Keycloak hostname — JWKS URL computed from this
 *     keycloakTlsEnabled: bool,   // Whether Keycloak uses HTTPS (default: true)
 *     realm: string,              // Keycloak realm (default: 'agentregistry')
 *     jwksUrl: string,            // Explicit JWKS URL (overrides keycloakHostname)
 *   },
 *   arctl: {
 *     version: string,             // arctl version override
 *     registryUrl: string,         // AgentRegistry URL (required)
 *     keycloakHostname: string,    // Keycloak hostname — issuer URL computed from this
 *     keycloakTlsEnabled: boolean, // Whether Keycloak uses HTTPS (default: true)
 *     realm: string,               // Keycloak realm (default: 'agentregistry')
 *     clientId: string,            // OIDC client ID (default: 'ar-cli')
 *   }
 * }
 */
export class AgentcoreGatewayFeature extends Feature {
  constructor(name, config = {}) {
    super(name, config);
    this.gatewayName = config.gatewayName || 'gateway-agentcore';
    this.runtimeName = config.runtimeName;
    this.networkId = config.networkId || null;
    this.subnetId = config.subnetId || null;
    this.securityGroupIds = config.securityGroupIds || [];

    const sts = config.sts || {};
    this.stsAllowedSubjectClaims = sts.allowedSubjectClaims || ['Groups'];
    if (sts.jwksUrl) {
      this.stsJwksUrl = sts.jwksUrl;
    } else if (sts.keycloakHostname) {
      const scheme = sts.keycloakTlsEnabled !== false ? 'https' : 'http';
      const realm = sts.realm || 'agentregistry';
      this.stsJwksUrl = `${scheme}://${sts.keycloakHostname}/realms/${realm}/protocol/openid-connect/certs`;
    } else {
      this.stsJwksUrl = null;
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
    if (!this.runtimeName) throw new Error('agentcore-gateway: runtimeName is required');
    if (!this.networkId) throw new Error('agentcore-gateway: networkId is required');
    if (!this.subnetId) throw new Error('agentcore-gateway: subnetId is required');
    if (!this.securityGroupIds?.length)
      throw new Error('agentcore-gateway: securityGroupIds is required');
    if (!this.stsJwksUrl)
      throw new Error('agentcore-gateway: sts.keycloakHostname or sts.jwksUrl is required');
    if (!this.arctlRegistryUrl) throw new Error('agentcore-gateway: arctl.registryUrl is required');
    if (!this.arctlOidcIssuerUrl)
      throw new Error(
        'agentcore-gateway: arctl.keycloakHostname or arctl.oidcIssuerUrl is required'
      );
    return true;
  }

  buildManifest() {
    const gateway = {
      apiVersion: 'ar.dev/v1alpha1',
      kind: 'Gateway',
      metadata: { name: this.gatewayName },
      spec: {
        runtimeId: this.runtimeName,
        networkId: this.networkId,
        subnetId: this.subnetId,
        mode: 'managed',
        sts: {
          allowedSubjectClaims: this.stsAllowedSubjectClaims,
          subjectValidator: { remote: this.stsJwksUrl },
        },
        aws: {
          agentCoreRuntimeSecurityGroupIds: this.securityGroupIds,
        },
      },
    };
    return yaml.dump(gateway, { lineWidth: -1, indent: 2 });
  }

  async deploy() {
    this.validate();

    await ArctlHelper.resolve({ version: this.arctlVersion });

    const tempFile = join(tmpdir(), `agentcore-gateway-${this.gatewayName}-${Date.now()}.yaml`);
    try {
      await writeFile(tempFile, this.buildManifest(), 'utf8');

      this.log(
        `Creating AgentCore managed gateway "${this.gatewayName}" (runtime: ${this.runtimeName})`
      );

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

      this.log(
        `Gateway "${this.gatewayName}" created — provisioning EC2 in VPC ${this.networkId} (may take 5-10 min)`,
        'success'
      );
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
        await ArctlHelper.deviceLoginAndExec(['delete', 'gateway', this.gatewayName], loginOptions);
        this.log(`Gateway "${this.gatewayName}" removed`, 'success');
      } catch {
        /* best-effort */
      }
    } finally {
      if (this.spinner && spinnerText) this.spinner.start(spinnerText);
    }
  }
}
