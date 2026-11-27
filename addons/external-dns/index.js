import { AddonFeature } from '../../src/lib/feature.js';
import { KubernetesHelper, CommandRunner } from '../../src/lib/common.js';

const EXTERNAL_DNS_VERSION = '1.23.0';

/**
 * Deploys external-dns for automatic DNS record management (AWS Route53,
 * Google Cloud DNS, or Cloudflare).
 *
 * Configuration:
 * {
 *   provider: string,          // 'route53' (default) | 'google' | 'cloudflare'
 *   domainFilter: string,      // Required
 *   txtOwnerId: string,        // Default: 'agentic-demo'
 *   // route53 only:
 *   region: string,            // Default: 'ap-southeast-2'
 *   zoneId: string,            // Optional: --zone-id-filter
 *   // google only:
 *   project: string,           // Required (or GCP_PROJECT env var) -- GCP project the zone lives in
 *   gcpServiceAccount: string, // GSA email for the Workload Identity annotation (ADC, no key file)
 *   // cloudflare only:
 *   proxied: boolean,          // Default: false -- Cloudflare's proxy can't reach a private
 *                              // cluster IP, so DNS-only records are the only sensible default.
 *                              // The API token is read from CLOUDFLARE_API_TOKEN (no ambient
 *                              // credential mechanism like IRSA/Workload Identity exists).
 * }
 */
export class ExternalDnsFeature extends AddonFeature {
  constructor(name, config) {
    super(name, config);
    this.provider = config.provider || 'route53';
    this.zoneId = config.zoneId;
    this.domainFilter = config.domainFilter;
    this.region = config.region || 'ap-southeast-2';
    this.txtOwnerId = config.txtOwnerId || 'agentic-demo';
    this.namespace = config.namespace || 'external-dns';
    this.version = config.version || EXTERNAL_DNS_VERSION;
    this.kubeContext = config.kubeContext || null;
    // Google Cloud DNS
    this.project = config.project || process.env.GCP_PROJECT || null;
    this.gcpServiceAccount = config.gcpServiceAccount || null;
    // Cloudflare
    this.cloudflareProxied = config.proxied === true;
    this.cloudflareApiTokenSecretName = 'external-dns-cloudflare-api-token';
  }

  validate() {
    if (!['route53', 'google', 'cloudflare'].includes(this.provider)) {
      throw new Error(
        `DNS provider '${this.provider}' not yet supported. Supported: route53, google, cloudflare.`
      );
    }

    if (this.provider === 'google' && !this.project) {
      throw new Error(
        'external-dns: project (or GCP_PROJECT environment variable) is required for provider=google'
      );
    }

    if (this.provider === 'cloudflare' && !process.env.CLOUDFLARE_API_TOKEN) {
      throw new Error(
        'external-dns: CLOUDFLARE_API_TOKEN environment variable is required for provider=cloudflare'
      );
    }

    if (!this.domainFilter) {
      throw new Error('external-dns requires domainFilter configuration');
    }

    return true;
  }

  async deploy() {
    this.log('Installing external-dns...', 'info');

    await KubernetesHelper.ensureNamespace(this.namespace, this.spinner, this.kubeContext);

    if (this.provider === 'cloudflare') {
      await this.createCloudflareApiTokenSecret();
    }

    try {
      await CommandRunner.run(
        'helm',
        ['repo', 'add', 'external-dns', 'https://kubernetes-sigs.github.io/external-dns/'],
        { ignoreError: true }
      );
      await CommandRunner.run('helm', ['repo', 'update', 'external-dns'], { ignoreError: true });
    } catch (_error) {
      // repo might already exist
    }

    const helmArgs = [
      'upgrade',
      '-i',
      'external-dns',
      'external-dns/external-dns',
      '-n',
      this.namespace,
      '--version',
      this.version,
      '--create-namespace',
      '--wait',
      '--set',
      `domainFilters[0]=${this.domainFilter}`,
      '--set',
      `txtOwnerId=${this.txtOwnerId}`,
      '--set',
      'policy=sync',
      '--set',
      'sources[0]=service',
      '--set',
      'sources[1]=ingress',
      '--set',
      'sources[2]=gateway-httproute',
    ];

    if (this.provider === 'google') {
      helmArgs.push('--set', 'provider.name=google', '--set', `google.project=${this.project}`);
      if (this.gcpServiceAccount) {
        // Workload Identity: annotate the chart's KSA so pods assume the GSA via ADC, no key file.
        // Dots in the annotation key must be escaped -- it's one literal key, not nested objects.
        helmArgs.push(
          '--set-string',
          `serviceAccount.annotations.iam\\.gke\\.io/gcp-service-account=${this.gcpServiceAccount}`
        );
      }
    } else if (this.provider === 'cloudflare') {
      helmArgs.push(
        '--set',
        'provider.name=cloudflare',
        '--set',
        'env[0].name=CF_API_TOKEN',
        '--set',
        `env[0].valueFrom.secretKeyRef.name=${this.cloudflareApiTokenSecretName}`,
        '--set',
        'env[0].valueFrom.secretKeyRef.key=api-token'
      );
      // --cloudflare-proxied is a bare/presence flag (kingpin-style) -- `=false` fails to
      // parse ("unexpected false"), confirmed live. false is already the binary's default,
      // so only pass the flag at all when proxying is actually wanted.
      if (this.cloudflareProxied) {
        helmArgs.push('--set', 'extraArgs[0]=--cloudflare-proxied');
      }
    } else {
      // route53. chart v1.14+ uses provider.name (not provider string); aws.region and
      // aws.zoneType moved to env/extraArgs.
      const extraArgs = ['--aws-zone-type=public'];
      if (this.zoneId) {
        extraArgs.push(`--zone-id-filter=${this.zoneId}`);
      }
      helmArgs.push(
        '--set',
        'provider.name=aws',
        '--set',
        'env[0].name=AWS_DEFAULT_REGION',
        '--set',
        `env[0].value=${this.region}`,
        ...extraArgs.flatMap((arg, i) => ['--set', `extraArgs[${i}]=${arg}`])
      );
    }

    if (this.kubeContext) {
      helmArgs.push('--kube-context', this.kubeContext);
    }

    await KubernetesHelper.helm(helmArgs);
    await KubernetesHelper.assertHelmDeployed('external-dns', this.namespace, this.kubeContext);

    await this.waitForDeployment('external-dns', 120);

    this.log('external-dns installed successfully', 'success');
  }

  /**
   * Reconcile the Secret the chart's CF_API_TOKEN env var reads from. Always re-applied
   * (not skip-if-exists) since the token can rotate.
   */
  async createCloudflareApiTokenSecret() {
    this.log('Reconciling Cloudflare API token secret...', 'info');

    const ctxFlag = this.kubeContext ? `--context=${this.kubeContext}` : '';
    const ctxStr = ctxFlag ? `${ctxFlag} ` : '';

    const result = await CommandRunner.exec(
      `kubectl ${ctxStr}create secret generic ${this.cloudflareApiTokenSecretName} -n ${this.namespace} --from-literal=api-token="${process.env.CLOUDFLARE_API_TOKEN}" --dry-run=client -o yaml | kubectl ${ctxStr}apply -f -`,
      { ignoreError: true }
    );
    if (result.exitCode) {
      throw new Error(
        `Failed to reconcile ${this.cloudflareApiTokenSecretName}: ${result.stderr?.trim()}`
      );
    }
  }

  async cleanup() {
    this.log('Cleaning up external-dns...', 'info');

    const helmCtxArgs = this.kubeContext ? ['--kube-context', this.kubeContext] : [];
    try {
      await CommandRunner.run('helm', [
        ...helmCtxArgs,
        'uninstall',
        'external-dns',
        '-n',
        this.namespace,
      ]);
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

    this.log('external-dns cleaned up', 'success');
  }

  async waitForDeployment(name, timeout = 120) {
    this.log(`Waiting for deployment ${name} to be ready...`, 'info');

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
}
