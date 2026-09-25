import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import yaml from 'js-yaml';
import { KubernetesHelper, Logger } from './common.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');
const INFRA_OUTPUT_BASE = join(PROJECT_ROOT, '._output', 'infra');

export class InfraStateManager {
  static INFRA_OUTPUT_BASE = INFRA_OUTPUT_BASE;
  static PROJECT_ROOT = PROJECT_ROOT;

  /** Show paths relative to the project root when possible. */
  static formatProjectPath(filePath) {
    if (!filePath) {
      return filePath;
    }
    if (filePath === PROJECT_ROOT || filePath.startsWith(`${PROJECT_ROOT}/`)) {
      return relative(PROJECT_ROOT, filePath) || '.';
    }
    return filePath;
  }

  static profileMatchesKubeContext(state, kubeContext) {
    if (!kubeContext || !state?.status?.clusters) {
      return false;
    }
    return state.status.clusters.some(c => c.context === kubeContext);
  }

  static async getCurrentKubeContext() {
    try {
      const result = await KubernetesHelper.kubectl(['config', 'current-context'], {
        ignoreError: true,
      });
      return result.stdout?.trim() || null;
    } catch {
      return null;
    }
  }

  static async findProfilesForKubeContext(kubeContext, { provisionedOnly = false } = {}) {
    if (!kubeContext) {
      return [];
    }

    const profiles = await this.listInfraProfiles();
    const matches = [];

    for (const profile of profiles) {
      if (provisionedOnly && !profile.provisioned) {
        continue;
      }
      const state = await this.load(profile.name);
      if (this.profileMatchesKubeContext(state, kubeContext)) {
        matches.push(profile);
      }
    }

    return matches;
  }

  static async matchProfilesByKubeContext({ provisionedOnly = false } = {}) {
    const kubeContext = await this.getCurrentKubeContext();
    if (!kubeContext) {
      return { kubeContext: null, matches: [] };
    }

    const matches = await this.findProfilesForKubeContext(kubeContext, { provisionedOnly });
    return { kubeContext, matches };
  }

  /**
   * Resolve infra profile(s) for status display.
   * Prefers profiles whose cluster context matches the active kubectl context.
   * @param {string|null} explicitProfile
   * @returns {Promise<{ targets: string[], kubeContext: string|null, matchedByContext: boolean }>}
   */
  static async resolveInfraStatusTargets(explicitProfile) {
    const kubeContext = await this.getCurrentKubeContext();

    if (explicitProfile) {
      return { targets: [explicitProfile], kubeContext, matchedByContext: false };
    }

    if (kubeContext) {
      let matches = await this.findProfilesForKubeContext(kubeContext, { provisionedOnly: true });
      if (matches.length === 0) {
        matches = await this.findProfilesForKubeContext(kubeContext, { provisionedOnly: false });
      }

      if (matches.length === 1) {
        Logger.info(`Matched infra '${matches[0].name}' from kubectl context: ${kubeContext}`);
        return { targets: [matches[0].name], kubeContext, matchedByContext: true };
      }

      if (matches.length > 1) {
        Logger.warn(
          `kubectl context '${kubeContext}' matches multiple infra profiles: ${matches.map(m => m.name).join(', ')}`
        );
        return {
          targets: matches.map(m => m.name),
          kubeContext,
          matchedByContext: true,
        };
      }

      Logger.info(`kubectl context '${kubeContext}' does not match any infra state`);
    }

    const withState = await this.listInfraProfiles();
    const provisioned = withState.filter(p => p.provisioned);

    if (provisioned.length === 1) {
      Logger.info(`Auto-detected provisioned infra: ${provisioned[0].name}`);
      return { targets: [provisioned[0].name], kubeContext, matchedByContext: false };
    }

    if (provisioned.length > 1) {
      const hint = kubeContext ? 'switch kubectl context or use -p' : 'use -p';
      Logger.info(`Showing status for ${provisioned.length} provisioned infra profiles (${hint})`);
      return { targets: provisioned.map(p => p.name), kubeContext, matchedByContext: false };
    }

    if (withState.length > 0) {
      Logger.info('No provisioned infra; showing profiles with saved state');
      return { targets: withState.map(p => p.name), kubeContext, matchedByContext: false };
    }

    return { targets: [], kubeContext, matchedByContext: false };
  }

  static getOutputDir(infraName) {
    return join(INFRA_OUTPUT_BASE, infraName);
  }

  static getStatePath(infraName) {
    return join(INFRA_OUTPUT_BASE, infraName, 'state.yaml');
  }

  static getKubeconfigDir(infraName) {
    return join(INFRA_OUTPUT_BASE, infraName, 'kubeconfig');
  }

  static getTfTemplateDir(infraName) {
    return join(INFRA_OUTPUT_BASE, infraName, 'tf-template');
  }

  static getEnvShPath(infraName) {
    return join(INFRA_OUTPUT_BASE, infraName, 'env.sh');
  }

  static getEnvDotenvPath(infraName) {
    return join(INFRA_OUTPUT_BASE, infraName, '.env');
  }

  static async exists(infraName) {
    return existsSync(this.getStatePath(infraName));
  }

  static async load(infraName) {
    const statePath = this.getStatePath(infraName);
    try {
      const content = await readFile(statePath, 'utf8');
      return yaml.load(content);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw new Error(`Failed to load infra state for '${infraName}': ${error.message}`);
    }
  }

  static async save(infraName, state) {
    const outputDir = this.getOutputDir(infraName);
    const statePath = this.getStatePath(infraName);

    if (!existsSync(outputDir)) {
      await mkdir(outputDir, { recursive: true });
    }

    if (!state.metadata) {
      state.metadata = {};
    }
    state.metadata.updatedAt = new Date().toISOString();

    const content = yaml.dump(state, {
      lineWidth: -1,
      quotingType: '"',
      forceQuotes: false,
    });

    await writeFile(statePath, content, 'utf8');
  }

  static createEmptyState(infraName, provider) {
    return {
      apiVersion: 'agentic.demo/v1',
      kind: 'InfraState',
      metadata: {
        name: infraName,
        provider,
        updatedAt: new Date().toISOString(),
      },
      status: {
        phase: 'pending', // pending, provisioning, provisioned, failed, destroying
        provisioned: false,
        clusters: [],
      },
    };
  }

  static async setProvisioning(infraName, provider, clusters) {
    let state = await this.load(infraName);

    if (!state) {
      state = this.createEmptyState(infraName, provider);
    }

    state.metadata.provider = provider;
    state.status.phase = 'provisioning';
    state.status.provisioned = false;
    state.status.startedAt = new Date().toISOString();
    state.status.clusters = clusters.map(cluster => ({
      name: cluster.name,
      provisioned: false,
    }));

    // Clear any previous error
    delete state.status.error;
    delete state.status.failedAt;

    await this.save(infraName, state);
    return state;
  }

  static async setFailed(infraName, error, terraformStateExists = false) {
    let state = await this.load(infraName);

    if (!state) {
      return null;
    }

    state.status.phase = 'failed';
    state.status.provisioned = false;
    state.status.error = error.message || String(error);
    state.status.terraformStateExists = terraformStateExists;
    state.status.failedAt = new Date().toISOString();

    await this.save(infraName, state);
    return state;
  }

  static async setProvisioned(infraName, provider, clusters, dns = null) {
    let state = await this.load(infraName);

    if (!state) {
      state = this.createEmptyState(infraName, provider);
    }

    state.status.phase = 'provisioned';
    state.status.provisioned = true;
    state.status.provisionedAt = new Date().toISOString();
    state.status.clusters = clusters.map(cluster => {
      const entry = {
        name: cluster.name,
        context: cluster.context,
        cluster: cluster.cluster || null,
        kubeconfig: cluster.kubeconfig || null,
        provisioned: true,
      };
      if (cluster.network) {
        entry.network = cluster.network;
      }
      if (cluster.iam) {
        entry.iam = cluster.iam;
      }
      return entry;
    });

    // Clear any previous error state
    delete state.status.error;
    delete state.status.failedAt;
    delete state.status.terraformStateExists;

    // Store DNS outputs if provided
    if (dns) {
      state.status.dns = {
        enabled: true,
        zoneId: dns.zoneId || null,
        zoneName: dns.zoneName || null,
        nameservers: dns.nameservers || [],
      };
    }

    await this.save(infraName, state);
    return state;
  }

  static async clear(infraName) {
    const state = this.createEmptyState(infraName, null);
    state.status.phase = 'destroyed';
    await this.save(infraName, state);
  }

  static async setDestroying(infraName) {
    let state = await this.load(infraName);

    if (!state) {
      return null;
    }

    state.status.phase = 'destroying';
    await this.save(infraName, state);
    return state;
  }

  static hasTerraformState(infraName) {
    const tfStatePath = join(this.getOutputDir(infraName), 'terraform.tfstate');
    return existsSync(tfStatePath);
  }

  static needsCleanup(state) {
    if (!state) return false;

    if (state.status?.provisioned) return true;
    if (state.status?.phase === 'failed' && state.status?.terraformStateExists) return true;
    if (state.status?.phase === 'provisioning') return true;

    return false;
  }

  static resolveContextForCluster(state, clusterName) {
    if (!state?.status?.clusters) {
      return null;
    }
    const cluster = state.status.clusters.find(
      c => c.name.toLowerCase() === clusterName.toLowerCase()
    );
    return cluster?.context || null;
  }

  static getAllContexts(state) {
    if (!state?.status?.clusters) {
      return [];
    }
    return state.status.clusters
      .filter(c => c.context)
      .map(c => ({ name: c.name, context: c.context, kubeconfig: c.kubeconfig }));
  }

  static getDnsState(state) {
    if (!state?.status?.dns?.enabled) {
      return null;
    }
    return state.status.dns;
  }

  static getClusterNetwork(state, clusterName) {
    if (!state?.status?.clusters) return null;
    const cluster = state.status.clusters.find(
      c => c.name.toLowerCase() === clusterName.toLowerCase()
    );
    return cluster?.network || null;
  }

  static async listInfraProfiles() {
    if (!existsSync(INFRA_OUTPUT_BASE)) {
      return [];
    }

    const { readdir } = await import('fs/promises');
    const entries = await readdir(INFRA_OUTPUT_BASE, { withFileTypes: true });
    const profiles = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const statePath = join(INFRA_OUTPUT_BASE, entry.name, 'state.yaml');
        if (existsSync(statePath)) {
          try {
            const content = await readFile(statePath, 'utf8');
            const state = yaml.load(content);
            const hasTfState = this.hasTerraformState(entry.name);

            profiles.push({
              name: entry.name,
              provider: state.metadata?.provider || 'unknown',
              phase: state.status?.phase || 'unknown',
              provisioned: state.status?.provisioned || false,
              clusterCount: state.status?.clusters?.length || 0,
              updatedAt: state.metadata?.updatedAt || null,
              error: state.status?.error || null,
              terraformStateExists: hasTfState,
              needsCleanup: this.needsCleanup(state) || hasTfState,
            });
          } catch {
            const hasTfState = this.hasTerraformState(entry.name);
            profiles.push({
              name: entry.name,
              provider: 'unknown',
              phase: 'unknown',
              provisioned: false,
              clusterCount: 0,
              updatedAt: null,
              error: null,
              terraformStateExists: hasTfState,
              needsCleanup: hasTfState,
            });
          }
        }
      }
    }

    return profiles.sort((a, b) => a.name.localeCompare(b.name));
  }
}
