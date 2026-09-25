import { AddonFeature } from '../../src/lib/feature.js';
import {
  KubernetesHelper,
  CommandRunner,
  nlbSourceRangeAnnotations,
} from '../../src/lib/common.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFile, readdir, writeFile, unlink } from 'fs/promises';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { resolveChartVersions } from './versions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_DIR = join(__dirname, 'config');
const DASHBOARDS_DIR = join(__dirname, 'dashboards');

// Helm chart repo
const OTEL_HELM_REPO = 'https://open-telemetry.github.io/opentelemetry-helm-charts';

// Agent mode (spoke/remote clusters)
const OTEL_METRICS_RELEASE = 'opentelemetry-collector-metrics';
const OTEL_LOGS_RELEASE = 'opentelemetry-collector-logs';
const OTEL_TRACES_RELEASE = 'opentelemetry-collector-traces';

// Full mode (east) reuses these release names; safe since clusters are separate k8s clusters.
const OTEL_GATEWAY_RELEASE = 'opentelemetry-collector-gateway';

// Solo COP Grafana dashboards
// Source: https://github.com/solo-io/solo-cop/tree/main/tools/grafana
const SOLO_COP_GRAFANA_BASE =
  'https://raw.githubusercontent.com/solo-io/solo-cop/main/tools/grafana';
const SOLO_COP_DASHBOARDS = [
  'istio-performance-dashboard',
  'istio-peering-dashboard',
  'istio-global-services-dashboard',
];

// Helm --set-string strvals treats comma as a separator and backslash as an escape,
// so escape backslash first, then comma.
const helmSetEscape = value => String(value).replace(/\\/g, '\\\\').replace(/,/g, '\\,');

/**
 * Telemetry Feature
 *
 * Installs a full observability stack for Istio Ambient mesh:
 * - Prometheus + Grafana (kube-prometheus-stack)
 * - Grafana Tempo Distributed (trace aggregation, OTLP receiver)
 * - Grafana Loki (log aggregation)
 * - Grafana Alloy (log scraping from pods)
 * - OTel collectors (full mode only): standard 3-collector set (metrics/logs/traces) + cross-cluster gateway
 *
 * Scrape targets (per docs):
 * - istiod    — control plane metrics
 * - ztunnel   — L4 proxy metrics (ambient mode)
 * - gateway   — waypoint + east-west gateway metrics
 *
 * Dashboards (from Solo COP, downloaded at install or from local dashboards/):
 * - istio-performance-dashboard
 * - istio-peering-dashboard
 * - istio-global-services-dashboard
 * - agentgateway-overview
 * - agentgateway-performance
 * - agentgateway-cost-control
 * - agentgateway-control-plane
 *
 * Datasources (managed as ConfigMap grafana-datasources with grafana_datasource=1):
 * - Prometheus (default), Tempo, Loki
 * - URLs use this.namespace so non-default namespaces work correctly
 *
 * Configuration (mode: 'full'):
 * {
 * Profile YAML: set chartVersions on the addon entry (sibling of config), or under config.
 *   version: string,              // Shorthand for chartVersions.otel (opentelemetry-collector)
 *   chartVersions: {              // Helm chart version overrides
 *     kube-prom-stack: string,    // kube-prometheus-stack (default: 86.1.0)
 *     loki: string,               // grafana/loki (default: 7.0.0)
 *     tempo: string,              // grafana/tempo-distributed (default: 1.61.3)
 *     alloy: string,              // grafana/alloy (default: 1.8.2)
 *     otel: string,               // opentelemetry-collector (default: 0.158.0)
 *   },
 *   namespace: string,            // Default: 'telemetry'
 *   enableLogs: boolean,          // Default: true  — install Loki + Alloy
 *   enableTraces: boolean,        // Default: true  — install Tempo
 *   enableMetrics: boolean,       // Default: true  — install Prometheus scrape configs
 *   retention: string,            // Default: '120h' — metrics/logs/traces retention
 *   grafanaServiceType: string,   // Default: 'ClusterIP'
 *   nodeSelector: object,         // Default: {}
 *   grafanaHostname: string,      // Optional: external-dns hostname for Grafana
 *   prometheusHostname: string,   // Optional: external-dns hostname for Prometheus
 *   tempoHostname: string,        // Optional: external-dns hostname for Tempo
 *   lokiHostname: string,         // Optional: external-dns hostname for Loki
 *   installDashboards: boolean,   // Default: true
 *   globalExport: boolean,        // Default: false — label Loki/Tempo/Prometheus as global services
 * }
 *
 * Configuration (mode: 'agent'):
 * {
 *   version: string,                     // Shorthand for chartVersions.otel
 *   chartVersions: { alloy: string, otel: string },
 *   namespace: string,                   // Default: 'telemetry'
 *   otelGatewayEndpoint: string,         // Required: east OTel gateway gRPC endpoint (e.g. opentelemetry-collector-gateway.telemetry.mesh.internal:4317)
 *   lokiPushUrl: string,                 // Required: east Loki push URL for Alloy (e.g. http://loki.telemetry.mesh.internal:3100/loki/api/v1/push)
 * }
 *
 * In 'full' mode (Grafana is installed) the following environment variables are
 * required (no defaults - deploy fails cleanly via validate() if either is unset):
 *   GRAFANA_ADMIN_USERNAME - Grafana admin login username
 *   GRAFANA_ADMIN_PASSWORD - Grafana admin login password
 */
export class TelemetryFeature extends AddonFeature {
  constructor(name, config) {
    super(name, config);
    this.mode = config.mode || 'full';
    this.namespace = config.namespace || 'telemetry';
    const versions = resolveChartVersions(config);
    this.otelChartVersion = versions.otel;
    this.prometheusStackVersion = versions['kube-prom-stack'];
    this.lokiVersion = versions.loki;
    this.tempoVersion = versions.tempo;
    this.alloyVersion = versions.alloy;
    this.kubeContext = config.kubeContext || null;
    this.soloUiNamespace = config.soloUiNamespace || 'solo-enterprise';
    this.agentregistryNamespace = config.agentregistryNamespace || 'agentregistry-system';
    this.clusterName = config.clusterName || '';

    if (this.mode === 'agent') {
      this.otelGatewayEndpoint = config.otelGatewayEndpoint || null;
      this.lokiPushUrl = config.lokiPushUrl || null;
    } else {
      this.enableLogs = config.enableLogs !== false;
      this.enableTraces = config.enableTraces !== false;
      this.enableMetrics = config.enableMetrics !== false;
      this.retention = config.retention || '120h';
      this.grafanaServiceType = config.grafanaServiceType || 'ClusterIP';
      this.nodeSelector = config.nodeSelector || {};
      this.grafanaHostname = config.grafanaHostname || '';
      this.prometheusHostname = config.prometheusHostname || '';
      this.tempoHostname = config.tempoHostname || '';
      this.lokiHostname = config.lokiHostname || '';
      this.shouldInstallDashboards = config.installDashboards !== false;
      this.database = config.database || null;
      this.storageClass = this.database?.storageClass || config.storageClass || '';
      this.storageSize = this.database?.storageSize || config.storageSize || '50Gi';
      this.grafanaTls = config.grafanaTls || null;
      this.grafanaSourceRanges = config.sourceRanges || null;
      this.grafanaOidc = config.grafanaOidc || null;
      this.globalExport = config.globalExport === true;
      this.shouldInstallOtelCollectors = config.installOtelCollectors !== false;
      this.grafanaAdminUsername = process.env.GRAFANA_ADMIN_USERNAME || '';
      this.grafanaAdminPassword = process.env.GRAFANA_ADMIN_PASSWORD || '';
    }
  }

  validate() {
    if (this.mode === 'agent') {
      const missing = ['otelGatewayEndpoint', 'lokiPushUrl'].filter(f => !this[f]);
      if (missing.length) {
        throw new Error(`telemetry agent mode requires: ${missing.join(', ')}`);
      }
      return true;
    }
    const missing = [
      !this.grafanaAdminUsername && 'GRAFANA_ADMIN_USERNAME',
      !this.grafanaAdminPassword && 'GRAFANA_ADMIN_PASSWORD',
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new Error(
        `Telemetry requires the following environment variable(s) to be set: ${missing.join(', ')}.\n` +
          'Set them before deploying, e.g.:\n' +
          '  export GRAFANA_ADMIN_USERNAME="admin"\n' +
          '  export GRAFANA_ADMIN_PASSWORD="<your-password>"'
      );
    }
    return true;
  }

  /** Resolve YAML paths from this addon's config/ dir instead of the base class's features/ dir. */
  async applyYamlFile(filename, overrides = {}, context = null) {
    const yaml = (await import('js-yaml')).default;
    const configPath = join(CONFIG_DIR, filename);

    try {
      const content = await readFile(configPath, 'utf8');
      let resource = yaml.load(content);

      if (resource.metadata && resource.metadata.namespace !== this.namespace) {
        resource.metadata.namespace = this.namespace;
      }

      if (Object.keys(overrides).length > 0) {
        resource = this.deepMerge(resource, overrides);
      }

      await this.applyResource(resource, context);
    } catch (error) {
      throw new Error(`Failed to apply YAML file ${filename}: ${error.message}`);
    }
  }

  /** Apply a multi-doc YAML file (--- separated). */
  async applyMultiDocYamlFile(filename, context = null) {
    const yaml = (await import('js-yaml')).default;
    const configPath = join(CONFIG_DIR, filename);

    try {
      const content = await readFile(configPath, 'utf8');
      const documents = yaml.loadAll(content);
      for (const doc of documents) {
        if (doc) {
          await this.applyResource(doc, context);
        }
      }
    } catch (error) {
      throw new Error(`Failed to apply multi-doc YAML file ${filename}: ${error.message}`);
    }
  }

  /**
   * Build Helm --set args for nodeSelector
   * @param {string} prefix - Helm values path prefix (e.g., 'grafana')
   */
  buildNodeSelectorArgs(prefix) {
    const args = [];
    const pathPrefix = prefix ? `${prefix}.` : '';
    for (const [key, value] of Object.entries(this.nodeSelector)) {
      args.push('--set', `${pathPrefix}nodeSelector.${key}=${value}`);
    }
    return args;
  }

  /**
   * Temp Helm values file for Grafana OIDC; disables the login form so only
   * Keycloak-authenticated users get in. Caller must delete the returned path.
   */
  async buildGrafanaOidcValuesFile() {
    const yaml = (await import('js-yaml')).default;
    const { issuerUrl, clientId, clientSecret, adminGroup = 'grafana-admins' } = this.grafanaOidc;
    const roleAttrPath = `contains(Groups[*], '${adminGroup}') && 'Admin' || 'Viewer'`;

    const values = {
      grafana: {
        assertNoLeakedSecrets: false,
        'grafana.ini': {
          server: {
            root_url: `https://${this.grafanaHostname}`,
          },
          auth: {
            disable_login_form: true,
            oauth_auto_login: true,
          },
          'auth.generic_oauth': {
            enabled: true,
            name: 'Keycloak',
            allow_sign_up: true,
            client_id: clientId,
            client_secret: clientSecret,
            scopes: 'openid email profile offline_access',
            auth_url: `${issuerUrl}/protocol/openid-connect/auth`,
            token_url: `${issuerUrl}/protocol/openid-connect/token`,
            api_url: `${issuerUrl}/protocol/openid-connect/userinfo`,
            role_attribute_path: roleAttrPath,
            use_pkce: true,
          },
        },
      },
    };

    const tempFile = join(tmpdir(), `grafana-oidc-${Date.now()}.yaml`);
    await writeFile(tempFile, yaml.dump(values, { lineWidth: -1 }), 'utf8');
    return tempFile;
  }

  /**
   * Certificate + Gateway + HTTPRoute for Grafana HTTPS, all in this.namespace so no
   * cross-namespace ReferenceGrant is needed (cert secret and Gateway are co-located).
   */
  async applyGrafanaHttpsResources() {
    const hostname = this.grafanaHostname;
    const secretName = this.grafanaTls.secretName || 'grafana-tls';
    const issuerName = this.grafanaTls.issuer || 'letsencrypt-dns';

    this.log(`Configuring HTTPS for Grafana at https://${hostname}...`, 'info');

    await this.applyYamlFile(
      'grafana-certificate.yaml',
      {
        spec: {
          secretName,
          issuerRef: { name: issuerName },
          dnsNames: [hostname],
        },
      },
      this.kubeContext
    );

    const nlbAnnotations = nlbSourceRangeAnnotations(this.grafanaSourceRanges);

    await this.applyYamlFile(
      'grafana-gateway.yaml',
      {
        spec: {
          listeners: [
            {
              name: 'https',
              port: 443,
              protocol: 'HTTPS',
              hostname,
              tls: {
                mode: 'Terminate',
                certificateRefs: [{ group: '', name: secretName, kind: 'Secret' }],
              },
              allowedRoutes: { namespaces: { from: 'All' } },
            },
          ],
          ...(nlbAnnotations ? { infrastructure: { annotations: nlbAnnotations } } : {}),
        },
      },
      this.kubeContext
    );

    await this.applyYamlFile(
      'grafana-httproute.yaml',
      {
        spec: {
          hostnames: [hostname],
          rules: [
            {
              backendRefs: [{ name: 'kube-prometheus-stack-grafana', port: 80 }],
              matches: [{ path: { type: 'PathPrefix', value: '/' } }],
            },
          ],
        },
      },
      this.kubeContext
    );

    await this.applyYamlFile('grafana-gateway-telemetry.yaml', {}, this.kubeContext);

    this.log('Grafana HTTPS resources applied', 'info');
  }

  async deploy() {
    if (this.mode === 'agent') {
      return this.deployAgent();
    }
    return this.deployFull();
  }

  async deployFull() {
    this.log('Installing telemetry stack...', 'info');

    await KubernetesHelper.ensureNamespace(this.namespace, this.spinner, this.kubeContext);
    // Ambient label lets the peering controller export ServiceEntries to remote clusters.
    await KubernetesHelper.labelNamespaceForAmbient(this.namespace, this.kubeContext, {
      quiet: true,
    });
    this.log(`Namespace '${this.namespace}' ready`, 'info');

    // Tempo first: Grafana datasource config needs its endpoint.
    if (this.enableTraces) {
      await this.installTempo();
    }

    // Loki + Alloy before Grafana: datasource config needs the Loki endpoint.
    if (this.enableLogs) {
      await this.installLoki();
      await this.installAlloy();
    }

    // Datasources reference Tempo + Loki if enabled.
    await this.installPrometheusStack();

    if (this.shouldInstallOtelCollectors) {
      await this.installOtelCollectors();
      await this.installOtelGateway();
      // gloo-extensions-config is operator-only (gloo-mesh ns); Helm installs configure
      // tracing via istiod/ztunnel Helm values in the profile instead.
    }

    if (this.grafanaTls?.enabled && this.grafanaHostname) {
      await this.applyGrafanaHttpsResources();
    }

    await this.installDatasources();

    if (this.shouldInstallDashboards) {
      await this.installDashboards();
    }

    if (this.globalExport) {
      await this.exportGlobalServices();
    }

    let accessHint;
    if (this.grafanaTls?.enabled && this.grafanaHostname) {
      accessHint = `Access at https://${this.grafanaHostname}/`;
    } else if (this.grafanaServiceType === 'LoadBalancer') {
      accessHint = `kubectl get svc kube-prometheus-stack-grafana -n ${this.namespace}`;
    } else {
      accessHint = `kubectl port-forward svc/kube-prometheus-stack-grafana -n ${this.namespace} 3000:80 then open http://localhost:3000/ (login: ${this.grafanaAdminUsername} / $GRAFANA_ADMIN_PASSWORD)`;
    }
    this.log(`Telemetry stack installed. ${accessHint}`, 'success');
  }

  /**
   * The 3 OTel collectors (full mode, east only): metrics scrapes local control
   * planes; logs + traces receive OTLP from local gateways.
   */
  async installOtelCollectors() {
    this.log('Installing OTel collectors (metrics/logs/traces)...', 'info');
    const helmCtxArgs = this.kubeContext ? ['--kube-context', this.kubeContext] : [];
    const replacements = {
      '{{TELEMETRY_NAMESPACE}}': this.namespace,
      '{{SOLO_UI_NAMESPACE}}': this.soloUiNamespace,
      '{{AGENTREGISTRY_NAMESPACE}}': this.agentregistryNamespace,
      '{{CLUSTER_NAME}}': this.clusterName,
    };
    const fill = tmpl =>
      Object.entries(replacements).reduce((s, [k, v]) => s.replaceAll(k, v), tmpl);

    await this.installOtelChart(
      OTEL_METRICS_RELEASE,
      fill(readFileSync(join(CONFIG_DIR, 'otel-metrics-values.yaml'), 'utf8')),
      helmCtxArgs
    );
    await this.installOtelChart(
      OTEL_LOGS_RELEASE,
      fill(readFileSync(join(CONFIG_DIR, 'otel-logs-values.yaml'), 'utf8')),
      helmCtxArgs
    );
    await this.installOtelChart(
      OTEL_TRACES_RELEASE,
      fill(readFileSync(join(CONFIG_DIR, 'otel-traces-values.yaml'), 'utf8')),
      helmCtxArgs
    );
    this.log('OTel collectors installed', 'info');
  }

  /** OTel gateway collector (full mode, east only): central fan-out for cross-cluster signals from west. */
  async installOtelGateway() {
    this.log('Installing OTel gateway (cross-cluster receiver)...', 'info');
    const helmCtxArgs = this.kubeContext ? ['--kube-context', this.kubeContext] : [];
    const replacements = {
      '{{TELEMETRY_NAMESPACE}}': this.namespace,
      '{{SOLO_UI_NAMESPACE}}': this.soloUiNamespace,
      '{{AGENTREGISTRY_NAMESPACE}}': this.agentregistryNamespace,
    };
    const fill = tmpl =>
      Object.entries(replacements).reduce((s, [k, v]) => s.replaceAll(k, v), tmpl);

    await this.installOtelChart(
      OTEL_GATEWAY_RELEASE,
      fill(readFileSync(join(CONFIG_DIR, 'otel-gateway-values.yaml'), 'utf8')),
      helmCtxArgs
    );
    this.log('OTel gateway installed', 'info');
  }

  /**
   * gloo-extensions-config ConfigMap (gloo-mesh ns): points ztunnel + istiod tracing at the
   * local otel-traces collector. Same on east and west since OTEL_TRACES_RELEASE name matches.
   */
  async applyAmbientTracingConfig() {
    const fqdn = `${OTEL_TRACES_RELEASE}.${this.namespace}.svc.cluster.local`;
    this.log(`Applying ambient tracing config → ${fqdn}`, 'info');
    await this.applyResource(
      {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: {
          name: 'gloo-extensions-config',
          namespace: 'gloo-mesh',
        },
        data: {
          'values.istio-ztunnel': [
            'l7Telemetry:',
            '  distributedTracing:',
            '    enabled: true',
            `    otlpEndpoint: "http://${fqdn}:4317"`,
          ].join('\n'),
          'values.istiod': [
            'meshConfig:',
            '  enableTracing: true',
            '  extensionProviders:',
            '  - name: ambient-tracing',
            '    opentelemetry:',
            '      port: 4317',
            `      service: ${fqdn}`,
          ].join('\n'),
        },
      },
      this.kubeContext
    );

    // Activate the OTel tracing provider mesh-wide via the Telemetry API.
    await this.applyResource(
      {
        apiVersion: 'telemetry.istio.io/v1',
        kind: 'Telemetry',
        metadata: {
          name: 'mesh-default-tracing',
          namespace: 'istio-system',
          labels: {
            'app.kubernetes.io/managed-by': 'agentic-demo',
            'agentic.demo/feature': 'telemetry',
          },
        },
        spec: {
          tracing: [{ providers: [{ name: 'ambient-tracing' }], randomSamplingPercentage: 100 }],
        },
      },
      this.kubeContext
    );

    this.log('Ambient tracing config applied', 'info');
  }

  /**
   * Label the OTel gateway as a global service so agent-mode clusters can reach it.
   * Loki/Prometheus/Tempo are NOT exported; all signals route through the gateway.
   */
  async exportGlobalServices() {
    this.log('Exporting OTel gateway as global service...', 'info');
    const ctxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];
    await KubernetesHelper.kubectl([
      ...ctxArgs,
      'label',
      'service',
      OTEL_GATEWAY_RELEASE,
      '-n',
      this.namespace,
      'solo.io/service-scope=global',
      '--overwrite',
    ]);
    this.log('OTel gateway labeled as global service', 'info');
  }

  /**
   * Telemetry agent for a spoke cluster: OTel collectors + Alloy, no local storage
   * (all telemetry ships cross-cluster to the east management cluster).
   */
  async deployAgent() {
    this.log('Installing telemetry agent (OTel collectors + Alloy)...', 'info');

    await KubernetesHelper.ensureNamespace(this.namespace, this.spinner, this.kubeContext);
    // Ambient label makes ztunnel proxy DNS, required to resolve *.mesh.internal hostnames (e.g. otel-gateway).
    await KubernetesHelper.labelNamespaceForAmbient(this.namespace, this.kubeContext, {
      quiet: true,
    });
    this.log(`Namespace '${this.namespace}' ready`, 'info');

    const helmCtxArgs = this.kubeContext ? ['--kube-context', this.kubeContext] : [];
    const replacements = {
      '{{OTEL_GATEWAY_ENDPOINT}}': this.otelGatewayEndpoint,
      '{{LOKI_PUSH_URL}}': this.lokiPushUrl,
      '{{CLUSTER_NAME}}': this.clusterName,
    };
    const fill = tmpl =>
      Object.entries(replacements).reduce((s, [k, v]) => s.replaceAll(k, v), tmpl);

    await this.installOtelChart(
      OTEL_METRICS_RELEASE,
      fill(readFileSync(join(CONFIG_DIR, 'otel-metrics-agent-values.yaml'), 'utf8')),
      helmCtxArgs
    );
    await this.installOtelChart(
      OTEL_LOGS_RELEASE,
      fill(readFileSync(join(CONFIG_DIR, 'otel-logs-agent-values.yaml'), 'utf8')),
      helmCtxArgs
    );
    await this.installOtelChart(
      OTEL_TRACES_RELEASE,
      fill(readFileSync(join(CONFIG_DIR, 'otel-traces-agent-values.yaml'), 'utf8')),
      helmCtxArgs
    );

    await this.installAlloyAgent(
      fill(readFileSync(join(CONFIG_DIR, 'alloy-agent-values.yaml'), 'utf8')),
      helmCtxArgs
    );

    this.log(
      'Telemetry agent installed. All signals → east OTel gateway; pod logs → east Loki (Alloy)',
      'success'
    );
  }

  async installOtelChart(release, valuesContent, helmCtxArgs) {
    const valuesFile = join(tmpdir(), `.telemetry-${release}-${process.pid}.yaml`);
    writeFileSync(valuesFile, valuesContent);
    try {
      await KubernetesHelper.helm(
        [
          'upgrade',
          '-i',
          release,
          'opentelemetry-collector',
          '--repo',
          OTEL_HELM_REPO,
          '--version',
          this.otelChartVersion,
          '--set',
          'mode=deployment',
          '--set',
          'image.repository=ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib',
          '--set',
          'command.name=otelcol-contrib',
          '-n',
          this.namespace,
          '--create-namespace',
          '-f',
          valuesFile,
          ...helmCtxArgs,
        ],
        { spinner: this.spinner }
      );
    } finally {
      if (existsSync(valuesFile)) {
        try {
          unlinkSync(valuesFile);
        } catch {
          /* best effort */
        }
      }
    }
  }

  async installAlloyAgent(valuesContent, helmCtxArgs) {
    this.log('Installing Grafana Alloy (agent)...', 'info');
    const valuesFile = join(tmpdir(), `.telemetry-alloy-agent-${process.pid}.yaml`);
    writeFileSync(valuesFile, valuesContent);
    try {
      await CommandRunner.run(
        'helm',
        ['repo', 'add', 'grafana', 'https://grafana.github.io/helm-charts'],
        { ignoreError: true }
      );
      await CommandRunner.run('helm', ['repo', 'update', 'grafana'], { ignoreError: true });
      await KubernetesHelper.helm(
        [
          'upgrade',
          '-i',
          'alloy',
          'grafana/alloy',
          '--version',
          this.alloyVersion,
          '-n',
          this.namespace,
          '--create-namespace',
          '-f',
          valuesFile,
          ...helmCtxArgs,
        ],
        { spinner: this.spinner }
      );
    } finally {
      if (existsSync(valuesFile)) {
        try {
          unlinkSync(valuesFile);
        } catch {
          /* best effort */
        }
      }
    }
    await this.waitForDaemonSet('alloy', 120);
    this.log('Alloy installed', 'info');
  }

  /** Install Grafana Tempo Distributed (trace aggregation, OTLP receiver). */
  async installTempo() {
    this.log('Installing Grafana Tempo...', 'info');

    await CommandRunner.run(
      'helm',
      ['repo', 'add', 'grafana', 'https://grafana.github.io/helm-charts'],
      { ignoreError: true }
    );
    await CommandRunner.run('helm', ['repo', 'update', 'grafana'], { ignoreError: true });

    const helmArgs = [
      'upgrade',
      '-i',
      'tempo',
      'grafana/tempo-distributed',
      '-n',
      this.namespace,
      '--version',
      this.tempoVersion,
      '-f',
      join(CONFIG_DIR, 'tempo-values.yaml'),
      '--create-namespace',
      '--wait',
      ...(this.tempoHostname
        ? [
            '--set',
            `queryFrontend.service.annotations.external-dns\\.alpha\\.kubernetes\\.io/hostname=${this.tempoHostname}`,
          ]
        : []),
      ...(this.storageClass
        ? [
            '--set',
            `ingester.persistence.storageClass=${this.storageClass}`,
            '--set',
            `ingester.persistence.size=${this.storageSize}`,
            '--set',
            `compactor.persistence.storageClass=${this.storageClass}`,
            '--set',
            `compactor.persistence.size=${this.storageSize}`,
            '--set',
            `metricsGenerator.persistence.storageClass=${this.storageClass}`,
            '--set',
            `metricsGenerator.persistence.size=${this.storageSize}`,
          ]
        : []),
      ...(this.kubeContext ? ['--kube-context', this.kubeContext] : []),
    ];
    await KubernetesHelper.helm(helmArgs, { spinner: this.spinner });
    await KubernetesHelper.assertHelmDeployed('tempo', this.namespace, this.kubeContext);

    await this.waitForDeployment('tempo-distributor', 120);
    await this.waitForDeployment('tempo-query-frontend', 120);
    this.log('Tempo installed', 'info');
  }

  /** Install Grafana Loki (log aggregation). */
  async installLoki() {
    this.log('Installing Grafana Loki...', 'info');

    await CommandRunner.run(
      'helm',
      ['repo', 'add', 'grafana', 'https://grafana.github.io/helm-charts'],
      { ignoreError: true }
    );
    await CommandRunner.run('helm', ['repo', 'update', 'grafana'], { ignoreError: true });

    const helmArgs = [
      'upgrade',
      '-i',
      'loki',
      'grafana/loki',
      '-n',
      this.namespace,
      '--version',
      this.lokiVersion,
      '-f',
      join(CONFIG_DIR, 'loki-values.yaml'),
      '--create-namespace',
      '--wait',
      '--set',
      `loki.limits_config.retention_period=${this.retention}`,
      '--set',
      `loki.limits_config.reject_old_samples_max_age=${this.retention}`,
      ...(this.lokiHostname
        ? [
            '--set',
            `singleBinary.service.annotations.external-dns\\.alpha\\.kubernetes\\.io/hostname=${this.lokiHostname}`,
          ]
        : []),
      ...this.buildNodeSelectorArgs('singleBinary'),
      ...(this.storageClass
        ? [
            '--set',
            `minio.storageClass=${this.storageClass}`,
            '--set',
            `minio.persistence.size=${this.storageSize}`,
            '--set',
            `singleBinary.persistence.storageClass=${this.storageClass}`,
            '--set',
            `singleBinary.persistence.size=${this.storageSize}`,
          ]
        : []),
      ...(this.kubeContext ? ['--kube-context', this.kubeContext] : []),
    ];
    await KubernetesHelper.helm(helmArgs, { spinner: this.spinner });
    await KubernetesHelper.assertHelmDeployed('loki', this.namespace, this.kubeContext);

    await this.waitForStatefulSet('loki', 120);
    this.log('Loki installed', 'info');
  }

  /** Install Grafana Alloy (pod log scraping DaemonSet). */
  async installAlloy() {
    this.log('Installing Grafana Alloy for log collection...', 'info');

    const helmArgs = [
      'upgrade',
      '-i',
      'alloy',
      'grafana/alloy',
      '-n',
      this.namespace,
      '--version',
      this.alloyVersion,
      '-f',
      join(CONFIG_DIR, 'alloy-values.yaml'),
      '--create-namespace',
      '--wait',
      ...(this.kubeContext ? ['--kube-context', this.kubeContext] : []),
    ];
    await KubernetesHelper.helm(helmArgs, { spinner: this.spinner });
    await KubernetesHelper.assertHelmDeployed('alloy', this.namespace, this.kubeContext);

    await this.waitForDaemonSet('alloy', 120);
    this.log('Alloy installed', 'info');
  }

  /** Install kube-prometheus-stack; Grafana comes preconfigured with Prometheus/Tempo/Loki datasources. */
  async installPrometheusStack() {
    this.log('Installing Prometheus and Grafana (kube-prometheus-stack)...', 'info');

    await CommandRunner.run(
      'helm',
      ['repo', 'add', 'prometheus-community', 'https://prometheus-community.github.io/helm-charts'],
      { ignoreError: true }
    );
    await CommandRunner.run('helm', ['repo', 'update', 'prometheus-community'], {
      ignoreError: true,
    });

    // The Grafana sidecar reloads datasources via the admin API, so the reload URL
    // must carry the admin credentials (URL-encoded).
    const reloadUrl = `http://${encodeURIComponent(this.grafanaAdminUsername)}:${encodeURIComponent(
      this.grafanaAdminPassword
    )}@localhost:3000/api/admin/provisioning/datasources/reload`;

    const helmArgs = [
      'upgrade',
      '-i',
      'kube-prometheus-stack',
      'prometheus-community/kube-prometheus-stack',
      '-n',
      this.namespace,
      '--version',
      this.prometheusStackVersion,
      '-f',
      join(CONFIG_DIR, 'prometheus-values.yaml'),
      '--create-namespace',
      '--wait',
      '--timeout',
      '10m',
      '--set',
      `prometheus.prometheusSpec.retention=${this.retention}`,
      '--set',
      `grafana.service.type=${this.grafanaServiceType}`,
      '--set-string',
      `grafana.adminUser=${helmSetEscape(this.grafanaAdminUsername)}`,
      '--set-string',
      `grafana.adminPassword=${helmSetEscape(this.grafanaAdminPassword)}`,
      '--set-string',
      `grafana.sidecar.datasources.reloadURL=${reloadUrl}`,
      ...this.buildNodeSelectorArgs('prometheus.prometheusSpec'),
      ...this.buildNodeSelectorArgs('grafana'),
    ];

    if (this.grafanaHostname) {
      helmArgs.push(
        '--set',
        `grafana.service.annotations.external-dns\\.alpha\\.kubernetes\\.io/hostname=${this.grafanaHostname}`
      );
    }
    if (this.prometheusHostname) {
      helmArgs.push(
        '--set',
        `prometheus.service.annotations.external-dns\\.alpha\\.kubernetes\\.io/hostname=${this.prometheusHostname}`
      );
    }

    if (this.storageClass) {
      helmArgs.push(
        '--set',
        `prometheus.prometheusSpec.storageSpec.volumeClaimTemplate.spec.storageClassName=${this.storageClass}`,
        '--set',
        'prometheus.prometheusSpec.storageSpec.volumeClaimTemplate.spec.resources.requests.storage=50Gi'
      );
    }

    if (this.kubeContext) {
      helmArgs.push('--kube-context', this.kubeContext);
    }

    let oidcValuesFile = null;
    try {
      if (this.grafanaOidc?.enabled && this.grafanaHostname) {
        oidcValuesFile = await this.buildGrafanaOidcValuesFile();
        helmArgs.push('-f', oidcValuesFile);
      }
      await KubernetesHelper.helm(helmArgs, { spinner: this.spinner });
    } finally {
      if (oidcValuesFile) {
        try {
          await unlink(oidcValuesFile);
        } catch {
          /* ignore */
        }
      }
    }

    await KubernetesHelper.assertHelmDeployed(
      'kube-prometheus-stack',
      this.namespace,
      this.kubeContext
    );

    await this.waitForDeployment('kube-prometheus-stack-operator', 120);
    await this.waitForDeployment('kube-prometheus-stack-grafana', 120);
    await this.waitForStatefulSet('prometheus-kube-prometheus-stack-prometheus', 120);
    this.log('kube-prometheus-stack installed', 'info');
  }

  /**
   * Grafana datasources as a labeled ConfigMap. The sidecar runs with initDatasources: true
   * (init container), writing it before Grafana starts to avoid a reload race. URLs use the
   * configured namespace so non-default namespaces work.
   */
  async installDatasources() {
    this.log('Installing Grafana datasources...', 'info');

    const template = await readFile(join(CONFIG_DIR, 'grafana-datasources.yaml'), 'utf8');
    const content = template.replaceAll('{{TELEMETRY_NAMESPACE}}', this.namespace);

    await this.applyResource(
      {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: {
          name: 'grafana-datasources',
          namespace: this.namespace,
          labels: {
            grafana_datasource: '1',
            'app.kubernetes.io/managed-by': 'agentic-demo',
          },
        },
        data: {
          'datasources.yaml': content,
        },
      },
      this.kubeContext
    );

    this.log('Grafana datasources installed', 'info');
  }

  /**
   * Install Solo Istio Grafana dashboards: local dashboards/ JSON first, else download
   * from Solo COP. ConfigMaps labeled grafana_dashboard=1 for the kube-prometheus-stack sidecar.
   */
  async installDashboards() {
    this.log('Installing Solo Istio Grafana dashboards...', 'info');

    // Prefer local JSON files
    if (existsSync(DASHBOARDS_DIR)) {
      const files = await readdir(DASHBOARDS_DIR);
      const jsonFiles = files.filter(f => f.endsWith('.json'));

      if (jsonFiles.length > 0) {
        for (const file of jsonFiles) {
          const name = file.replace('.json', '');
          const content = await readFile(join(DASHBOARDS_DIR, file), 'utf8');
          await this.createDashboardConfigMap(name, content);
          this.log(`Dashboard '${name}' applied from local file`, 'info');
        }
        return;
      }
    }

    // Download from Solo COP GitHub
    for (const dashboard of SOLO_COP_DASHBOARDS) {
      const url = `${SOLO_COP_GRAFANA_BASE}/${dashboard}.json`;
      try {
        const result = await CommandRunner.run('curl', ['-sSfL', url], { captureOutput: true });
        await this.createDashboardConfigMap(dashboard, result.stdout);
        this.log(`Dashboard '${dashboard}' downloaded and applied`, 'info');
      } catch (error) {
        this.log(
          `Warning: Could not install dashboard '${dashboard}' from ${url}: ${error.message}`,
          'warn'
        );
      }
    }
  }

  /**
   * Normalize dashboard JSON for ConfigMap provisioning:
   * 1. Resolve __inputs vars (e.g. ${DS_PROMETHEUS}); the ConfigMap sidecar doesn't (unlike
   *    the UI importer), so map each input's pluginId to the configured datasource UID.
   * 2. Rewrite hardcoded community-dashboard UIDs to the kube-prometheus-stack ones (prometheus/tempo/loki).
   */
  normalizeDashboardJson(jsonContent) {
    const PLUGIN_TO_UID = { prometheus: 'prometheus', tempo: 'tempo', loki: 'loki' };

    // Known hardcoded UIDs from community dashboards → canonical UID
    const HARDCODED_UID_MAP = {
      PBFA97CFB590B2093: 'prometheus', // Prometheus default in many exported dashboards
    };

    let json;
    try {
      json = JSON.parse(jsonContent);
    } catch {
      return jsonContent;
    }

    // Build substitution map from __inputs
    const inputMap = {};
    for (const input of json.__inputs || []) {
      if (input.type === 'datasource' && PLUGIN_TO_UID[input.pluginId]) {
        inputMap[`\${${input.name}}`] = PLUGIN_TO_UID[input.pluginId];
      }
    }

    let normalized = JSON.stringify(json);

    // Replace __inputs placeholders (e.g. "${DS_PROMETHEUS}" → "prometheus")
    for (const [placeholder, uid] of Object.entries(inputMap)) {
      normalized = normalized.replaceAll(`"${placeholder}"`, `"${uid}"`);
    }

    // Replace known hardcoded UIDs
    for (const [badUid, goodUid] of Object.entries(HARDCODED_UID_MAP)) {
      normalized = normalized.replaceAll(`"${badUid}"`, `"${goodUid}"`);
    }

    return normalized;
  }

  /** Dashboard ConfigMap; the kube-prometheus-stack Grafana sidecar watches for grafana_dashboard=1. */
  async createDashboardConfigMap(name, jsonContent) {
    await this.applyResource(
      {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: {
          name: `grafana-dashboard-${name}`,
          namespace: this.namespace,
          labels: {
            grafana_dashboard: '1',
            'app.kubernetes.io/managed-by': 'agentic-demo',
          },
        },
        data: {
          [`${name}.json`]: this.normalizeDashboardJson(jsonContent),
        },
      },
      this.kubeContext
    );
  }

  async cleanup() {
    if (this.mode === 'agent') {
      return this.cleanupAgent();
    }
    return this.cleanupFull();
  }

  async cleanupFull() {
    this.log('Cleaning up telemetry stack...', 'info');

    // Remove datasource ConfigMap
    await this.deleteResource('configmap', 'grafana-datasources', this.namespace, this.kubeContext);

    // Remove dashboard ConfigMaps
    const dashboardNames = [...SOLO_COP_DASHBOARDS];
    if (existsSync(DASHBOARDS_DIR)) {
      try {
        const files = await readdir(DASHBOARDS_DIR);
        for (const file of files.filter(f => f.endsWith('.json'))) {
          dashboardNames.push(file.replace('.json', ''));
        }
      } catch {
        // Ignore
      }
    }
    for (const name of [...new Set(dashboardNames)]) {
      await this.deleteResource(
        'configmap',
        `grafana-dashboard-${name}`,
        this.namespace,
        this.kubeContext
      );
    }

    // Remove Grafana HTTPS Gateway resources
    if (this.grafanaTls?.enabled && this.grafanaHostname) {
      const secretName = this.grafanaTls.secretName || 'grafana-tls';
      await this.deleteResource('HTTPRoute', 'grafana', this.namespace, this.kubeContext);
      await this.deleteResource('Gateway', 'grafana-https', this.namespace, this.kubeContext);
      await this.deleteResource('Certificate', secretName, this.namespace, this.kubeContext);
    }

    // Remove global service labels
    if (this.globalExport) {
      const ctxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];
      for (const svc of [OTEL_GATEWAY_RELEASE]) {
        try {
          await KubernetesHelper.kubectl([
            ...ctxArgs,
            'label',
            'service',
            svc,
            '-n',
            this.namespace,
            'solo.io/service-scope-',
            '--ignore-not-found=true',
          ]);
        } catch {
          /* best effort */
        }
      }
    }

    // Uninstall Helm releases (reverse install order, including OTel collectors if installed)
    const helmCtxArgs = this.kubeContext ? ['--kube-context', this.kubeContext] : [];
    const releasesToUninstall = ['alloy', 'loki', 'tempo', 'kube-prometheus-stack'];

    if (this.shouldInstallOtelCollectors) {
      releasesToUninstall.push(
        OTEL_GATEWAY_RELEASE,
        OTEL_TRACES_RELEASE,
        OTEL_LOGS_RELEASE,
        OTEL_METRICS_RELEASE
      );
    }

    for (const release of releasesToUninstall) {
      try {
        await CommandRunner.run('helm', [
          ...helmCtxArgs,
          'uninstall',
          release,
          '-n',
          this.namespace,
        ]);
      } catch (error) {
        if (!/not found|no deployed releases/i.test(error.message)) {
          this.log(`helm uninstall ${release}: ${error.message}`, 'warn');
        }
      }
    }

    const ctxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];
    await KubernetesHelper.kubectl([
      ...ctxArgs,
      'delete',
      'namespace',
      this.namespace,
      '--ignore-not-found=true',
    ]);

    this.log('Telemetry stack cleaned up', 'success');
  }

  async cleanupAgent() {
    this.log('Cleaning up telemetry agent...', 'info');

    const helmCtxArgs = this.kubeContext ? ['--kube-context', this.kubeContext] : [];
    for (const release of ['alloy', OTEL_METRICS_RELEASE, OTEL_LOGS_RELEASE, OTEL_TRACES_RELEASE]) {
      try {
        await CommandRunner.run('helm', [
          ...helmCtxArgs,
          'uninstall',
          release,
          '-n',
          this.namespace,
        ]);
      } catch (error) {
        if (!/not found|no deployed releases/i.test(error.message)) {
          this.log(`helm uninstall ${release}: ${error.message}`, 'warn');
        }
      }
    }

    const ctxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];
    await KubernetesHelper.kubectl([
      ...ctxArgs,
      'delete',
      'namespace',
      this.namespace,
      '--ignore-not-found=true',
    ]);

    this.log('Telemetry agent cleaned up', 'success');
  }

  async waitForDeployment(name, timeout = 120) {
    try {
      await KubernetesHelper.waitForDeployment(
        this.namespace,
        name,
        timeout,
        this.spinner,
        this.kubeContext
      );
    } catch (_error) {
      this.log(`Deployment ${name} may take longer to be ready`, 'warn');
    }
  }

  async waitForStatefulSet(name, timeout = 120) {
    const ctxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];
    try {
      await KubernetesHelper.kubectl(
        [
          ...ctxArgs,
          'wait',
          '--for=condition=ready',
          `statefulset/${name}`,
          '-n',
          this.namespace,
          `--timeout=${timeout}s`,
        ],
        { spinner: this.spinner }
      );
    } catch (_error) {
      this.log(`StatefulSet ${name} may take longer to be ready`, 'warn');
    }
  }

  async waitForDaemonSet(name, timeout = 120) {
    const ctxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];
    try {
      await KubernetesHelper.kubectl(
        [
          ...ctxArgs,
          'rollout',
          'status',
          `daemonset/${name}`,
          '-n',
          this.namespace,
          `--timeout=${timeout}s`,
        ],
        { spinner: this.spinner }
      );
    } catch (_error) {
      this.log(`DaemonSet ${name} may take longer to be ready`, 'warn');
    }
  }
}
