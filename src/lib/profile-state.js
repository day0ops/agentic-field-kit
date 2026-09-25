import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');
const INFRA_OUTPUT_BASE = join(PROJECT_ROOT, '._output', 'infra');

/**
 * InstallStateManager
 * Tracks mesh installation state per infra profile (verified clusters, installed mesh version).
 * State is stored alongside infra output at ._output/infra/<name>/install-state.yaml
 */
export class ProfileStateManager {
  static INFRA_OUTPUT_BASE = INFRA_OUTPUT_BASE;

  static getStatePath(infraName) {
    return join(INFRA_OUTPUT_BASE, infraName, 'install-state.yaml');
  }

  static getOutputDir(infraName) {
    return join(INFRA_OUTPUT_BASE, infraName);
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
      throw new Error(`Failed to load install state for '${infraName}': ${error.message}`);
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

  static createEmptyState(infraName) {
    return {
      apiVersion: 'agentic.demo/v1',
      kind: 'InstallState',
      metadata: {
        name: infraName,
        updatedAt: new Date().toISOString(),
      },
      status: {
        clusters: [],
      },
    };
  }

  static async setVerified(infraName, clusterName, verified = true) {
    let state = await this.load(infraName);

    if (!state) {
      state = this.createEmptyState(infraName);
    }

    if (!state.status) {
      state.status = { clusters: [] };
    }
    if (!state.status.clusters) {
      state.status.clusters = [];
    }

    const existing = state.status.clusters.find(c => c.name === clusterName);
    if (existing) {
      existing.verified = verified;
    } else {
      state.status.clusters.push({ name: clusterName, verified });
    }

    await this.save(infraName, state);
    return state;
  }

  static async getCluster(infraName, clusterName) {
    const state = await this.load(infraName);

    if (!state?.status?.clusters) {
      return null;
    }

    return state.status.clusters.find(c => c.name === clusterName) || null;
  }

  static async clear(infraName) {
    const state = this.createEmptyState(infraName);
    await this.save(infraName, state);
  }

  static async setProfileName(infraName, profileName, infraProvisionedAt = null) {
    let state = await this.load(infraName);
    if (!state) {
      state = this.createEmptyState(infraName);
    }
    if (!state.status) state.status = { clusters: [] };
    state.status.profileName = profileName;
    state.status.infraProvisionedAt = infraProvisionedAt;
    await this.save(infraName, state);
    return state;
  }

  /**
   * Returns the profile name recorded at install time, or null if there isn't one
   * or it's stale.
   *
   * install-state.yaml lives under ._output/infra/<name>/, which is not cleared when
   * infra is destroyed/reprovisioned under the same name — so a record from a previous
   * infra generation can silently persist. Pass the infra's current
   * status.provisionedAt (from InfraStateManager) so a mismatch is treated as stale
   * rather than trusted.
   */
  static async getProfileName(infraName, currentProvisionedAt = null) {
    const state = await this.load(infraName);
    if (!state?.status?.profileName) return null;
    if (currentProvisionedAt && state.status.infraProvisionedAt !== currentProvisionedAt) {
      return null;
    }
    return state.status.profileName;
  }
}
