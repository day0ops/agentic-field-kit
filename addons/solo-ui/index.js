import { AddonFeature } from '../../src/lib/feature.js';
import {
  KubernetesHelper,
  CommandRunner,
  waitForPublicUrl,
  nlbSourceRangeAnnotations,
} from '../../src/lib/common.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_DIR = join(__dirname, 'config');

// Solo Enterprise Management (Solo UI) Helm chart defaults
// Ref: https://preview-solo-docs--pr2480-kkb-test-product-clbqpwm2.web.app/gloo-mesh/main/setup/setup/
const DEFAULT_SOLO_UI_MANAGEMENT_CHART_VERSION = '0.4.1';
const DEFAULT_SOLO_UI_MANAGEMENT_CHART_OCI =
  'oci://us-docker.pkg.dev/solo-public/solo-enterprise-helm/charts/management';
const DEFAULT_SOLO_UI_MANAGEMENT_CRDS_CHART_OCI =
  'oci://us-docker.pkg.dev/solo-public/solo-enterprise-helm/charts/management-crds';
const DEFAULT_SOLO_UI_RELAY_CHART_OCI =
  'oci://us-docker.pkg.dev/solo-public/solo-enterprise-helm/charts/relay';
const RELEASE_NAME = 'solo-ui';
const CRDS_RELEASE_NAME = 'solo-ui-crds';
const RELAY_RELEASE_NAME = 'solo-relay';

// Default tunnel FQDNs. Solo UI uses mesh.internal for east-west routing.
const DEFAULT_TUNNEL_FQDN = 'solo-enterprise-ui.solo-enterprise.mesh.internal';
const DEFAULT_TUNNEL_PORT = 9000;
const DEFAULT_TELEMETRY_FQDN = 'solo-enterprise-telemetry-gateway.solo-enterprise.mesh.internal';

// Product tab path prefixes, per kagent-enterprise's product-types.ts. Fixed URL
// constants upstream, not expected to change often.
const PRODUCT_PATH_PREFIXES = { kagent: 'ke', agentgateway: 'age', mesh: 'ie' };

/**
 * Solo UI (Gloo UI / Solo Enterprise UI): management observability UI for mesh
 * traffic, routes, and policies.
 *
 * Multi-cluster modes:
 *   management - full stack (CRDs, UI, ClickHouse, telemetry collector). One cluster only.
 *   relay      - agent that tunnels data to the management cluster. Deploy on every workload cluster.
 *
 * Configuration:
 * {
 *   mode: string,                    // 'management' (default) | 'relay'
 *   clusterName: string,             // Required: cluster name (passed to both charts)
 *   namespace: string,               // Default: 'solo-enterprise'
 *   managementChartVersion: string,  // Default: '0.4.1'
 *   managementChartOci: string,      // Default: OCI chart URL
 *   serviceType: string,             // Optional: e.g. 'LoadBalancer'; omit for port-forward
 *   nodeSelector: object,            // Default: {}
 *   clickhouse: {                    // Optional: management chart clickhouse values
 *     persistentVolume: {
 *       enabled: boolean,            // Default: true (values.yaml)
 *       size: string,                // Default: 10Gi (values.yaml)
 *       storageClass: string,        // null = cluster default
 *     },
 *   },
 *   applyGatewayTracingPolicy: boolean, // Default: true (management only)
 *   hostname: string,                // Optional: public hostname for HTTPS (management only)
 *   tls: {                           // Optional: TLS config (management only)
 *     enabled: boolean,              // Default: false
 *     secretName: string,            // Default: 'solo-ui-tls'
 *     issuer: string,                // ClusterIssuer name (e.g. 'letsencrypt-dns')
 *   },
 *   oidc: {                          // Optional: OIDC auth (management only)
 *     enabled: boolean,              // Default: false
 *     issuerUrl: string,
 *     backendClientId: string,
 *     backendClientSecret: string,
 *     frontendClientId: string,
 *   },
 *   tunnel: {                        // Relay mode: tunnel to management cluster
 *     fqdn: string,                  // Default: solo-enterprise-ui.solo-enterprise.mesh.internal
 *     port: number,                  // Default: 9000
 *   },
 *   telemetry: {                     // Relay mode: telemetry gateway on management cluster
 *     fqdn: string,                  // Default: solo-enterprise-telemetry-gateway.solo-enterprise.mesh.internal
 *   },
 *   telemetryNamespace: string,      // Management mode: Grafana telemetry stack namespace.
 *                                    // When set, patches OTEL collector to fan-out metrics→Prometheus,
 *                                    // traces→Tempo, logs→Loki alongside ClickHouse.
 *   productAliases: [{               // Optional: per-product hostname aliases (management only).
 *                                    // The in-app product switcher is dead code in production
 *                                    // builds, so each product needs its own hostname that
 *                                    // redirects a bare root request to that product's path prefix.
 *     product: string,               // 'kagent' | 'agentgateway' | 'mesh'
 *     hostname: string,               // Public hostname for this product's alias
 *   }],
 *   products: {                      // Passed through as-is to Helm --set products.<path>=<value>
 *     mesh: { enabled: boolean },
 *     agentgateway: {
 *       enabled: boolean,
 *       namespace: string,
 *       features: { 'cost-management': boolean }, // per-product UI feature toggles
 *     },
 *     kagent: { enabled: boolean, namespace: string },
 *   },
 * }
 */
export class SoloUIFeature extends AddonFeature {
  constructor(name, config) {
    super(name, config);
    this.mode = config.mode || 'management';
    this.clusterName = config.clusterName || null;
    this.namespace = config.namespace || 'solo-enterprise';
    this.chartVersion =
      config.managementChartVersion || config.version || DEFAULT_SOLO_UI_MANAGEMENT_CHART_VERSION;
    this.chartOci = config.managementChartOci || DEFAULT_SOLO_UI_MANAGEMENT_CHART_OCI;
    this.serviceType = config.serviceType || null;
    this.nodeSelector = config.nodeSelector || {};
    this.clickhouse = config.clickhouse || null;
    this.applyGatewayTracingPolicy = config.applyGatewayTracingPolicy !== false;
    this.hostname = config.hostname || null;
    this.tls = config.tls || null;
    this.sourceRanges = config.sourceRanges || null;
    this.oidc = config.oidc || null;
    this.tunnelFqdn = config.tunnel?.fqdn || DEFAULT_TUNNEL_FQDN;
    this.tunnelPort = config.tunnel?.port || DEFAULT_TUNNEL_PORT;
    this.telemetryFqdn = config.telemetry?.fqdn || DEFAULT_TELEMETRY_FQDN;
    // If set, patches the OTEL collector to also ship to the Grafana stack in this namespace
    this.telemetryNamespace = config.telemetryNamespace || null;
    this.products = config.products || null;
    this.rbacRoleMappings = config.rbacRoleMappings || null;
    this.kubeContext = config.kubeContext || null;
    this.productAliases = Array.isArray(config.productAliases) ? config.productAliases : [];
  }

  validate() {
    if (this.mode !== 'management' && this.mode !== 'relay') {
      throw new Error(`solo-ui: invalid mode '${this.mode}'. Must be 'management' or 'relay'`);
    }
    for (const alias of this.productAliases) {
      if (!PRODUCT_PATH_PREFIXES[alias.product]) {
        throw new Error(
          `solo-ui: productAliases entry has invalid product '${alias.product}'. Must be one of: ${Object.keys(PRODUCT_PATH_PREFIXES).join(', ')}`
        );
      }
      if (!alias.hostname) {
        throw new Error(
          `solo-ui: productAliases entry for '${alias.product}' is missing 'hostname'`
        );
      }
      if (this.products?.[alias.product]?.enabled !== true) {
        this.log(
          `productAliases: product '${alias.product}' is not enabled in 'products' — https://${alias.hostname} will just land on the SPA's default redirect`,
          'warn'
        );
      }
    }
    return true;
  }

  getFeaturePath() {
    return '../addons/solo-ui';
  }

  /**
   * Flatten a nested object into Helm --set key=value pairs.
   * @param {string} prefix - Helm values path prefix
   * @param {object|null} obj
   * @returns {string[]}
   */
  buildHelmSetArgs(prefix, obj) {
    if (!obj) return [];
    const args = [];
    const flatten = (val, path) => {
      for (const [key, v] of Object.entries(val)) {
        const fullPath = path ? `${path}.${key}` : key;
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
          flatten(v, fullPath);
        } else {
          args.push('--set', `${fullPath}=${v}`);
        }
      }
    };
    flatten(obj, prefix);
    return args;
  }

  buildProductArgs() {
    return this.buildHelmSetArgs('products', this.products);
  }

  buildNodeSelectorArgs(prefix) {
    const args = [];
    const pathPrefix = prefix ? `${prefix}.` : '';
    for (const [key, value] of Object.entries(this.nodeSelector)) {
      args.push('--set', `${pathPrefix}nodeSelector.${key}=${value}`);
    }
    return args;
  }

  async deploy() {
    if (this.mode === 'relay') {
      await this.deployRelay();
    } else {
      await this.deployManagement();
    }
  }

  async deployManagement() {
    this.log('Installing Solo UI (management mode)...', 'info');

    const ctxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];
    await KubernetesHelper.ensureNamespace(this.namespace, this.spinner, this.kubeContext);
    await KubernetesHelper.kubectl(
      [
        ...ctxArgs,
        'label',
        'namespace',
        this.namespace,
        'istio.io/dataplane-mode=ambient',
        '--overwrite',
      ],
      { spinner: this.spinner }
    );
    this.log(`Namespace '${this.namespace}' ready`, 'info');

    if (this.oidc?.enabled) {
      await this.createOidcSecret();
    }

    await this.installManagementCrdsChart();
    await this.installManagementChart();
    await this.waitForPods();

    if (this.productAliases.length > 0) {
      await this.applyProductAliasResources();
      // applyProductAliasResources only confirms the K8s resources were created,
      // not that each alias hostname actually resolves and serves traffic (DNS
      // propagation, cert issuance, and HTTPRoute/Gateway programming all happen
      // async after this point) -- without this, a broken alias silently reports
      // as deployed and only surfaces when someone later tries to visit it.
      for (const alias of this.productAliases) {
        await waitForPublicUrl(alias.hostname, {
          spinner: this.spinner,
          log: (msg, level) => this.log(msg, level),
        });
      }
    }

    if (this.telemetryNamespace) {
      await this.patchTelemetryCollectorForFanout();
    }

    if (this.hostname && this.tls?.enabled) {
      await this.applyHttpsResources();
      await waitForPublicUrl(this.hostname, {
        spinner: this.spinner,
        log: (msg, level) => this.log(msg, level),
      });
    }

    if (this.applyGatewayTracingPolicy) {
      await this.applyYamlFile('tracing-policy.yaml', {}, this.kubeContext);
      this.log('Gateway tracing policy applied', 'info');
    }

    let accessHint;
    if (this.hostname) {
      accessHint = `Access at https://${this.hostname}/`;
    } else if (this.serviceType) {
      const address = await this.getServiceAddress('solo-enterprise-ui');
      accessHint = address
        ? `Access at http://${address}`
        : `Access via the '${this.serviceType}' service in namespace '${this.namespace}' (address pending)`;
    } else {
      accessHint = `Port-forward with: kubectl port-forward service/solo-enterprise-ui -n ${this.namespace} 4000:80 then open http://localhost:4000/`;
    }
    this.log(`Solo UI management installed successfully. ${accessHint}`, 'success');
  }

  async deployRelay() {
    this.log(
      `Installing Solo UI relay agent (cluster: ${this.clusterName || 'unknown'})...`,
      'info'
    );

    const ctxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];
    await KubernetesHelper.ensureNamespace(this.namespace, this.spinner, this.kubeContext);
    await KubernetesHelper.kubectl(
      [
        ...ctxArgs,
        'label',
        'namespace',
        this.namespace,
        'istio.io/dataplane-mode=ambient',
        '--overwrite',
      ],
      { spinner: this.spinner }
    );
    this.log(`Namespace '${this.namespace}' ready`, 'info');

    await this.installRelayChart();
    await this.waitForRelayPods();

    this.log(
      `Solo UI relay installed. Tunnelling to ${this.tunnelFqdn}:${this.tunnelPort}`,
      'success'
    );
  }

  async installManagementCrdsChart() {
    this.log('Installing management CRDs Helm chart...', 'info');

    const helmArgs = [
      'upgrade',
      '-i',
      CRDS_RELEASE_NAME,
      DEFAULT_SOLO_UI_MANAGEMENT_CRDS_CHART_OCI,
      '-n',
      this.namespace,
      '--version',
      this.chartVersion,
      '--create-namespace',
      '--wait',
      '--timeout',
      '5m',
      ...(this.kubeContext ? ['--kube-context', this.kubeContext] : []),
    ];

    await KubernetesHelper.helm(helmArgs, { spinner: this.spinner });
    await KubernetesHelper.assertHelmDeployed(CRDS_RELEASE_NAME, this.namespace, this.kubeContext);

    this.log('Management CRDs Helm chart installed', 'info');
  }

  /** Install the management Helm chart (Solo UI + ClickHouse). */
  async installManagementChart() {
    this.log('Installing management Helm chart (Solo UI)...', 'info');

    const valuesFile = join(CONFIG_DIR, 'values.yaml');

    const helmArgs = [
      'upgrade',
      '-i',
      RELEASE_NAME,
      this.chartOci,
      '-n',
      this.namespace,
      '--version',
      this.chartVersion,
      '-f',
      valuesFile,
      '--create-namespace',
      '--set',
      'management-crds.enabled=false',
      // In-cluster JWKS endpoint, not the external EKS OIDC endpoint: the latter
      // (oidc.eks.*.amazonaws.com) uses a cert untrusted by in-cluster pods →
      // "x509: certificate signed by unknown authority" → token validator fails to start.
      '--set',
      'kubernetes.jwksUrl=https://kubernetes.default.svc/openid/v1/jwks',
      ...(this.clusterName ? ['--set', `cluster=${this.clusterName}`] : []),
      ...(process.env.ENTERPRISE_ISTIO_LICENSE
        ? ['--set', `licensing.licenseKey=${process.env.ENTERPRISE_ISTIO_LICENSE}`]
        : []),
      '--wait',
      '--timeout',
      '10m',
      ...(this.serviceType ? ['--set', `service.type=${this.serviceType}`] : []),
      ...this.buildHelmSetArgs('clickhouse', this.clickhouse),
      ...(this.oidc?.enabled
        ? [
            '--set',
            `oidc.issuer=${this.oidc.issuerUrl}`,
            '--set',
            `ui.backend.oidc.clientId=${this.oidc.backendClientId}`,
            '--set',
            `ui.backend.oidc.secretRef=ui-backend-oidc-secret`,
            '--set',
            `ui.frontend.oidc.clientId=${this.oidc.frontendClientId}`,
            ...(() => {
              const mappings = this.rbacRoleMappings || {
                admins: 'global.Admin',
                readers: 'global.Reader',
                writers: 'global.Writer',
              };
              return Object.entries(mappings).flatMap(([group, role]) => [
                '--set',
                `rbac.roleMapping.roleMappings.${group}=${role}`,
              ]);
            })(),
          ]
        : []),
      ...this.buildNodeSelectorArgs('ui'),
      ...this.buildNodeSelectorArgs('clickhouse'),
      ...this.buildProductArgs(),
      ...(this.kubeContext ? ['--kube-context', this.kubeContext] : []),
    ];

    await KubernetesHelper.helm(helmArgs, { spinner: this.spinner });
    await KubernetesHelper.assertHelmDeployed(RELEASE_NAME, this.namespace, this.kubeContext);

    this.log('Management Helm chart installed', 'info');
  }

  /** Install the relay Helm chart (remote/workload clusters). */
  async installRelayChart() {
    this.log('Installing relay Helm chart...', 'info');

    const helmArgs = [
      'upgrade',
      '-i',
      RELAY_RELEASE_NAME,
      DEFAULT_SOLO_UI_RELAY_CHART_OCI,
      '-n',
      this.namespace,
      '--version',
      this.chartVersion,
      '--create-namespace',
      '--wait',
      '--timeout',
      '5m',
      '--set',
      `tunnel.fqdn=${this.tunnelFqdn}`,
      '--set',
      `tunnel.port=${this.tunnelPort}`,
      '--set',
      `telemetry.fqdn=${this.telemetryFqdn}`,
      ...(this.clusterName ? ['--set', `cluster=${this.clusterName}`] : []),
      ...this.buildProductArgs(),
      ...(this.kubeContext ? ['--kube-context', this.kubeContext] : []),
    ];

    await KubernetesHelper.helm(helmArgs, { spinner: this.spinner });
    await KubernetesHelper.assertHelmDeployed(RELAY_RELEASE_NAME, this.namespace, this.kubeContext);
    this.log('Relay Helm chart installed', 'info');
  }

  async waitForRelayPods() {
    this.log('Waiting for relay agent pods...', 'info');
    const ctxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];
    try {
      await KubernetesHelper.kubectl(
        [
          ...ctxArgs,
          'wait',
          '--for=condition=ready',
          'pod',
          '-l',
          'app.kubernetes.io/name=relay',
          '-n',
          this.namespace,
          '--timeout=120s',
        ],
        { ignoreError: true, spinner: this.spinner }
      );
    } catch (error) {
      this.log(`Relay pods may still be starting: ${error.message}`, 'warn');
    }
    this.log('Relay agent ready', 'info');
  }

  /**
   * Patch the solo-enterprise OTEL collector ConfigMap to fan-out telemetry to the
   * Grafana stack (metrics→Prometheus remote-write, logs→Loki OTLP) alongside
   * ClickHouse, then restart the collector. Traces are handled separately (see below).
   */
  async patchTelemetryCollectorForFanout() {
    const ns = this.telemetryNamespace;
    const configMapName = 'solo-enterprise-telemetry-collector-config';
    this.log(
      `Patching telemetry collector for fan-out to Grafana stack (namespace: '${ns}')...`,
      'info'
    );

    const ctxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];

    const result = await KubernetesHelper.kubectl(
      [...ctxArgs, 'get', 'configmap', configMapName, '-n', this.namespace, '-o', 'json'],
      { spinner: this.spinner }
    );

    const cm = JSON.parse(result.stdout);
    const yaml = (await import('js-yaml')).default;
    const otelConfig = yaml.load(cm.data.relay);

    // Chart regression (v0.4.3+): clickhouse/metrics exporter defaults to table
    // otel_metrics_exp_histogram, but the migration creates otel_metrics_exponential_histogram.
    // Redirect to the real table so inserts don't fail with UNKNOWN_TABLE.
    const chMetrics = otelConfig.exporters?.['clickhouse/metrics'];
    if (chMetrics) {
      chMetrics.metrics_tables = chMetrics.metrics_tables || {};
      if (!chMetrics.metrics_tables.exponential_histogram) {
        chMetrics.metrics_tables.exponential_histogram = 'otel_metrics_exponential_histogram';
      }
    }

    // Add fan-out exporters (non-destructive: won't overwrite existing keys)
    otelConfig.exporters = otelConfig.exporters || {};
    if (!otelConfig.exporters['prometheusremotewrite/grafana']) {
      otelConfig.exporters['prometheusremotewrite/grafana'] = {
        endpoint: `http://kube-prometheus-stack-prometheus.${ns}:9090/api/v1/write`,
      };
    }
    if (!otelConfig.exporters['otlphttp/loki']) {
      otelConfig.exporters['otlphttp/loki'] = {
        endpoint: `http://loki.${ns}:3100/otlp`,
      };
    }

    // Fan-out pipeline exporters alongside existing ClickHouse exporters
    const pipelines = otelConfig.service?.pipelines || {};
    const addExporter = (pipelineName, exporter) => {
      if (
        pipelines[pipelineName]?.exporters &&
        !pipelines[pipelineName].exporters.includes(exporter)
      ) {
        pipelines[pipelineName].exporters.push(exporter);
      }
    };

    // Metrics → Prometheus remote write
    addExporter('metrics/istio', 'prometheusremotewrite/grafana');
    addExporter('metrics/otlp', 'prometheusremotewrite/grafana');
    addExporter('metrics/platform', 'prometheusremotewrite/grafana');

    // Traces are NOT fanned out to Tempo here: otel-traces and otel-gateway already push
    // directly to Tempo, so adding otlp/tempo would double every span. Solo UI still gets
    // traces via otel-traces' otlp/solo-ui exporter.

    // Logs → Loki
    addExporter('logs/remoteevents', 'otlphttp/loki');
    addExporter('logs/events', 'otlphttp/loki');

    // Apply via SSA with Helm's own field manager (--field-manager=helm) so re-runs don't
    // conflict with Helm's server-side upgrades; --force-conflicts claims the field from
    // any previous manager.
    cm.data.relay = yaml.dump(otelConfig, { lineWidth: -1 });
    const patchYaml = yaml.dump(cm, { lineWidth: -1 });
    const tempFile = join(tmpdir(), `solo-fanout-patch-${Date.now()}.yaml`);
    try {
      await writeFile(tempFile, patchYaml, 'utf8');
      await KubernetesHelper.kubectl(
        [
          ...ctxArgs,
          'apply',
          '--server-side',
          '--force-conflicts',
          '--field-manager=helm',
          '-f',
          tempFile,
        ],
        { spinner: this.spinner }
      );
    } finally {
      try {
        await unlink(tempFile);
      } catch {
        /* ignore */
      }
    }

    // Restart collector: may be StatefulSet (metrics enabled) or Deployment
    await KubernetesHelper.kubectl(
      [
        ...ctxArgs,
        'rollout',
        'restart',
        'statefulset/solo-enterprise-telemetry-collector',
        '-n',
        this.namespace,
      ],
      { ignoreError: true, spinner: this.spinner }
    );
    await KubernetesHelper.kubectl(
      [
        ...ctxArgs,
        'rollout',
        'restart',
        'deployment/solo-enterprise-telemetry-collector',
        '-n',
        this.namespace,
      ],
      { ignoreError: true, spinner: this.spinner }
    );
    // Wait for rollout (ignoreError so the missing resource type doesn't fail)
    await KubernetesHelper.kubectl(
      [
        ...ctxArgs,
        'rollout',
        'status',
        'statefulset/solo-enterprise-telemetry-collector',
        '-n',
        this.namespace,
        '--timeout=120s',
      ],
      { ignoreError: true, spinner: this.spinner }
    );
    await KubernetesHelper.kubectl(
      [
        ...ctxArgs,
        'rollout',
        'status',
        'deployment/solo-enterprise-telemetry-collector',
        '-n',
        this.namespace,
        '--timeout=120s',
      ],
      { ignoreError: true, spinner: this.spinner }
    );

    this.log(
      `Telemetry fan-out active: metrics→Prometheus, traces→Tempo, logs→Loki (namespace '${ns}')`,
      'success'
    );
  }

  async waitForPods() {
    this.log('Waiting for management and UI pods...', 'info');

    const ctxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];

    try {
      await KubernetesHelper.waitForDeployment(
        this.namespace,
        'solo-enterprise-ui',
        300,
        this.spinner,
        this.kubeContext
      );
    } catch (error) {
      this.log(`solo-enterprise-ui may still be starting: ${error.message}`, 'warn');
    }

    // ClickHouse may be a StatefulSet (e.g. management-clickhouse-shard0-0)
    try {
      await KubernetesHelper.kubectl(
        [
          ...ctxArgs,
          'wait',
          '--for=condition=ready',
          'pod',
          '-l',
          'app.kubernetes.io/name=clickhouse',
          '-n',
          this.namespace,
          '--timeout=300s',
        ],
        { ignoreError: true, spinner: this.spinner }
      );
    } catch (_error) {
      this.log('ClickHouse pods may use different labels; continuing', 'warn');
    }

    this.log('Solo UI and management components are ready', 'info');
  }

  async getServiceAddress(serviceName) {
    const ctxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];
    const jsonpathArgs = field => [
      ...ctxArgs,
      'get',
      'svc',
      serviceName,
      '-n',
      this.namespace,
      '-o',
      `jsonpath={.status.loadBalancer.ingress[0].${field}}`,
    ];
    const ipResult = await KubernetesHelper.kubectl(jsonpathArgs('ip'), { ignoreError: true });
    const address = (ipResult.stdout || '').trim();
    if (address) return address;

    const hostResult = await KubernetesHelper.kubectl(jsonpathArgs('hostname'), {
      ignoreError: true,
    });
    return (hostResult.stdout || '').trim() || null;
  }

  async createOidcSecret() {
    this.log('Creating OIDC backend client secret...', 'info');
    await this.applyResource(
      {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: 'ui-backend-oidc-secret',
          namespace: this.namespace,
          labels: { 'app.kubernetes.io/managed-by': 'agentic-demo' },
        },
        type: 'Opaque',
        stringData: { clientSecret: this.oidc.backendClientSecret },
      },
      this.kubeContext
    );
    this.log('OIDC secret created', 'info');
  }

  async applyHttpsResources() {
    this.log(`Configuring HTTPS for Solo UI at https://${this.hostname}...`, 'info');

    const secretName = this.tls.secretName || 'solo-ui-tls';
    const issuerName = this.tls.issuer || 'letsencrypt-dns';

    await this.applyYamlFile(
      'certificate.yaml',
      {
        spec: {
          secretName,
          issuerRef: { name: issuerName },
          dnsNames: [this.hostname],
        },
      },
      this.kubeContext
    );

    const nlbAnnotations = nlbSourceRangeAnnotations(this.sourceRanges);

    // Pass complete listener object: deepMerge replaces arrays wholesale
    await this.applyYamlFile(
      'https-gateway.yaml',
      {
        spec: {
          listeners: [
            {
              name: 'https',
              port: 443,
              protocol: 'HTTPS',
              hostname: this.hostname,
              tls: {
                mode: 'Terminate',
                certificateRefs: [{ name: secretName, kind: 'Secret' }],
              },
              allowedRoutes: {
                namespaces: { from: 'All' },
              },
            },
          ],
          ...(nlbAnnotations ? { infrastructure: { annotations: nlbAnnotations } } : {}),
        },
      },
      this.kubeContext
    );

    await this.applyYamlFile(
      'https-route.yaml',
      {
        spec: {
          parentRefs: [
            {
              group: 'gateway.networking.k8s.io',
              kind: 'Gateway',
              name: 'solo-enterprise-ui-https',
              namespace: this.namespace,
            },
          ],
          hostnames: [this.hostname],
          rules: [
            {
              backendRefs: [{ name: 'solo-enterprise-ui', port: 80 }],
              matches: [{ path: { type: 'PathPrefix', value: '/' } }],
            },
          ],
        },
      },
      this.kubeContext
    );

    await this.applyYamlFile('gateway-tracing-suppress-policy.yaml', {}, this.kubeContext);

    this.log('HTTPS resources applied', 'info');
  }

  /**
   * Apply per-product hostname aliases: each redirects a bare root request to that
   * product's path prefix, since the in-app product switcher is dead code in production
   * builds. Every other request (all static assets included) passes through unmodified --
   * see the HTTPRoute rules below for why a blanket URLRewrite breaks the SPA's own
   * asset loading. All resources live in this.namespace (same as solo-enterprise-ui), so
   * no ReferenceGrant is needed.
   */
  async applyProductAliasResources() {
    for (const alias of this.productAliases) {
      const { product, hostname } = alias;
      const prefix = PRODUCT_PATH_PREFIXES[product];
      this.log(`Configuring '${product}' UI alias at https://${hostname} (/${prefix})...`, 'info');

      const secretName = `${product}-ui-tls`;
      const issuerName = this.tls?.issuer || 'letsencrypt-dns';
      const nlbAnnotations = nlbSourceRangeAnnotations(this.sourceRanges);

      await this.applyResource(
        {
          apiVersion: 'cert-manager.io/v1',
          kind: 'Certificate',
          metadata: { name: secretName, namespace: this.namespace },
          spec: {
            secretName,
            issuerRef: { name: issuerName, kind: 'ClusterIssuer' },
            dnsNames: [hostname],
          },
        },
        this.kubeContext
      );

      await this.applyResource(
        {
          apiVersion: 'gateway.networking.k8s.io/v1',
          kind: 'Gateway',
          metadata: { name: `${product}-ui-https`, namespace: this.namespace },
          spec: {
            gatewayClassName: 'enterprise-agentgateway',
            listeners: [
              {
                name: 'https',
                port: 443,
                protocol: 'HTTPS',
                hostname,
                tls: {
                  mode: 'Terminate',
                  certificateRefs: [{ name: secretName, kind: 'Secret' }],
                },
                allowedRoutes: { namespaces: { from: 'All' } },
              },
            ],
            ...(nlbAnnotations ? { infrastructure: { annotations: nlbAnnotations } } : {}),
          },
        },
        this.kubeContext
      );

      await this.applyResource(
        {
          apiVersion: 'gateway.networking.k8s.io/v1',
          kind: 'HTTPRoute',
          metadata: { name: `${product}-ui`, namespace: this.namespace },
          spec: {
            parentRefs: [
              {
                group: 'gateway.networking.k8s.io',
                kind: 'Gateway',
                name: `${product}-ui-https`,
                namespace: this.namespace,
              },
            ],
            hostnames: [hostname],
            rules: [
              // The SPA is one build with client-side routing (react-router), not a
              // separate deployment per product -- its asset requests (/assets/*,
              // /env-config.js, etc.) are root-relative regardless of which product
              // route is active. Rewriting every request's path (as URLRewrite would)
              // also rewrites those asset requests to /<prefix>/assets/*, which don't
              // exist server-side, so the backend's SPA-fallback silently returns
              // index.html instead of the real JS/CSS -- a blank, broken page.
              // Confirmed live (2026-09-04). Redirecting only the bare root path
              // changes the browser's visible URL to /<prefix> (so the client router
              // renders the right product) while every other request -- including
              // every asset -- passes through unmodified, exactly like the main
              // soloUi hostname already does.
              {
                matches: [{ path: { type: 'Exact', value: '/' } }],
                filters: [
                  {
                    type: 'RequestRedirect',
                    requestRedirect: {
                      path: { type: 'ReplaceFullPath', replaceFullPath: `/${prefix}` },
                      statusCode: 302,
                    },
                  },
                ],
              },
              {
                backendRefs: [{ name: 'solo-enterprise-ui', port: 80 }],
                matches: [{ path: { type: 'PathPrefix', value: '/' } }],
              },
            ],
          },
        },
        this.kubeContext
      );

      await this.applyResource(
        {
          apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
          kind: 'EnterpriseAgentgatewayPolicy',
          metadata: { name: `${product}-ui-cors`, namespace: this.namespace },
          spec: {
            targetRefs: [
              {
                group: 'gateway.networking.k8s.io',
                kind: 'Gateway',
                name: `${product}-ui-https`,
              },
            ],
            traffic: {
              cors: {
                allowCredentials: true,
                allowHeaders: [
                  'Content-Type',
                  'Authorization',
                  'X-Grpc-Web',
                  'Grpc-Timeout',
                  'Grpc-Accept-Encoding',
                  'Grpc-Encoding',
                  'X-User-Agent',
                  'Accept',
                  'Accept-Encoding',
                  'Accept-Language',
                  'Cache-Control',
                  'User-Agent',
                ],
                allowMethods: ['GET', 'POST', 'OPTIONS', 'DELETE'],
                allowOrigins: [`https://${hostname}`],
                exposeHeaders: [
                  'Grpc-Status',
                  'Grpc-Message',
                  'Grpc-Status-Details-Bin',
                  'Content-Type',
                  'X-Grpc-Web',
                ],
                maxAge: 86400,
              },
            },
          },
        },
        this.kubeContext
      );
    }

    this.log('Product UI alias resources applied', 'info');
  }

  async cleanup() {
    if (this.mode === 'relay') {
      await this.cleanupRelay();
    } else {
      await this.cleanupManagement();
    }
  }

  async cleanupManagement() {
    this.log('Cleaning up Solo UI (management)...', 'info');

    const helmCtxArgs = this.kubeContext ? ['--kube-context', this.kubeContext] : [];

    if (this.oidc?.enabled) {
      await this.deleteResource(
        'Secret',
        'ui-backend-oidc-secret',
        this.namespace,
        this.kubeContext
      );
    }

    if (this.hostname && this.tls?.enabled) {
      await this.deleteResource(
        'HTTPRoute',
        'solo-enterprise-ui',
        this.namespace,
        this.kubeContext
      );
      await this.deleteResource(
        'Gateway',
        'solo-enterprise-ui-https',
        this.namespace,
        this.kubeContext
      );
      await this.deleteResource('Certificate', 'solo-ui-tls', this.namespace, this.kubeContext);
    }

    for (const alias of this.productAliases) {
      const { product } = alias;
      await this.deleteResource(
        'EnterpriseAgentgatewayPolicy',
        `${product}-ui-cors`,
        this.namespace,
        this.kubeContext
      );
      await this.deleteResource('HTTPRoute', `${product}-ui`, this.namespace, this.kubeContext);
      await this.deleteResource('Gateway', `${product}-ui-https`, this.namespace, this.kubeContext);
      await this.deleteResource(
        'Certificate',
        `${product}-ui-tls`,
        this.namespace,
        this.kubeContext
      );
    }

    try {
      await CommandRunner.run('helm', [
        ...helmCtxArgs,
        'uninstall',
        RELEASE_NAME,
        CRDS_RELEASE_NAME,
        '-n',
        this.namespace,
        '--wait',
      ]);
      this.log('Management Helm releases uninstalled', 'info');
    } catch (error) {
      if (!/not found|no deployed releases/i.test(error.message)) throw error;
    }

    const ctxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];
    await KubernetesHelper.kubectl([
      ...ctxArgs,
      'delete',
      'namespace',
      this.namespace,
      '--ignore-not-found=true',
    ]);

    this.log('Solo UI management cleaned up', 'success');
  }

  async cleanupRelay() {
    this.log('Cleaning up Solo UI relay...', 'info');

    const helmCtxArgs = this.kubeContext ? ['--kube-context', this.kubeContext] : [];
    try {
      await CommandRunner.run('helm', [
        ...helmCtxArgs,
        'uninstall',
        RELAY_RELEASE_NAME,
        '-n',
        this.namespace,
        '--wait',
      ]);
      this.log('Relay Helm release uninstalled', 'info');
    } catch (error) {
      if (!/not found|no deployed releases/i.test(error.message)) throw error;
    }

    const ctxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];
    await KubernetesHelper.kubectl([
      ...ctxArgs,
      'delete',
      'namespace',
      this.namespace,
      '--ignore-not-found=true',
    ]);

    this.log('Solo UI relay cleaned up', 'success');
  }
}
