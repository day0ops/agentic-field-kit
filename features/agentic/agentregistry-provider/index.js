import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import yaml from 'js-yaml';
import { Feature } from '../../../src/lib/feature.js';
import { ArctlHelper } from '../../../src/lib/arctl.js';
import { CommandRunner } from '../../../src/lib/common.js';

/**
 * AgentregistryProviderFeature
 *
 * Registers a compute runtime with AgentRegistry by applying declarative
 * Runtime (and optionally Gateway) manifests via `arctl apply`.
 *
 * Supported runtime types:
 *   - 'kagent'  — applies a Kagent Runtime record
 *   - 'aws'     — applies a BedrockAgentCore Runtime + managed Gateway record
 *
 * Reference: https://docs.solo.io/agentregistry/latest/quickstart/agentcore/#connect-aws
 *
 * Uses arctl device-authorization login (interactive — user opens browser URL).
 *
 * Configuration:
 * {
 *   type: 'kagent' | 'aws',          // Runtime type (required)
 *   providerName: string,             // Runtime name in agentregistry (required)
 *
 *   // kagent-specific:
 *   kagentControllerUrl: string,      // kagent controller URL
 *                                     // (default: 'http://kagent-controller.kagent-system.svc.cluster.local:8083')
 *   kagentNamespace: string,          // Namespace where kagent is running (default: 'kagent-system')
 *   outboundAuth: {                   // Required for type: kagent — agentregistry-enterprise now
 *                                     // requires spec.config.auth.oidc on every kagent Runtime
 *                                     // (outbound service identity AgentRegistry uses to call
 *                                     // kagent-enterprise; distinct from the arctl user-login flow
 *                                     // below). See docs/guides/kagent-enterprise-outbound-auth.md
 *                                     // in agentregistry-enterprise. Same field shape as the
 *                                     // agentregistry addon's kagentOutboundOidc config block —
 *                                     // reuse the same values.
 *     keycloakHostname: string,       // Keycloak hostname — issuer URL computed from this (required)
 *     keycloakTlsEnabled: boolean,    // default: true
 *     realm: string,                  // default: 'kagent'
 *     clientId: string,               // Outbound OIDC client ID (required)
 *     clientSecret: string,           // Outbound OIDC client secret (required) — written to an
 *                                     // AgentRegistry Secret (ar.dev/v1alpha1), not a k8s Secret
 *     scope: string,                  // OAuth2 scope on the client-credentials grant — optional
 *                                     // for Keycloak, required by Microsoft Entra (e.g. 'api://kagent/.default')
 *   },
 *
 *   // aws-specific (Runtime):
 *   roleArn: string,                  // IAM Role ARN from CloudFormation (required)
 *   externalId: string,               // External ID from `arctl runtime setup` output (optional)
 *   region: string,                   // AWS region (required)
 *   telemetryEndpoint: string,        // OTel endpoint e.g. http://<lb>:4318 (optional)
 *
 *   // aws-specific (Gateway — omit to skip Gateway creation):
 *   vpcId: string,                    // VPC ID for the managed Gateway
 *   subnetId: string,                 // Single subnet for the Gateway listener
 *   securityGroupIds: string[],       // Security groups for the Gateway
 *   gatewayName: string,              // Gateway resource name (default: 'gateway-<providerName>')
 *
 *   // arctl auth:
 *   arctl: {
 *     version: string,
 *     registryUrl: string,            // AgentRegistry URL (required)
 *     keycloakHostname: string,       // Keycloak hostname (required)
 *     keycloakTlsEnabled: boolean,    // default: true
 *     realm: string,                  // default: 'agentregistry'
 *     clientId: string,               // default: 'ar-cli'
 *   }
 * }
 */
export class AgentregistryProviderFeature extends Feature {
  constructor(name, config = {}) {
    super(name, config);

    this.type = config.type;
    this.providerName = config.providerName;

    // kagent-specific
    this.kagentControllerUrl =
      config.kagentControllerUrl || 'http://kagent-controller.kagent-system.svc.cluster.local:8083';
    this.kagentNamespace = config.kagentNamespace || 'kagent-system';

    const outboundAuth = config.outboundAuth || {};
    this.outboundAuthClientId = outboundAuth.clientId || null;
    this.outboundAuthClientSecret = outboundAuth.clientSecret || null;
    this.outboundAuthScope = outboundAuth.scope || null;
    if (outboundAuth.keycloakHostname) {
      const scheme = outboundAuth.keycloakTlsEnabled !== false ? 'https' : 'http';
      const realm = outboundAuth.realm || 'kagent';
      this.outboundAuthIssuer = `${scheme}://${outboundAuth.keycloakHostname}/realms/${realm}`;
    } else {
      this.outboundAuthIssuer = outboundAuth.issuer || null;
    }
    this.outboundAuthSecretName = `${config.providerName}-outbound-oidc`;

    // aws Runtime
    this.roleArn = config.roleArn || null;
    this.stackName = config.stackName || null; // CloudFormation stack to fetch roleArn from
    this.externalId = config.externalId || null;
    this.region = config.region || null;
    this.telemetryEndpoint = config.telemetryEndpoint || null;

    // aws Gateway
    this.vpcId = config.vpcId || null;
    this.subnetId = config.subnetId || null;
    this.securityGroupIds = config.securityGroupIds || [];
    this.gatewayName = config.gatewayName || `gateway-${config.providerName}`;

    // arctl auth
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
    if (!this.type) throw new Error('agentregistry-provider: type is required (kagent or aws)');
    if (this.type !== 'kagent' && this.type !== 'aws') {
      throw new Error(
        `agentregistry-provider: unknown type "${this.type}" — must be "kagent" or "aws"`
      );
    }
    if (!this.providerName) throw new Error('agentregistry-provider: providerName is required');
    if (!this.arctlRegistryUrl)
      throw new Error('agentregistry-provider: arctl.registryUrl is required');
    if (!this.arctlOidcIssuerUrl) {
      throw new Error(
        'agentregistry-provider: arctl.keycloakHostname or arctl.oidcIssuerUrl is required'
      );
    }
    if (this.type === 'aws') {
      if (!this.roleArn && !this.stackName) {
        throw new Error('agentregistry-provider: roleArn or stackName is required for type "aws"');
      }
      if (!this.region)
        throw new Error('agentregistry-provider: region is required for type "aws"');
    }
    if (this.type === 'kagent') {
      // agentregistry-enterprise requires spec.config.auth.oidc on every kagent Runtime
      // (see docs/guides/kagent-enterprise-outbound-auth.md) — not optional here, a Runtime
      // applied without it is rejected server-side with a much less clear error.
      if (!this.outboundAuthIssuer)
        throw new Error(
          'agentregistry-provider: outboundAuth.keycloakHostname (or outboundAuth.issuer) is required for type "kagent"'
        );
      if (!this.outboundAuthClientId)
        throw new Error(
          'agentregistry-provider: outboundAuth.clientId is required for type "kagent"'
        );
      if (!this.outboundAuthClientSecret)
        throw new Error(
          'agentregistry-provider: outboundAuth.clientSecret is required for type "kagent"'
        );
    }
    return true;
  }

  /**
   * Build the manifest YAML for arctl apply.
   *
   * For type: kagent  → single Runtime record
   * For type: aws     → Runtime record + Gateway record (when vpcId is set)
   * @returns {string}
   */
  buildManifest() {
    if (this.type === 'kagent') {
      // Two documents: the outbound-auth Secret first, then the Runtime that references it
      // via clientSecretRef — mirrors agentregistry-enterprise's own e2e fixture pattern
      // (test/testutil/declarative.go KagentRuntimeYAML/KagentOutboundSecretYAML).
      const secret = {
        apiVersion: 'ar.dev/v1alpha1',
        kind: 'Secret',
        metadata: { name: this.outboundAuthSecretName },
        spec: {
          type: 'Opaque',
          stringData: { clientSecret: this.outboundAuthClientSecret },
        },
      };

      const runtime = {
        apiVersion: 'ar.dev/v1alpha1',
        kind: 'Runtime',
        metadata: { name: this.providerName },
        spec: {
          type: 'Kagent',
          config: {
            kagentUrl: this.kagentControllerUrl,
            namespace: this.kagentNamespace,
            auth: {
              oidc: {
                issuer: this.outboundAuthIssuer,
                clientId: this.outboundAuthClientId,
                ...(this.outboundAuthScope && { scope: this.outboundAuthScope }),
                clientSecretRef: { name: this.outboundAuthSecretName, key: 'clientSecret' },
              },
            },
          },
        },
      };

      return (
        yaml.dump(secret, { lineWidth: -1, indent: 2 }) +
        '---\n' +
        yaml.dump(runtime, { lineWidth: -1, indent: 2 })
      );
    }

    // type: aws — BedrockAgentCore Runtime
    const runtime = {
      apiVersion: 'ar.dev/v1alpha1',
      kind: 'Runtime',
      metadata: { name: this.providerName },
      spec: {
        type: 'BedrockAgentCore',
        ...(this.telemetryEndpoint && { telemetryEndpoint: this.telemetryEndpoint }),
        config: {
          region: this.region,
          roleArn: this.roleArn,
          ...(this.externalId && { externalId: this.externalId }),
        },
      },
    };

    // Gateway is optional — only created when vpcId is provided
    if (!this.vpcId) {
      return yaml.dump(runtime, { lineWidth: -1, indent: 2 });
    }

    // JWKS URL derived from the Keycloak OIDC issuer
    const jwksUrl = this.arctlOidcIssuerUrl
      ? `${this.arctlOidcIssuerUrl}/protocol/openid-connect/certs`
      : null;

    const gateway = {
      apiVersion: 'ar.dev/v1alpha1',
      kind: 'Gateway',
      metadata: { name: this.gatewayName },
      spec: {
        runtimeId: this.providerName,
        networkId: this.vpcId,
        subnetId: this.subnetId,
        mode: 'managed',
        ...(jwksUrl && {
          sts: {
            allowedSubjectClaims: ['Groups'],
            subjectValidator: { remote: jwksUrl },
          },
        }),
        aws: {
          agentCoreRuntimeSecurityGroupIds: this.securityGroupIds,
        },
      },
    };

    return (
      yaml.dump(runtime, { lineWidth: -1, indent: 2 }) +
      '---\n' +
      yaml.dump(gateway, { lineWidth: -1, indent: 2 })
    );
  }

  async deploy() {
    this.validate();

    // Resolve roleArn from CloudFormation stack if not provided directly
    if (this.type === 'aws' && !this.roleArn && this.stackName) {
      this.log(`Fetching roleArn from CloudFormation stack "${this.stackName}"...`, 'info');
      const regionFlag = this.region ? `--region ${this.region}` : '';
      const result = await CommandRunner.exec(
        `aws cloudformation describe-stacks --stack-name ${this.stackName} ${regionFlag} --query "Stacks[0].Outputs[?OutputKey=='RoleArn'].OutputValue" --output text`,
        { ignoreError: true }
      );
      this.roleArn = result.stdout?.trim() || null;
      if (!this.roleArn) {
        throw new Error(
          `agentregistry-provider: RoleArn not found in CloudFormation stack "${this.stackName}"`
        );
      }
      this.log(`Resolved roleArn: ${this.roleArn}`, 'info');
    }

    await ArctlHelper.resolve({ version: this.arctlVersion });

    if (this.type === 'kagent') {
      this.log(`Registering kagent runtime "${this.providerName}" (${this.kagentControllerUrl})`);
    } else {
      const gatewayMsg = this.vpcId ? ` + Gateway "${this.gatewayName}"` : '';
      this.log(
        `Registering BedrockAgentCore runtime "${this.providerName}"${gatewayMsg} (role: ${this.roleArn})`
      );
    }

    const tempFile = join(
      tmpdir(),
      `agentregistry-provider-${this.providerName}-${Date.now()}.yaml`
    );
    try {
      await writeFile(tempFile, this.buildManifest(), 'utf8');

      // Device-authorization flow requires interactive terminal output.
      // Stop spinner so arctl can print the URL/code and poll unobstructed.
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

      const kind = this.type === 'kagent' ? 'kagent' : 'BedrockAgentCore';
      this.log(`${kind} runtime "${this.providerName}" registered in agentregistry`, 'success');
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
      // Remove Gateway first (depends on Runtime)
      if (this.type === 'aws' && this.vpcId) {
        try {
          await ArctlHelper.deviceLoginAndExec(
            ['delete', 'gateway', this.gatewayName],
            loginOptions
          );
          this.log(`Gateway "${this.gatewayName}" removed from agentregistry`, 'success');
        } catch (err) {
          this.log(`agentregistry-provider gateway cleanup warning: ${err.message}`, 'warn');
        }
      }

      try {
        await ArctlHelper.deviceLoginAndExec(
          ['delete', 'runtime', this.providerName],
          loginOptions
        );
        this.log(`Runtime "${this.providerName}" removed from agentregistry`, 'success');
      } catch (err) {
        this.log(`agentregistry-provider cleanup warning: ${err.message}`, 'warn');
      }

      if (this.type === 'kagent') {
        try {
          await ArctlHelper.deviceLoginAndExec(
            ['delete', 'secret', this.outboundAuthSecretName],
            loginOptions
          );
          this.log(`Secret "${this.outboundAuthSecretName}" removed from agentregistry`, 'success');
        } catch (err) {
          this.log(`agentregistry-provider secret cleanup warning: ${err.message}`, 'warn');
        }
      }
    } finally {
      if (this.spinner && spinnerText) this.spinner.start(spinnerText);
    }
  }
}
