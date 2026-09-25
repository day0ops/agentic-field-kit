import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import yaml from 'js-yaml';
import { Feature } from '../../../src/lib/feature.js';
import { KubernetesHelper } from '../../../src/lib/common.js';
import { ArctlHelper } from '../../../src/lib/arctl.js';

/**
 * AgentregistryRouteFeature
 *
 * Wires a running agentregistry instance into an agentgateway Gateway:
 *   1. Resolves + installs arctl (cached at ~/.arctl/bin/arctl)
 *   2. Logs in via OIDC device-authorization flow (interactive — user opens URL)
 *   3. Labels the Gateway with agentregistry.solo.io/runtime: <runtimeName>
 *   4. Creates a Virtual Runtime resource via arctl
 *   5. Deploys a delegate HTTPRoute (gateway → agentregistry-system)
 *
 * Configuration:
 * {
 *   gatewayName: string,           // Name of the parent Gateway (required)
 *   gatewayNamespace: string,      // Namespace of the Gateway (required)
 *   agentregistryNamespace: string,// Namespace where agentregistry is installed (default: 'agentregistry-system')
 *   runtimeName: string,           // Virtual Runtime name (default: 'mcp-gateway')
 *   routeName: string,             // HTTPRoute name (default: 'agentregistry-delegate')
 *   routeNamespace: string,        // Namespace for HTTPRoute (default: gatewayNamespace)
 *   pathPrefix: string,            // Path prefix to delegate (default: '/registry')
 *   arctl: {
 *     version: string,             // arctl version (default: v2026.5.3)
 *     registryUrl: string,         // AgentRegistry URL e.g. https://agentregistry.example.com (required)
 *     keycloakHostname: string,    // Keycloak hostname — issuer URL computed from this (required)
 *     keycloakTlsEnabled: boolean, // Whether Keycloak uses HTTPS (default: true)
 *     realm: string,               // Keycloak realm (default: 'agentregistry')
 *     clientId: string,            // OIDC client ID for device flow (default: 'ar-cli')
 *   }
 * }
 */
export class AgentregistryRouteFeature extends Feature {
  constructor(name, config = {}) {
    super(name, config);
    this.gatewayName = config.gatewayName;
    this.gatewayNamespace = config.gatewayNamespace;
    this.agentregistryNamespace = config.agentregistryNamespace || 'agentregistry-system';
    this.runtimeName = config.runtimeName || 'mcp-gateway';
    this.routeName = config.routeName || 'agentregistry-delegate';
    this.routeNamespace = config.routeNamespace || config.gatewayNamespace;
    this.pathPrefix = config.pathPrefix || '/registry';

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
    if (!this.gatewayName) throw new Error('agentregistry-route: gatewayName is required');
    if (!this.gatewayNamespace)
      throw new Error('agentregistry-route: gatewayNamespace is required');
    if (!this.arctlRegistryUrl)
      throw new Error('agentregistry-route: arctl.registryUrl is required');
    if (!this.arctlOidcIssuerUrl)
      throw new Error(
        'agentregistry-route: arctl.keycloakHostname or arctl.oidcIssuerUrl is required'
      );
    return true;
  }

  buildVirtualRuntime() {
    return {
      apiVersion: 'ar.dev/v1alpha1',
      kind: 'Runtime',
      metadata: { name: this.runtimeName },
      spec: { type: 'Virtual' },
    };
  }

  buildDelegateHttpRoute() {
    return {
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'HTTPRoute',
      metadata: {
        name: this.routeName,
        namespace: this.routeNamespace,
        labels: {
          'agentregistry.solo.io/runtime': this.runtimeName,
        },
      },
      spec: {
        parentRefs: [
          {
            name: this.gatewayName,
            namespace: this.gatewayNamespace,
          },
        ],
        rules: [
          {
            matches: [{ path: { type: 'PathPrefix', value: this.pathPrefix } }],
            backendRefs: [
              {
                group: 'gateway.networking.k8s.io',
                kind: 'HTTPRoute',
                name: '*',
                namespace: this.agentregistryNamespace,
              },
            ],
          },
        ],
      },
    };
  }

  async applyVirtualRuntime() {
    const manifest = yaml.dump(this.buildVirtualRuntime(), { lineWidth: -1, indent: 2 });
    const tempFile = join(tmpdir(), `agentregistry-runtime-${Date.now()}.yaml`);
    try {
      await writeFile(tempFile, manifest, 'utf8');

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
        // Restart spinner regardless of outcome
        if (this.spinner && spinnerText) this.spinner.start(spinnerText);
      }
    } finally {
      try {
        await unlink(tempFile);
      } catch {
        /* ignore */
      }
    }
  }

  async deleteVirtualRuntime() {
    // The Virtual Runtime is an agentregistry-managed resource reachable only through
    // its own API (arctl) -- there is no ar.dev CRD installed on any cluster to
    // kubectl-delete (kubectl would silently no-op on the unknown resource type).
    const spinnerText = this.spinner?.text;
    this.spinner?.stop();
    try {
      await ArctlHelper.deviceLoginAndExec(['delete', 'runtime', this.runtimeName], {
        registryUrl: this.arctlRegistryUrl,
        oidcIssuerUrl: this.arctlOidcIssuerUrl,
        oidcClientId: this.arctlClientId,
        version: this.arctlVersion,
      });
    } catch (err) {
      this.log(`agentregistry-route runtime cleanup warning: ${err.message}`, 'warn');
    } finally {
      if (this.spinner && spinnerText) this.spinner.start(spinnerText);
    }
  }

  async labelGateway(context) {
    const ctxArgs = context ? [`--context=${context}`] : [];
    await KubernetesHelper.kubectl([
      ...ctxArgs,
      'label',
      'gateway',
      this.gatewayName,
      '-n',
      this.gatewayNamespace,
      `agentregistry.solo.io/runtime=${this.runtimeName}`,
      '--overwrite',
    ]);
    this.log(
      `Labeled Gateway "${this.gatewayName}" with agentregistry.solo.io/runtime=${this.runtimeName}`
    );
  }

  async unlabelGateway(context) {
    try {
      const ctxArgs = context ? [`--context=${context}`] : [];
      await KubernetesHelper.kubectl([
        ...ctxArgs,
        'label',
        'gateway',
        this.gatewayName,
        '-n',
        this.gatewayNamespace,
        'agentregistry.solo.io/runtime-',
      ]);
    } catch {
      /* ignore */
    }
  }

  async deploy() {
    this.validate();

    // Ensure arctl binary is resolved/installed before interactive login
    await ArctlHelper.resolve({ version: this.arctlVersion });

    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];

    for (const context of contextsToDeploy) {
      // 1. Label Gateway
      await this.labelGateway(context);

      // 2. Create Virtual Runtime via arctl (includes device-authorization login)
      this.log(`Creating Virtual Runtime "${this.runtimeName}" via arctl (device login required)`);
      await this.applyVirtualRuntime();
      this.log(`Virtual Runtime "${this.runtimeName}" created`, 'success');

      // 3. Delegate HTTPRoute
      this.log(
        `Applying delegate HTTPRoute "${this.routeName}" (${this.pathPrefix} → ${this.agentregistryNamespace})`
      );
      await this.applyResource(this.buildDelegateHttpRoute(), context);
      this.log(`HTTPRoute "${this.routeName}" applied`, 'success');
    }
  }

  async cleanup() {
    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];

    for (const context of contextsToDeploy) {
      await this.deleteResource('httproute', this.routeName, this.routeNamespace, context);
      await this.deleteVirtualRuntime();
      await this.unlabelGateway(context);
    }
    this.log('AgentRegistry route cleaned up', 'success');
  }
}
