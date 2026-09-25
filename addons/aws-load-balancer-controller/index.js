import { AddonFeature } from '../../src/lib/feature.js';
import { KubernetesHelper, CommandRunner } from '../../src/lib/common.js';

const HELM_REPO_NAME = 'eks';
const HELM_REPO_URL = 'https://aws.github.io/eks-charts';
const RELEASE_NAME = 'aws-load-balancer-controller';
const DEFAULT_CHART_VERSION = '3.5.0';

/**
 * Installs the AWS Load Balancer Controller (IRSA-backed), which provisions real
 * NLBs/ALBs with their own security groups - unlike the in-tree Classic ELB
 * controller, which opens NodePorts directly on the shared worker security group.
 * https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/deploy/installation/
 */
export class AwsLoadBalancerControllerFeature extends AddonFeature {
  constructor(name, config) {
    super(name, config);
    this.lbControllerNamespace = config.namespace || 'kube-system';
    this.chartVersion = config.version || DEFAULT_CHART_VERSION;
    this.serviceAccountRoleArn = config.serviceAccountRoleArn || null;
    this.clusterName = config.clusterName || null;
    this.vpcId = config.vpcId || null;
    this.kubeContext = config.kubeContext || null;
  }

  validate() {
    if (!this.serviceAccountRoleArn) {
      this.log('serviceAccountRoleArn is required for aws-load-balancer-controller', 'error');
      return false;
    }
    if (!this.clusterName) {
      this.log('clusterName is required for aws-load-balancer-controller', 'error');
      return false;
    }
    return true;
  }

  async deploy() {
    this.log('Installing AWS Load Balancer Controller...', 'info');

    await KubernetesHelper.ensureNamespace(
      this.lbControllerNamespace,
      this.spinner,
      this.kubeContext
    );
    this.log(`Namespace '${this.lbControllerNamespace}' ready`, 'info');

    await this.addHelmRepo();
    await this.installController();
    await this.waitForController();

    this.log('AWS Load Balancer Controller installed successfully', 'success');
  }

  async addHelmRepo() {
    this.log('Adding EKS Helm repository...', 'info');

    try {
      await CommandRunner.run('helm', ['repo', 'add', HELM_REPO_NAME, HELM_REPO_URL], {
        ignoreError: true,
      }); // Ignore if repo already exists

      await CommandRunner.run('helm', ['repo', 'update', HELM_REPO_NAME]);

      this.log('EKS Helm repository added and updated', 'info');
    } catch (error) {
      throw new Error(`Failed to add Helm repository: ${error.message}`);
    }
  }

  async installController() {
    this.log('Installing AWS Load Balancer Controller Helm chart...', 'info');

    const helmArgs = [
      'upgrade',
      '-i',
      RELEASE_NAME,
      `${HELM_REPO_NAME}/aws-load-balancer-controller`,
      '-n',
      this.lbControllerNamespace,
      '--version',
      this.chartVersion,
      '--set',
      `clusterName=${this.clusterName}`,
      '--set',
      `serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn=${this.serviceAccountRoleArn}`,
      '--wait',
    ];

    if (this.vpcId) {
      helmArgs.push('--set', `vpcId=${this.vpcId}`);
    }

    if (this.kubeContext) {
      helmArgs.push('--kube-context', this.kubeContext);
    }

    await KubernetesHelper.helm(helmArgs, this.spinner);
    await KubernetesHelper.assertHelmDeployed(
      RELEASE_NAME,
      this.lbControllerNamespace,
      this.kubeContext
    );
    this.log('AWS Load Balancer Controller Helm chart installed', 'info');
  }

  async waitForController() {
    this.log('Waiting for AWS Load Balancer Controller to be ready...', 'info');

    try {
      await KubernetesHelper.waitForDeployment(
        this.lbControllerNamespace,
        RELEASE_NAME,
        300,
        this.spinner,
        this.kubeContext
      );
    } catch (error) {
      this.log(`Warning: AWS Load Balancer Controller may not be ready: ${error.message}`, 'warn');
    }

    this.log('AWS Load Balancer Controller is ready', 'info');
  }

  async cleanup() {
    this.log('Cleaning up AWS Load Balancer Controller...', 'info');

    const helmCtxArgs = this.kubeContext ? ['--kube-context', this.kubeContext] : [];

    try {
      await CommandRunner.run('helm', [
        ...helmCtxArgs,
        'uninstall',
        RELEASE_NAME,
        '-n',
        this.lbControllerNamespace,
      ]);
      this.log('AWS Load Balancer Controller Helm chart uninstalled', 'info');
    } catch (error) {
      if (!/not found|no deployed releases/i.test(error.message)) throw error;
    }

    this.log('AWS Load Balancer Controller cleaned up', 'success');
  }
}
