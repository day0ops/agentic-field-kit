import { AddonFeature } from '../../src/lib/feature.js';
import { KubernetesHelper, CommandRunner } from '../../src/lib/common.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_DIR = join(__dirname, 'config');

// Helm chart version
const CERT_MANAGER_VERSION = 'v1.19.3';
const CERT_MANAGER_CHART_VERSION = '1.19.3';

/**
 * Installs cert-manager (CRDs, controller, webhook, cainjector) for TLS certificate
 * management. Optionally creates a Let's Encrypt DNS-01 (Route53) ClusterIssuer.
 * https://cert-manager.io/docs/installation/helm/
 */
export class CertManagerFeature extends AddonFeature {
  constructor(name, config) {
    super(name, config);
    this.certManagerNamespace = config.certManagerNamespace || 'cert-manager';
    this.shouldInstallCRDs = config.installCRDs !== false;
    this.webhookEnabled = config.webhook?.enabled !== false;
    this.cainjectorEnabled = config.cainjector?.enabled !== false;
    // Let's Encrypt DNS-01 issuer config (for Route53)
    this.letsencryptEnabled = config.letsencrypt?.enabled === true;
    this.letsencryptStaging = config.letsencrypt?.staging === true;
    this.letsencryptEmail = config.letsencrypt?.email || '';
    this.letsencryptRegion = config.letsencrypt?.region || 'us-east-1';
    this.kubeContext = config.kubeContext || null;
  }

  validate() {
    // All configuration is optional
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
      await this.createLetsEncryptDnsIssuer();
    }

    this.log('cert-manager installed successfully', 'success');
  }

  async installCRDs() {
    this.log('Installing cert-manager CRDs...', 'info');

    const crdUrl = `https://github.com/cert-manager/cert-manager/releases/download/${CERT_MANAGER_VERSION}/cert-manager.crds.yaml`;
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
      CERT_MANAGER_CHART_VERSION,
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
   * Create Let's Encrypt DNS-01 ClusterIssuer for Route53. Requires IRSA on the
   * cert-manager service account.
   */
  async createLetsEncryptDnsIssuer() {
    const acmeServer = this.letsencryptStaging
      ? 'https://acme-staging-v02.api.letsencrypt.org/directory'
      : 'https://acme-v02.api.letsencrypt.org/directory';
    const envLabel = this.letsencryptStaging ? ' (staging)' : '';

    this.log(`Creating Let's Encrypt DNS-01 ClusterIssuer${envLabel}...`, 'info');

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
          solvers: [
            {
              dns01: {
                route53: {
                  region: this.letsencryptRegion,
                  // Uses IRSA - no explicit credentials needed
                },
              },
            },
          ],
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
