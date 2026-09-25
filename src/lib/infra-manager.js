import { readFile, readdir, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import yaml from 'js-yaml';
import { Logger } from './common.js';
import { InfraSchema } from './infra-schema.js';
import { InfraStateManager } from './infra-state.js';
import { getProvisionerRunner } from './provisioner-runners/index.js';
import { EnvironmentManager } from './environment.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');
const INFRA_DIR = join(PROJECT_ROOT, 'config', 'infra');

export class InfraManager {
  static INFRA_DIR = INFRA_DIR;

  constructor(infraName) {
    this.infraName = infraName;
    this.infraProfile = null;
    this.outputDir = InfraStateManager.getOutputDir(infraName);
    this.kubeconfigDir = InfraStateManager.getKubeconfigDir(infraName);
  }

  async loadInfraProfile() {
    if (this.infraProfile) {
      return this.infraProfile;
    }

    const profilePath = join(INFRA_DIR, `${this.infraName}.yaml`);

    try {
      const content = await readFile(profilePath, 'utf8');
      this.infraProfile = yaml.load(content);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`Infra profile '${this.infraName}' not found at ${profilePath}`);
      }
      throw error;
    }

    const validation = InfraSchema.validate(this.infraProfile);
    if (!validation.valid) {
      throw new Error(`Infra profile validation failed:\n  - ${validation.errors.join('\n  - ')}`);
    }

    return this.infraProfile;
  }

  async checkConflicts(clusterNames) {
    const existingProfiles = await InfraStateManager.listInfraProfiles();

    for (const existing of existingProfiles) {
      if (!existing.provisioned) continue;

      const state = await InfraStateManager.load(existing.name);
      const provisionedNames = (state?.status?.clusters || []).map(c => c.name);

      if (existing.name === this.infraName) {
        const added = clusterNames.filter(n => !provisionedNames.includes(n));
        const removed = provisionedNames.filter(n => !clusterNames.includes(n));

        if (added.length > 0 || removed.length > 0) {
          const lines = [
            `Profile '${this.infraName}' is already provisioned with different cluster names.`,
          ];
          if (removed.length > 0) lines.push(`  Existing: ${removed.join(', ')}`);
          if (added.length > 0) lines.push(`  New:      ${added.join(', ')}`);
          lines.push(
            '',
            `Destroy the current deployment first:`,
            `  agentic base infra cloud destroy -p ${this.infraName}`
          );
          throw new Error(lines.join('\n'));
        }

        Logger.warn(
          `Profile '${this.infraName}' is already provisioned. Re-provisioning will update existing resources.`
        );
        continue;
      }

      const conflicts = clusterNames.filter(n => provisionedNames.includes(n));

      if (conflicts.length > 0) {
        const clusterList = conflicts.map(n => `  - ${n}`).join('\n');
        throw new Error(
          `Cluster name conflict with already-provisioned profile '${existing.name}':\n${clusterList}\n\n` +
            `Destroy '${existing.name}' first, or use different cluster names.`
        );
      }
    }
  }

  async loadEnvironment(infraProfile) {
    const environmentName = InfraSchema.getEnvironment(infraProfile);
    if (!environmentName) return null;
    try {
      return await EnvironmentManager.load(environmentName);
    } catch (error) {
      Logger.warn(`Failed to load environment '${environmentName}': ${error.message}`);
      return null;
    }
  }

  async loadDnsConfig(infraProfile) {
    const inlineDns = InfraSchema.getDns(infraProfile);
    if (inlineDns) {
      return inlineDns;
    }

    const environment = await this.loadEnvironment(infraProfile);
    return environment?.spec?.dns || null;
  }

  async provision(options = {}) {
    const { autoApprove = false } = options;
    const infraProfile = await this.loadInfraProfile();

    const provider = InfraSchema.getProvider(infraProfile);
    const clusters = InfraSchema.getAllClusters(infraProfile);
    const settings = InfraSchema.getSettings(infraProfile);
    const environment = await this.loadEnvironment(infraProfile);
    const region = InfraSchema.getRegion(infraProfile, environment);
    const clusterWord = clusters.length === 1 ? 'cluster' : 'clusters';

    const dnsConfig = await this.loadDnsConfig(infraProfile);

    if (dnsConfig) {
      Logger.info(`DNS enabled: ${dnsConfig.childZone}.${dnsConfig.parentZone?.domain}`);
    }

    await this.checkConflicts(clusters.map(c => c.name));

    if (!existsSync(this.outputDir)) {
      await mkdir(this.outputDir, { recursive: true });
    }
    if (!existsSync(this.kubeconfigDir)) {
      await mkdir(this.kubeconfigDir, { recursive: true });
    }

    const infraName = InfraSchema.getName(infraProfile);
    const syntheticClusters = clusters.map(cluster => ({
      name: cluster.name,
      context: 'auto',
      provisioner: {
        type: provider,
        cloud: cluster.cloud || provider,
        region: cluster.region || region,
        ...settings,
        ...(cluster.settings || {}),
        ...(infraName ? { cluster_name: infraName } : {}),
      },
    }));

    await InfraStateManager.setProvisioning(this.infraName, provider, clusters);

    try {
      const RunnerClass = getProvisionerRunner(provider);
      const runner = new RunnerClass(this.infraName, syntheticClusters, {
        outputDir: this.outputDir,
        kubeconfigDir: this.kubeconfigDir,
        autoApprove,
        dnsConfig,
      });

      const { clusters: clusterResults, dns: dnsOutputs } = await runner.provision();

      await InfraStateManager.setProvisioned(this.infraName, provider, clusterResults, dnsOutputs);

      Logger.success(`Provisioned ${clusters.length} ${provider} ${clusterWord}`);

      if (dnsOutputs?.enabled) {
        Logger.info(`DNS zone created: ${dnsOutputs.zoneName} (${dnsOutputs.zoneId})`);
      }

      const envShPath = InfraStateManager.getEnvShPath(this.infraName);
      Logger.info(`To source the environment:\n  source ${envShPath}`);

      return clusterResults;
    } catch (error) {
      const tfStateExists = InfraStateManager.hasTerraformState(this.infraName);
      await InfraStateManager.setFailed(this.infraName, error, tfStateExists);

      if (tfStateExists) {
        Logger.warn(
          `Partial infrastructure may exist. Run 'agentic base infra cloud destroy -p ${this.infraName}' to clean up.`
        );
      }

      throw new Error(`Provisioning failed for '${this.infraName}': ${error.message}`);
    }
  }

  async destroy(options = {}) {
    const { autoApprove = false } = options;
    const infraProfile = await this.loadInfraProfile();

    const state = await InfraStateManager.load(this.infraName);
    const tfStateExists = InfraStateManager.hasTerraformState(this.infraName);
    const needsCleanup = InfraStateManager.needsCleanup(state) || tfStateExists;

    if (!needsCleanup) {
      Logger.info(`No provisioned infrastructure found for '${this.infraName}'`);
      return;
    }

    const provider = InfraSchema.getProvider(infraProfile);
    const clusters = InfraSchema.getAllClusters(infraProfile);
    const settings = InfraSchema.getSettings(infraProfile);
    const environment = await this.loadEnvironment(infraProfile);
    const region = InfraSchema.getRegion(infraProfile, environment);
    const clusterWord = clusters.length === 1 ? 'cluster' : 'clusters';

    const dnsConfig = await this.loadDnsConfig(infraProfile);

    if (state?.status?.phase === 'failed') {
      Logger.info(`Cleaning up failed provisioning for: ${this.infraName}`);
      if (state.status?.error) {
        Logger.debug(`Previous error: ${state.status.error}`);
      }
    } else {
      Logger.info(
        `Destroying infra profile: ${this.infraName} (${provider}, ${clusters.length} ${clusterWord})`
      );
    }

    const infraName = InfraSchema.getName(infraProfile);
    const syntheticClusters = clusters.map(cluster => ({
      name: cluster.name,
      context: 'auto',
      provisioner: {
        type: provider,
        cloud: cluster.cloud || provider,
        region: cluster.region || region,
        ...settings,
        ...(cluster.settings || {}),
        ...(infraName ? { cluster_name: infraName } : {}),
      },
    }));

    await InfraStateManager.setDestroying(this.infraName);

    try {
      const RunnerClass = getProvisionerRunner(provider);
      const runner = new RunnerClass(this.infraName, syntheticClusters, {
        outputDir: this.outputDir,
        kubeconfigDir: this.kubeconfigDir,
        autoApprove,
        dnsConfig,
      });

      await runner.destroy();
      await InfraStateManager.clear(this.infraName);

      Logger.success(`Destroyed ${clusters.length} ${provider} ${clusterWord}`);
    } catch (error) {
      const stillHasTfState = InfraStateManager.hasTerraformState(this.infraName);
      await InfraStateManager.setFailed(this.infraName, error, stillHasTfState);
      throw new Error(`Destroy failed for '${this.infraName}': ${error.message}`);
    }
  }

  async status() {
    const infraProfile = await this.loadInfraProfile();
    const state = await InfraStateManager.load(this.infraName);
    const provider = InfraSchema.getProvider(infraProfile);
    const clusters = InfraSchema.getAllClusters(infraProfile);
    const tfStateExists = InfraStateManager.hasTerraformState(this.infraName);

    return {
      name: this.infraName,
      provider,
      defined: clusters.length,
      phase: state?.status?.phase || 'pending',
      provisioned: state?.status?.provisioned || false,
      clusters: state?.status?.clusters || [],
      dns: InfraStateManager.getDnsState(state),
      updatedAt: state?.metadata?.updatedAt || null,
      envShPath: InfraStateManager.getEnvShPath(this.infraName),
      error: state?.status?.error || null,
      terraformStateExists: tfStateExists,
      needsCleanup: InfraStateManager.needsCleanup(state) || tfStateExists,
    };
  }

  static async list() {
    try {
      const entries = await readdir(INFRA_DIR, { withFileTypes: true });
      const profiles = [];

      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.yaml')) {
          const name = entry.name.replace('.yaml', '');
          const filePath = join(INFRA_DIR, entry.name);

          try {
            const content = await readFile(filePath, 'utf8');
            const profile = yaml.load(content);
            const state = await InfraStateManager.load(name);
            const tfStateExists = InfraStateManager.hasTerraformState(name);

            profiles.push({
              name,
              infraName: profile.spec?.name || null,
              description: profile.metadata?.description || '',
              provider: profile.spec?.provider || 'unknown',
              clusterCount: profile.spec?.clusters?.length || 0,
              phase: state?.status?.phase || 'pending',
              provisioned: state?.status?.provisioned || false,
              error: state?.status?.error || null,
              needsCleanup: InfraStateManager.needsCleanup(state) || tfStateExists,
            });
          } catch {
            const tfStateExists = InfraStateManager.hasTerraformState(name);
            profiles.push({
              name,
              description: '',
              provider: 'unknown',
              clusterCount: 0,
              phase: 'unknown',
              provisioned: false,
              error: null,
              needsCleanup: tfStateExists,
            });
          }
        }
      }

      return profiles.sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }
}
