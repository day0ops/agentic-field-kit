import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'fs';
import { BaseProvisionerRunner } from './base.js';
import { TerraformRunner, EnvFileWriter } from '../provisioner.js';
import { Logger } from '../common.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../../..');
const ENVIRONMENTS_DIR = join(
  PROJECT_ROOT,
  'cloud-provisioner',
  'terraform-cloud-provisioner',
  'environments'
);

const PROVIDER_CONFIGS = {
  'eks-ipv6': {
    environment: 'eks-ipv6',
    outputPrefix: 'eks_ipv6',
    label: 'EKS IPv6',
    defaultRegion: 'ap-southeast-2',
    defaultNodeType: 't3.medium',
    requiredEnv: ['AWS_PROFILE'],
    generateVars(config) {
      const vars = {
        owner: config.owner,
        aws_profile: config.awsProfile,
        eks_ipv6_region: config.region,
        eks_ipv6_cluster_count: config.clusterCount,
        eks_ipv6_cluster_name: config.clusterName,
        eks_ipv6_nodes: config.desiredNodes,
        eks_ipv6_node_type: config.nodeType,
        eks_ipv6_min_nodes: config.minNodes,
        eks_ipv6_max_nodes: config.maxNodes,
        enable_dns64: config.enableDns64 ?? true,
        enable_bastion: config.enableBastion ?? true,
      };
      if (config.team) vars.team = config.team;
      if (config.purpose) vars.purpose = config.purpose;
      if (config.kubernetesVersion) vars.kubernetes_version = config.kubernetesVersion;
      return vars;
    },
  },

  eks: {
    environment: 'eks',
    outputPrefix: 'eks',
    label: 'EKS',
    defaultRegion: 'ap-southeast-2',
    defaultNodeType: 't3.medium',
    requiredEnv: ['AWS_PROFILE'],
    generateVars(config, dnsConfig) {
      const vars = {
        owner: config.owner,
        aws_profile: config.awsProfile,
        eks_region: config.region,
        eks_cluster_count: config.clusterCount,
        eks_cluster_name: config.clusterName,
        eks_nodes: config.desiredNodes,
        eks_node_type: config.nodeType,
        eks_min_nodes: config.minNodes,
        eks_max_nodes: config.maxNodes,
        eks_private_nodes: config.privateNodes ?? false,
      };
      if (config.team) vars.team = config.team;
      if (config.purpose) vars.purpose = config.purpose;
      if (config.kubernetesVersion) vars.kubernetes_version = config.kubernetesVersion;
      // DNS configuration for Route53
      if (dnsConfig?.provider === 'route53' && dnsConfig?.parentZone) {
        vars.enable_dns = true;
        vars.dns_parent_zone_id = dnsConfig.parentZone.hostedZoneId;
        vars.dns_parent_domain = dnsConfig.parentZone.domain;
        vars.dns_child_zone_name = dnsConfig.childZone;
      }
      return vars;
    },
  },

  gke: {
    environment: 'gke',
    outputPrefix: 'gke',
    label: 'GKE',
    defaultRegion: 'australia-southeast1',
    defaultNodeType: 'n1-standard-2',
    requiredEnv: ['GCP_PROJECT', 'GOOGLE_APPLICATION_CREDENTIALS'],
    generateVars(config) {
      const vars = {
        owner: config.owner,
        gke_project: config.gkeProject,
        gke_region: config.region,
        gke_cluster_count: config.clusterCount,
        gke_cluster_name: config.clusterName,
        gke_node_pool_size: config.desiredNodes,
        gke_node_type: config.nodeType,
      };
      if (config.team) vars.team = config.team;
      if (config.purpose) vars.purpose = config.purpose;
      if (config.kubernetesVersion) vars.kubernetes_version = config.kubernetesVersion;
      return vars;
    },
  },

  aks: {
    environment: 'aks',
    outputPrefix: 'aks',
    label: 'AKS',
    defaultRegion: 'Australia East',
    defaultNodeType: 'Standard_D2_v2',
    requiredEnv: [
      'ARM_CLIENT_ID',
      'ARM_CLIENT_SECRET',
      'ARM_OBJECT_ID',
      'ARM_SUBSCRIPTION_ID',
      'ARM_TENANT_ID',
    ],
    generateVars(config) {
      const vars = {
        owner: config.owner,
        aks_region: config.region,
        aks_cluster_count: config.clusterCount,
        aks_cluster_name: config.clusterName,
        aks_nodes: config.desiredNodes,
        aks_node_type: config.nodeType,
        aks_min_nodes: config.minNodes,
        aks_max_nodes: config.maxNodes,
        aks_service_principal: config.aksServicePrincipal,
      };
      if (config.team) vars.team = config.team;
      if (config.purpose) vars.purpose = config.purpose;
      if (config.kubernetesVersion) vars.kubernetes_version = config.kubernetesVersion;
      return vars;
    },
  },

  multicluster: {
    environment: 'multicluster',
    outputPrefix: null,
    label: 'Multicluster',
    defaultRegion: null,
    defaultNodeType: null,
    requiredEnv: [],
    isMulticluster: true,
  },
};

const CLOUD_DEFAULTS = {
  eks: {
    defaultRegion: 'ap-southeast-2',
    defaultNodeType: 't3.medium',
    outputPrefix: 'eks',
    requiredEnv: ['AWS_PROFILE'],
  },
  'eks-ipv6': {
    defaultRegion: 'ap-southeast-2',
    defaultNodeType: 't3.medium',
    outputPrefix: 'eks_ipv6',
    requiredEnv: ['AWS_PROFILE'],
  },
  gke: {
    defaultRegion: 'australia-southeast1',
    defaultNodeType: 'n1-standard-2',
    outputPrefix: 'gke',
    requiredEnv: ['GCP_PROJECT'],
  },
  aks: {
    defaultRegion: 'Australia East',
    defaultNodeType: 'Standard_D2_v2',
    outputPrefix: 'aks',
    requiredEnv: [
      'ARM_CLIENT_ID',
      'ARM_CLIENT_SECRET',
      'ARM_OBJECT_ID',
      'ARM_SUBSCRIPTION_ID',
      'ARM_TENANT_ID',
    ],
  },
};

/**
 * TerraformCloudRunner
 * Generic runner for all terraform-cloud-provisioner environments.
 * Determines the target environment from the cluster provisioner type.
 */
export class TerraformCloudRunner extends BaseProvisionerRunner {
  static get type() {
    return 'terraform-cloud';
  }

  static get supportedTypes() {
    return Object.keys(PROVIDER_CONFIGS);
  }

  constructor(profileName, clusters, options = {}) {
    super(profileName, clusters, options);

    this.providerType = clusters[0]?.provisioner?.type;
    this.providerConfig = PROVIDER_CONFIGS[this.providerType];

    if (!this.providerConfig) {
      const available = Object.keys(PROVIDER_CONFIGS).join(', ');
      throw new Error(
        `Unsupported provisioner type '${this.providerType}' for TerraformCloudRunner. Supported: ${available}`
      );
    }

    this.terraformDir = join(ENVIRONMENTS_DIR, this.providerConfig.environment);
    this.tfTemplateDir = join(this.outputDir, 'tf-template');
    this.stateFile = join(this.outputDir, 'terraform.tfstate');
    this.varFile = join(this.tfTemplateDir, 'terraform.tfvars');
  }

  logInfo(message) {
    Logger.info(`[${this.providerConfig.label}] ${message}`);
  }

  logDebug(message) {
    Logger.debug(`[${this.providerConfig.label}] ${message}`);
  }

  logWarn(message) {
    Logger.warn(`[${this.providerConfig.label}] ${message}`);
  }

  logError(message) {
    Logger.error(`[${this.providerConfig.label}] ${message}`);
  }

  async provision() {
    this.validateEnvironment();
    this.logDebug(
      `Provisioning ${this.clusters.length} ${this.providerConfig.label} cluster${this.clusters.length === 1 ? '' : 's'}`
    );

    if (!existsSync(this.terraformDir)) {
      throw new Error(`Terraform environment not found: ${this.terraformDir}`);
    }

    this.ensureDirectories();

    const config = this.resolveConfiguration();

    this.writeTerraformVars(config);
    this.writeEnvFile(config);

    const terraform = new TerraformRunner(this.terraformDir);
    await terraform.init({ stream: true });
    await terraform.apply(this.varFile, this.stateFile, { autoApprove: true, stream: true });

    const clusterResults = await this.extractClusterInfo(terraform, config);
    this.updateEnvFile(config, clusterResults);

    // Extract DNS outputs if DNS was enabled
    const dnsOutputs = await this.extractDnsInfo(terraform);

    return { clusters: clusterResults, dns: dnsOutputs };
  }

  async destroy() {
    this.validateEnvironment();
    this.logDebug(
      `Destroying ${this.clusters.length} ${this.providerConfig.label} cluster${this.clusters.length === 1 ? '' : 's'}`
    );

    if (!existsSync(this.stateFile)) {
      this.logWarn('No terraform state file found. Nothing to destroy.');
      return;
    }

    const terraform = new TerraformRunner(this.terraformDir);
    await terraform.init({ stream: true });
    await terraform.destroy(this.varFile, this.stateFile, { autoApprove: true, stream: true });
  }

  ensureDirectories() {
    for (const dir of [this.outputDir, this.tfTemplateDir, this.kubeconfigDir]) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * Map from env var name to the infra profile settings key that can provide
   * the same value. If the profile supplies it, the env var is not required.
   */
  static ENV_TO_SETTINGS = {
    CLUSTER_OWNER: 'owner',
    AWS_PROFILE: 'aws_profile',
    GCP_PROJECT: 'project',
    GOOGLE_APPLICATION_CREDENTIALS: 'google_credentials',
    ARM_CLIENT_ID: 'arm_client_id',
    ARM_CLIENT_SECRET: 'arm_client_secret',
    ARM_OBJECT_ID: 'arm_object_id',
    ARM_SUBSCRIPTION_ID: 'arm_subscription_id',
    ARM_TENANT_ID: 'arm_tenant_id',
  };

  get isMulticluster() {
    return !!this.providerConfig.isMulticluster;
  }

  /**
   * Group clusters by their cloud type. For single-provider profiles all
   * clusters share the same cloud. For multicluster, each cluster declares
   * its own `cloud` field via the provisioner metadata.
   */
  groupClustersByCloud() {
    const groups = new Map();
    for (const cluster of this.clusters) {
      const cloud = cluster.provisioner?.cloud || this.providerType;
      if (!groups.has(cloud)) groups.set(cloud, []);
      groups.get(cloud).push(cluster);
    }
    return groups;
  }

  validateEnvironment() {
    const provisioner = this.clusters[0]?.provisioner || {};

    let allRequired = ['CLUSTER_OWNER'];
    if (this.isMulticluster) {
      const clouds = this.groupClustersByCloud();
      for (const cloud of clouds.keys()) {
        const defs = CLOUD_DEFAULTS[cloud];
        if (defs?.requiredEnv) {
          allRequired.push(...defs.requiredEnv);
        }
      }
      allRequired = [...new Set(allRequired)];
    } else {
      allRequired.push(...(this.providerConfig.requiredEnv || []));
    }

    const missing = allRequired.filter(envKey => {
      const settingsKey = TerraformCloudRunner.ENV_TO_SETTINGS[envKey];
      if (settingsKey && provisioner[settingsKey]) return false;
      return !process.env[envKey];
    });

    if (missing.length > 0) {
      const label = this.isMulticluster ? 'Multicluster' : this.providerConfig.label;
      const lines = [
        `Missing required environment variables for ${label}:`,
        ...missing.map(v => `  - ${v}`),
        '',
        'Set them via environment or in the infra profile spec.settings:',
        ...missing.map(v => {
          const key = TerraformCloudRunner.ENV_TO_SETTINGS[v];
          return key ? `  export ${v}=<value>  (or spec.settings.${key})` : `  export ${v}=<value>`;
        }),
      ];
      throw new Error(lines.join('\n'));
    }
  }

  resolveConfiguration() {
    if (this.isMulticluster) {
      return this.resolveMulticlusterConfiguration();
    }

    const firstCluster = this.clusters[0];
    const provisioner = firstCluster.provisioner || {};
    const pc = this.providerConfig;
    const nodesCfg = provisioner.nodes || {};
    const desiredNodes = nodesCfg.desired ?? 2;

    return {
      owner: provisioner.owner || process.env.CLUSTER_OWNER,
      region: provisioner.region || pc.defaultRegion,
      team: provisioner.team || process.env.TEAM || undefined,
      purpose: provisioner.purpose || process.env.PURPOSE || undefined,
      awsProfile: provisioner.aws_profile || process.env.AWS_PROFILE,
      clusterName: provisioner.cluster_name || this.profileName,
      clusterCount: this.clusters.length,
      desiredNodes,
      nodeType: nodesCfg.type || pc.defaultNodeType,
      minNodes: nodesCfg.min ?? Math.max(1, desiredNodes - 1),
      maxNodes: nodesCfg.max ?? desiredNodes + 2,
      kubernetesVersion:
        provisioner.kubernetes_version || process.env.KUBERNETES_VERSION || undefined,
      enableDns64: provisioner.enable_dns64,
      enableBastion: provisioner.enable_bastion,
      privateNodes: nodesCfg.private,
      gkeProject:
        provisioner.project || (this.providerType === 'gke' ? process.env.GCP_PROJECT : undefined),
      aksServicePrincipal:
        provisioner.arm_client_id || process.env.ARM_CLIENT_ID
          ? {
              object_id: provisioner.arm_object_id || process.env.ARM_OBJECT_ID,
              client_id: provisioner.arm_client_id || process.env.ARM_CLIENT_ID,
              client_secret: provisioner.arm_client_secret || process.env.ARM_CLIENT_SECRET,
            }
          : undefined,
    };
  }

  resolveMulticlusterConfiguration() {
    const firstCluster = this.clusters[0];
    const provisioner = firstCluster.provisioner || {};
    const clouds = this.groupClustersByCloud();

    const config = {
      owner: provisioner.owner || process.env.CLUSTER_OWNER,
      team: provisioner.team || process.env.TEAM || undefined,
      purpose: provisioner.purpose || process.env.PURPOSE || undefined,
      awsProfile: provisioner.aws_profile || process.env.AWS_PROFILE,
      kubernetesVersion:
        provisioner.kubernetes_version || process.env.KUBERNETES_VERSION || undefined,
      gkeProject:
        provisioner.project ||
        (this.clusters.some(c => (c.provisioner?.cloud || c.provisioner?.type) === 'gke')
          ? process.env.GCP_PROJECT
          : undefined),
      aksServicePrincipal:
        provisioner.arm_client_id || process.env.ARM_CLIENT_ID
          ? {
              object_id: provisioner.arm_object_id || process.env.ARM_OBJECT_ID,
              client_id: provisioner.arm_client_id || process.env.ARM_CLIENT_ID,
              client_secret: provisioner.arm_client_secret || process.env.ARM_CLIENT_SECRET,
            }
          : undefined,
      clouds: {},
      cloudOrder: [],
    };

    for (const [cloud, clusters] of clouds) {
      const defs = CLOUD_DEFAULTS[cloud] || {};
      const first = clusters[0].provisioner || {};
      const nodesCfg = first.nodes || {};
      const desiredNodes = nodesCfg.desired ?? 2;

      config.clouds[cloud] = {
        count: clusters.length,
        region: first.region || defs.defaultRegion,
        nodeType: nodesCfg.type || defs.defaultNodeType,
        desiredNodes,
        minNodes: nodesCfg.min ?? Math.max(1, desiredNodes - 1),
        maxNodes: nodesCfg.max ?? desiredNodes + 2,
        clusterName: first.cluster_name || this.profileName,
        clusters,
      };
      config.cloudOrder.push(cloud);
    }

    return config;
  }

  writeTerraformVars(config) {
    if (this.isMulticluster) {
      return this.writeMulticlusterTerraformVars(config);
    }

    const vars = this.providerConfig.generateVars(config, this.dnsConfig);
    const lines = [
      `# Generated by agentic CLI`,
      `# Profile: ${this.profileName}`,
      `# Provider: ${this.providerConfig.label}`,
      ``,
    ];

    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined || value === null) continue;
      lines.push(`${key} = ${formatTfValue(value)}`);
    }

    lines.push('');
    writeFileSync(this.varFile, lines.join('\n'));
    this.logInfo(`Terraform variables written to ${this.varFile}`);
  }

  writeMulticlusterTerraformVars(config) {
    const lines = [
      `# Generated by agentic CLI`,
      `# Profile: ${this.profileName}`,
      `# Provider: Multicluster (${config.cloudOrder.join(' + ')})`,
      ``,
      `owner = ${formatTfValue(config.owner)}`,
    ];

    if (config.team) lines.push(`team = ${formatTfValue(config.team)}`);
    if (config.purpose) lines.push(`purpose = ${formatTfValue(config.purpose)}`);
    if (config.kubernetesVersion)
      lines.push(`kubernetes_version = ${formatTfValue(config.kubernetesVersion)}`);

    lines.push('');

    const eksCloud = config.clouds['eks'] || config.clouds['eks-ipv6'];
    const gkeCloud = config.clouds['gke'];
    const aksCloud = config.clouds['aks'];

    if (eksCloud) {
      lines.push(`# EKS`);
      lines.push(`aws_profile = ${formatTfValue(config.awsProfile || 'default')}`);
      lines.push(`eks_cluster_count = ${eksCloud.count}`);
      lines.push(`eks_cluster_name = ${formatTfValue(eksCloud.clusterName)}`);
      lines.push(`eks_region = ${formatTfValue(eksCloud.region)}`);
      lines.push(`eks_nodes = ${eksCloud.desiredNodes}`);
      lines.push(`eks_node_type = ${formatTfValue(eksCloud.nodeType)}`);
      lines.push(`eks_min_nodes = ${eksCloud.minNodes}`);
      lines.push(`eks_max_nodes = ${eksCloud.maxNodes}`);
      lines.push('');
    } else {
      lines.push(`eks_cluster_count = 0`);
      lines.push(`eks_cluster_name = "none"`);
      lines.push('');
    }

    if (gkeCloud) {
      lines.push(`# GKE`);
      lines.push(`gke_project = ${formatTfValue(config.gkeProject)}`);
      lines.push(`gke_cluster_count = ${gkeCloud.count}`);
      lines.push(`gke_cluster_name = ${formatTfValue(gkeCloud.clusterName)}`);
      lines.push(`gke_region = ${formatTfValue(gkeCloud.region)}`);
      lines.push(`gke_node_pool_size = ${gkeCloud.desiredNodes}`);
      lines.push(`gke_node_type = ${formatTfValue(gkeCloud.nodeType)}`);
      lines.push('');
    } else {
      lines.push(`gke_cluster_count = 0`);
      lines.push(`gke_cluster_name = "none"`);
      lines.push(`gke_project = "none"`);
      lines.push('');
    }

    if (aksCloud) {
      lines.push(`# AKS`);
      lines.push(`aks_cluster_count = ${aksCloud.count}`);
      lines.push(`aks_cluster_name = ${formatTfValue(aksCloud.clusterName)}`);
      lines.push(`aks_region = ${formatTfValue(aksCloud.region)}`);
      lines.push(`aks_nodes = ${aksCloud.desiredNodes}`);
      lines.push(`aks_node_type = ${formatTfValue(aksCloud.nodeType)}`);
      lines.push(`aks_min_nodes = ${aksCloud.minNodes}`);
      lines.push(`aks_max_nodes = ${aksCloud.maxNodes}`);
      if (config.aksServicePrincipal) {
        lines.push(`aks_service_principal = ${formatTfValue(config.aksServicePrincipal)}`);
      } else {
        lines.push(`aks_service_principal = null`);
      }
      lines.push('');
    } else {
      lines.push(`aks_cluster_count = 0`);
      lines.push(`aks_cluster_name = "none"`);
      lines.push(`aks_service_principal = null`);
      lines.push('');
    }

    writeFileSync(this.varFile, lines.join('\n'));
    this.logInfo(`Terraform variables written to ${this.varFile}`);
  }

  writeEnvFile(config) {
    const envVars = [
      { key: 'INFRA_PROFILE', value: this.profileName },
      { key: 'PROVISIONER_TYPE', value: this.providerType },
      { key: 'CLUSTER_OWNER', value: config.owner },
    ];

    if (!this.isMulticluster) {
      envVars.push({ key: 'REGION', value: config.region });
    }

    if (config.awsProfile) envVars.push({ key: 'AWS_PROFILE', value: config.awsProfile });
    if (config.gkeProject) envVars.push({ key: 'GCP_PROJECT', value: config.gkeProject });

    EnvFileWriter.writeEnvFiles(this.outputDir, envVars);
  }

  async extractClusterInfo(terraform, config) {
    if (this.isMulticluster) {
      return this.extractMulticlusterInfo(terraform, config);
    }

    const prefix = this.providerConfig.outputPrefix;
    const results = [];
    const kubeconfigFiles = [];

    const contexts = await terraform.getOutput(this.stateFile, `${prefix}_kubeconfig_context`);
    const clusterNames = await terraform.getOutput(this.stateFile, `${prefix}_cluster_name`);
    const kubeconfigJoined = await terraform.getOutput(this.stateFile, `${prefix}_kubeconfig`);

    const kubeconfigPaths = kubeconfigJoined
      ? String(kubeconfigJoined).split(':').filter(Boolean)
      : [];

    const contextList = Array.isArray(contexts) ? contexts : [];
    const nameList = Array.isArray(clusterNames) ? clusterNames : [];

    for (let i = 0; i < config.clusterCount; i++) {
      const cluster = this.clusters[i] || {};
      const clusterLabel = cluster.name || `cluster-${i + 1}`;

      let kubeconfigPath = null;
      if (kubeconfigPaths[i] && existsSync(kubeconfigPaths[i])) {
        kubeconfigPath = join(this.kubeconfigDir, `${clusterLabel}.yaml`);
        copyFileSync(kubeconfigPaths[i], kubeconfigPath);
        kubeconfigFiles.push(kubeconfigPath);
      }

      const network = await this.extractNetworkInfo(terraform, prefix, i);
      const iam = await this.extractIamInfo(terraform, prefix, i);

      results.push({
        name: clusterLabel,
        context: contextList[i] || null,
        cluster: nameList[i] || null,
        kubeconfig: kubeconfigPath,
        provisioned: true,
        verified: false,
        ...(network ? { network } : {}),
        ...(iam ? { iam } : {}),
      });
    }

    if (kubeconfigFiles.length > 0) {
      const currentKubeconfig = process.env.KUBECONFIG || '';
      const existingParts = currentKubeconfig
        ? currentKubeconfig.split(':').filter(p => p && !p.startsWith(this.kubeconfigDir))
        : [];
      const parts = [...new Set([...existingParts, ...kubeconfigFiles])];
      this.appendEnvVar('KUBECONFIG', parts.join(':'));
    }

    return results;
  }

  async extractMulticlusterInfo(terraform, config) {
    const results = [];
    const kubeconfigFiles = [];

    for (const cloud of config.cloudOrder) {
      const cloudConfig = config.clouds[cloud];
      const defs = CLOUD_DEFAULTS[cloud] || {};
      const prefix = defs.outputPrefix || cloud;

      const contexts = await terraform.getOutput(this.stateFile, `${prefix}_kubeconfig_context`);
      const clusterNames = await terraform.getOutput(this.stateFile, `${prefix}_cluster_name`);
      const kubeconfigJoined = await terraform.getOutput(this.stateFile, `${prefix}_kubeconfig`);

      const kubeconfigPaths = kubeconfigJoined
        ? String(kubeconfigJoined).split(':').filter(Boolean)
        : [];

      const contextList = Array.isArray(contexts) ? contexts : [];
      const nameList = Array.isArray(clusterNames) ? clusterNames : [];

      for (let i = 0; i < cloudConfig.count; i++) {
        const cluster = cloudConfig.clusters[i] || {};
        const clusterLabel = cluster.name || `${cloud}-${i + 1}`;

        let kubeconfigPath = null;
        if (kubeconfigPaths[i] && existsSync(kubeconfigPaths[i])) {
          kubeconfigPath = join(this.kubeconfigDir, `${clusterLabel}.yaml`);
          copyFileSync(kubeconfigPaths[i], kubeconfigPath);
          kubeconfigFiles.push(kubeconfigPath);
        }

        const network = await this.extractNetworkInfo(terraform, prefix, i);
        const iam = await this.extractIamInfo(terraform, prefix, i);

        results.push({
          name: clusterLabel,
          context: contextList[i] || null,
          cluster: nameList[i] || null,
          kubeconfig: kubeconfigPath,
          provisioned: true,
          verified: false,
          ...(network ? { network } : {}),
          ...(iam ? { iam } : {}),
        });
      }
    }

    if (kubeconfigFiles.length > 0) {
      const currentKubeconfig = process.env.KUBECONFIG || '';
      const existingParts = currentKubeconfig
        ? currentKubeconfig.split(':').filter(p => p && !p.startsWith(this.kubeconfigDir))
        : [];
      const parts = [...new Set([...existingParts, ...kubeconfigFiles])];
      this.appendEnvVar('KUBECONFIG', parts.join(':'));
    }

    return results;
  }

  async extractNetworkInfo(terraform, prefix, clusterIndex) {
    try {
      const vpcIds = await terraform.getOutput(this.stateFile, `${prefix}_vpc_ids`);
      const allSubnetIds = await terraform.getOutput(
        this.stateFile,
        `${prefix}_private_subnet_ids`
      );
      const sgIds = await terraform.getOutput(
        this.stateFile,
        `${prefix}_worker_security_group_ids`
      );
      const natGatewayIps = await terraform.getOutput(
        this.stateFile,
        `${prefix}_nat_gateway_public_ips`
      );

      const vpcId = Array.isArray(vpcIds) ? vpcIds[clusterIndex] || null : null;
      const privateSubnetIds = Array.isArray(allSubnetIds) ? allSubnetIds[clusterIndex] || [] : [];
      const workerSgId = Array.isArray(sgIds) ? sgIds[clusterIndex] || null : null;
      const natGatewayIp = Array.isArray(natGatewayIps)
        ? natGatewayIps[clusterIndex] || null
        : null;

      if (!vpcId) return null;

      return {
        vpcId,
        privateSubnetIds,
        workerSgId,
        ...(natGatewayIp ? { natGatewayIp } : {}),
      };
    } catch {
      this.logWarn(`Could not extract network outputs for cluster index ${clusterIndex}`);
      return null;
    }
  }

  async extractIamInfo(terraform, prefix, clusterIndex) {
    try {
      const roleArns = await terraform.getOutput(
        this.stateFile,
        `${prefix}_aws_load_balancer_controller_role_arns`
      );
      const albControllerRoleArn = Array.isArray(roleArns) ? roleArns[clusterIndex] || null : null;
      if (!albControllerRoleArn) return null;
      return { albControllerRoleArn };
    } catch {
      this.logWarn(`Could not extract IAM outputs for cluster index ${clusterIndex}`);
      return null;
    }
  }

  async extractDnsInfo(terraform) {
    if (!this.dnsConfig) {
      return null;
    }

    const prefix = this.providerConfig.outputPrefix;

    try {
      const zoneId = await terraform.getOutput(this.stateFile, `${prefix}_dns_zone_id`);
      const zoneName = await terraform.getOutput(this.stateFile, `${prefix}_dns_zone_name`);
      const nameservers = await terraform.getOutput(this.stateFile, `${prefix}_dns_nameservers`);

      if (!zoneId) {
        return null;
      }

      return {
        enabled: true,
        zoneId: zoneId || null,
        zoneName: zoneName || null,
        nameservers: Array.isArray(nameservers) ? nameservers : [],
      };
    } catch (_error) {
      this.logWarn('Could not extract DNS outputs from Terraform state');
      return null;
    }
  }

  updateEnvFile(config, results) {
    const additionalVars = [];

    for (const result of results) {
      const envPrefix = result.name.toUpperCase().replace(/-/g, '_');

      if (result.context) {
        additionalVars.push({ key: `${envPrefix}_CONTEXT`, value: result.context });
      }
      if (result.cluster) {
        additionalVars.push({ key: `${envPrefix}_CLUSTER`, value: result.cluster });
      }
      if (result.kubeconfig) {
        additionalVars.push({ key: `${envPrefix}_KUBECONFIG`, value: result.kubeconfig });
      }
    }

    if (additionalVars.length > 0) {
      this.appendEnvVars(additionalVars);
    }
  }

  appendEnvVar(key, value) {
    this.appendEnvVars([{ key, value }]);
  }

  appendEnvVars(vars) {
    const envShPath = join(this.outputDir, 'env.sh');
    const envDotenvPath = join(this.outputDir, '.env');

    let envShContent = '';
    let envDotenvContent = '';

    for (const { key, value } of vars) {
      if (value !== null && value !== undefined) {
        envShContent += `export ${key}="${String(value).replace(/"/g, '\\"')}"\n`;
        envDotenvContent += `${key}=${EnvFileWriter.escapeEnvValue(value)}\n`;
      }
    }

    if (existsSync(envShPath)) {
      const existing = readFileSync(envShPath, 'utf8');
      writeFileSync(envShPath, existing + envShContent);
    }

    if (existsSync(envDotenvPath)) {
      const existing = readFileSync(envDotenvPath, 'utf8');
      writeFileSync(envDotenvPath, existing + envDotenvContent);
    }
  }
}

function formatTfValue(value) {
  if (typeof value === 'string') return `"${value}"`;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .map(([k, v]) => `    ${k} = ${formatTfValue(v)}`)
      .join('\n');
    return `{\n${entries}\n  }`;
  }
  return `"${value}"`;
}
