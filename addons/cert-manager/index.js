import { AddonFeature } from '../../src/lib/feature.js';
import { KubernetesHelper, CommandRunner } from '../../src/lib/common.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_DIR = join(__dirname, 'config');

// Helm chart version
const CERT_MANAGER_CHART_VERSION = '1.20.2';

/**
 * Installs cert-manager (CRDs, controller, webhook, cainjector) for TLS certificate
 * management. Optionally creates a Let's Encrypt DNS-01 (Route53 or Google Cloud DNS)
 * ClusterIssuer.
 * https://cert-manager.io/docs/installation/helm/
 *
 * letsencrypt config:
 * {
 *   enabled: boolean,
 *   staging: boolean,
 *   email: string,
 *   provider: string,          // 'route53' (default) | 'clouddns' | 'cloudflare'
 *   region: string,            // route53 only. Default: 'us-east-1'
 *   project: string,           // clouddns only. Required (or GCP_PROJECT env var)
 *   gcpServiceAccount: string, // clouddns only -- GSA email for the Workload Identity
 *                              // annotation on the controller's ServiceAccount (ADC, no key file)
 * }
 * // cloudflare has no ambient-credential mechanism like IRSA/Workload Identity -- the API
 * // token is read from CLOUDFLARE_API_TOKEN and stored in a Secret the solver references.
 */
export class CertManagerFeature extends AddonFeature {
  constructor(name, config) {
    super(name, config);
    this.chartVersion = config.version || CERT_MANAGER_CHART_VERSION;
    this.certManagerNamespace = config.certManagerNamespace || 'cert-manager';
    this.shouldInstallCRDs = config.installCRDs !== false;
    this.webhookEnabled = config.webhook?.enabled !== false;
    this.cainjectorEnabled = config.cainjector?.enabled !== false;
    // Let's Encrypt DNS-01 issuer config
    this.letsencryptEnabled = config.letsencrypt?.enabled === true;
    this.letsencryptStaging = config.letsencrypt?.staging === true;
    this.letsencryptEmail = config.letsencrypt?.email || '';
    this.letsencryptProvider = config.letsencrypt?.provider || 'route53';
    this.letsencryptRegion = config.letsencrypt?.region || 'us-east-1';
    this.letsencryptProject = config.letsencrypt?.project || process.env.GCP_PROJECT || null;
    this.gcpServiceAccount = config.letsencrypt?.gcpServiceAccount || null;
    this.cloudflareApiTokenSecretName = 'cert-manager-cloudflare-api-token';
    this.kubeContext = config.kubeContext || null;
  }

  validate() {
    if (
      this.letsencryptEnabled &&
      !['route53', 'clouddns', 'cloudflare'].includes(this.letsencryptProvider)
    ) {
      throw new Error(
        `cert-manager: letsencrypt.provider '${this.letsencryptProvider}' not supported. Supported: route53, clouddns, cloudflare.`
      );
    }
    if (
      this.letsencryptEnabled &&
      this.letsencryptProvider === 'clouddns' &&
      !this.letsencryptProject
    ) {
      throw new Error(
        'cert-manager: letsencrypt.project (or GCP_PROJECT environment variable) is required for letsencrypt.provider=clouddns'
      );
    }
    if (
      this.letsencryptEnabled &&
      this.letsencryptProvider === 'cloudflare' &&
      !process.env.CLOUDFLARE_API_TOKEN
    ) {
      throw new Error(
        'cert-manager: CLOUDFLARE_API_TOKEN environment variable is required for letsencrypt.provider=cloudflare'
      );
    }
    return true;
  }

  async deploy() {
    this.log('Installing cert-manager...', 'info');

    if (this.shouldInstallCRDs) {
      await this.installCRDs();
    }

    await KubernetesHelper.ensureNamespace(
      this.certManagerNamespace,
      this.spinner,
      this.kubeContext
    );
    this.log(`Namespace '${this.certManagerNamespace}' ready`, 'info');

    await this.addHelmRepo();
    await this.installCertManager();
    await this.waitForCertManager();
    await this.createSelfSignedIssuer();

    if (this.letsencryptEnabled && this.letsencryptEmail) {
      if (this.letsencryptProvider === 'cloudflare') {
        await this.createCloudflareApiTokenSecret();
      }
      await this.createLetsEncryptDnsIssuer();
    }

    this.log('cert-manager installed successfully', 'success');
  }

  async installCRDs() {
    this.log('Installing cert-manager CRDs...', 'info');

    const crdUrl = `https://github.com/cert-manager/cert-manager/releases/download/v${this.chartVersion}/cert-manager.crds.yaml`;
    const ctxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];

    try {
      await KubernetesHelper.kubectl([...ctxArgs, 'apply', '-f', crdUrl], {
        spinner: this.spinner,
      });
      this.log('cert-manager CRDs installed', 'info');
    } catch (error) {
      throw new Error(`Failed to install cert-manager CRDs: ${error.message}`);
    }
  }

  async addHelmRepo() {
    this.log('Adding Jetstack Helm repository...', 'info');

    try {
      await CommandRunner.run('helm', ['repo', 'add', 'jetstack', 'https://charts.jetstack.io'], {
        ignoreError: true,
      }); // Ignore if repo already exists

      await CommandRunner.run('helm', ['repo', 'update', 'jetstack']);

      this.log('Jetstack Helm repository added and updated', 'info');
    } catch (error) {
      throw new Error(`Failed to add Helm repository: ${error.message}`);
    }
  }

  async installCertManager() {
    this.log('Installing cert-manager Helm chart...', 'info');

    const helmArgs = [
      'upgrade',
      '-i',
      'cert-manager',
      'jetstack/cert-manager',
      '-n',
      this.certManagerNamespace,
      '--version',
      this.chartVersion,
      '--create-namespace',
      '--wait',
      '--timeout',
      '5m',
    ];

    const valuesFile = join(CONFIG_DIR, 'values.yaml');
    try {
      const fs = await import('fs/promises');
      await fs.access(valuesFile);
      helmArgs.push('-f', valuesFile);
    } catch {
      // no values file, use chart defaults
    }

    if (!this.webhookEnabled) {
      helmArgs.push('--set', 'webhook.enabled=false');
    }

    if (!this.cainjectorEnabled) {
      helmArgs.push('--set', 'cainjector.enabled=false');
    }

    if (this.letsencryptProvider === 'clouddns' && this.gcpServiceAccount) {
      // Workload Identity: annotate the controller's KSA so it assumes the GSA via ADC
      // for the Cloud DNS DNS-01 solver -- no key file. Dots in the annotation key must
      // be escaped -- it's one literal key, not nested objects.
      helmArgs.push(
        '--set-string',
        `serviceAccount.annotations.iam\\.gke\\.io/gcp-service-account=${this.gcpServiceAccount}`
      );
    }

    if (this.kubeContext) {
      helmArgs.push('--kube-context', this.kubeContext);
    }

    await KubernetesHelper.helm(helmArgs, this.spinner);
    await KubernetesHelper.assertHelmDeployed(
      'cert-manager',
      this.certManagerNamespace,
      this.kubeContext
    );
    this.log('cert-manager Helm chart installed', 'info');
  }

  async waitForCertManager() {
    this.log('Waiting for cert-manager to be ready...', 'info');

    const deployments = ['cert-manager', 'cert-manager-webhook', 'cert-manager-cainjector'];

    for (const deployment of deployments) {
      if (deployment === 'cert-manager-webhook' && !this.webhookEnabled) {
        continue;
      }
      if (deployment === 'cert-manager-cainjector' && !this.cainjectorEnabled) {
        continue;
      }

      try {
        await KubernetesHelper.waitForDeployment(
          this.certManagerNamespace,
          deployment,
          300,
          this.spinner,
          this.kubeContext
        );
      } catch (error) {
        this.log(`Warning: Deployment ${deployment} may not be ready: ${error.message}`, 'warn');
      }
    }

    this.log('cert-manager is ready', 'info');
  }

  /**
   * Apply a webhook-admitted resource (e.g. ClusterIssuer) with retries. The webhook
   * Deployment can report Ready before cainjector provisions its serving cert, so the
   * first apply after waitForCertManager() can fail with "failed calling webhook ...
   * context deadline exceeded". Retrying with a short delay clears it.
   */
  async #applyWithWebhookRetry(resource, context, { retries = 5, delayMs = 5000 } = {}) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await this.applyResource(resource, context);
        return;
      } catch (error) {
        const isWebhookNotReady = /failed calling webhook|context deadline exceeded/i.test(
          error.message
        );
        if (!isWebhookNotReady || attempt === retries) {
          throw error;
        }
        this.log(`cert-manager webhook not ready yet, retrying (${attempt}/${retries})...`, 'warn');
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  async createSelfSignedIssuer() {
    this.log('Creating self-signed ClusterIssuer...', 'info');

    const issuer = {
      apiVersion: 'cert-manager.io/v1',
      kind: 'ClusterIssuer',
      metadata: { name: 'selfsigned-issuer' },
      spec: { selfSigned: {} },
    };

    try {
      await this.#applyWithWebhookRetry(issuer, this.kubeContext);
      this.log('Self-signed ClusterIssuer created', 'info');
    } catch (error) {
      throw new Error(`Failed to create self-signed ClusterIssuer: ${error.message}`);
    }
  }

  /**
   * Reconcile the Secret the cloudflare DNS-01 solver's apiTokenSecretRef points at. Always
   * re-applied (not skip-if-exists) since the token can rotate.
   */
  async createCloudflareApiTokenSecret() {
    this.log('Reconciling Cloudflare API token secret...', 'info');

    const ctxFlag = this.kubeContext ? `--context=${this.kubeContext}` : '';
    const ctxStr = ctxFlag ? `${ctxFlag} ` : '';

    const result = await CommandRunner.exec(
      `kubectl ${ctxStr}create secret generic ${this.cloudflareApiTokenSecretName} -n ${this.certManagerNamespace} --from-literal=api-token="${process.env.CLOUDFLARE_API_TOKEN}" --dry-run=client -o yaml | kubectl ${ctxStr}apply -f -`,
      { ignoreError: true }
    );
    if (result.exitCode) {
      throw new Error(
        `Failed to reconcile ${this.cloudflareApiTokenSecretName}: ${result.stderr?.trim()}`
      );
    }
  }

  /**
   * Create Let's Encrypt DNS-01 ClusterIssuer for Route53 (IRSA), Google Cloud DNS (Workload
   * Identity), or Cloudflare (API token Secret, no ambient-credential mechanism available).
   */
  async createLetsEncryptDnsIssuer() {
    const acmeServer = this.letsencryptStaging
      ? 'https://acme-staging-v02.api.letsencrypt.org/directory'
      : 'https://acme-v02.api.letsencrypt.org/directory';
    const envLabel = this.letsencryptStaging ? ' (staging)' : '';

    this.log(`Creating Let's Encrypt DNS-01 ClusterIssuer${envLabel}...`, 'info');

    const dns01 =
      this.letsencryptProvider === 'clouddns'
        ? { cloudDNS: { project: this.letsencryptProject } }
        : this.letsencryptProvider === 'cloudflare'
          ? {
              cloudflare: {
                apiTokenSecretRef: { name: this.cloudflareApiTokenSecretName, key: 'api-token' },
              },
            }
          : { route53: { region: this.letsencryptRegion } };

    const issuer = {
      apiVersion: 'cert-manager.io/v1',
      kind: 'ClusterIssuer',
      metadata: {
        name: 'letsencrypt-dns',
        labels: { 'app.kubernetes.io/managed-by': 'agentic-demo' },
      },
      spec: {
        acme: {
          server: acmeServer,
          email: this.letsencryptEmail,
          privateKeySecretRef: { name: 'letsencrypt-dns' },
          solvers: [{ dns01 }],
        },
      },
    };

    try {
      await this.#applyWithWebhookRetry(issuer, this.kubeContext);
      this.log(`Let's Encrypt DNS-01 ClusterIssuer created${envLabel}`, 'info');
    } catch (error) {
      throw new Error(`Failed to create Let's Encrypt ClusterIssuer: ${error.message}`);
    }
  }

  async cleanup() {
    this.log('Cleaning up cert-manager...', 'info');

    const helmCtxArgs = this.kubeContext ? ['--kube-context', this.kubeContext] : [];
    const ctxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];

    try {
      await CommandRunner.run('helm', [
        ...helmCtxArgs,
        'uninstall',
        'cert-manager',
        '-n',
        this.certManagerNamespace,
      ]);
      this.log('cert-manager Helm chart uninstalled', 'info');
    } catch (error) {
      if (!/not found|no deployed releases/i.test(error.message)) throw error;
    }

    try {
      await KubernetesHelper.kubectl([
        ...ctxArgs,
        'delete',
        'clusterissuer',
        'selfsigned-issuer',
        '--ignore-not-found=true',
      ]);
      if (this.letsencryptEnabled) {
        await KubernetesHelper.kubectl([
          ...ctxArgs,
          'delete',
          'clusterissuer',
          'letsencrypt-dns',
          '--ignore-not-found=true',
        ]);
      }
    } catch (error) {
      if (!/doesn't have a resource type|no kind is registered/i.test(error.message)) throw error;
    }

    await KubernetesHelper.kubectl([
      ...ctxArgs,
      'delete',
      'namespace',
      this.certManagerNamespace,
      '--ignore-not-found=true',
    ]);

    this.log('cert-manager cleaned up', 'success');
  }
}
