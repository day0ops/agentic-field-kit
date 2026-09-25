import { AddonFeature } from '../../src/lib/feature.js';
import { KubernetesHelper, CommandRunner } from '../../src/lib/common.js';

const EXTERNAL_DNS_VERSION = '1.21.1';

/**
 * Deploys external-dns for automatic DNS record management (AWS Route53 only).
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
  }

  validate() {
    if (this.provider !== 'route53') {
      throw new Error(
        `DNS provider '${this.provider}' not yet supported. Only 'route53' is implemented.`
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

    // chart v1.14+ uses provider.name (not provider string); aws.region and aws.zoneType moved to env/extraArgs
    const extraArgs = ['--aws-zone-type=public'];
    if (this.zoneId) {
      extraArgs.push(`--zone-id-filter=${this.zoneId}`);
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
      'provider.name=aws',
      '--set',
      'env[0].name=AWS_DEFAULT_REGION',
      '--set',
      `env[0].value=${this.region}`,
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
      ...extraArgs.flatMap((arg, i) => ['--set', `extraArgs[${i}]=${arg}`]),
    ];

    if (this.kubeContext) {
      helmArgs.push('--kube-context', this.kubeContext);
    }

    await KubernetesHelper.helm(helmArgs);
    await KubernetesHelper.assertHelmDeployed('external-dns', this.namespace, this.kubeContext);

    await this.waitForDeployment('external-dns', 120);

    this.log('external-dns installed successfully', 'success');
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
