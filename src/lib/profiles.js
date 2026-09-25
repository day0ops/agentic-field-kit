import { readFile, readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { Prompts } from './prompts.js';
import { ProfileSchema } from './profile-schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');
const PROFILES_DIR = join(PROJECT_ROOT, 'config', 'profiles');

export class ProfileManager {
  static PROFILES_DIR = PROFILES_DIR;

  static getProfileYamlPath(profileName) {
    return join(PROFILES_DIR, `${profileName}.yaml`);
  }

  /**
   * Load and validate a profile by name.
   */
  static async load(profileName) {
    const profilePath = this.getProfileYamlPath(profileName);

    try {
      const content = await readFile(profilePath, 'utf8');
      const profile = yaml.load(content);

      const validation = ProfileSchema.validate(profile);
      if (!validation.valid) {
        throw new Error(`Profile validation failed:\n  - ${validation.errors.join('\n  - ')}`);
      }

      return profile;
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`Profile '${profileName}' not found at ${profilePath}`);
      }
      throw error;
    }
  }

  /**
   * List all available profiles from config/profiles/.
   */
  static async list() {
    try {
      const entries = await readdir(PROFILES_DIR, { withFileTypes: true });
      const profiles = [];

      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.yaml')) {
          const name = entry.name.replace('.yaml', '');
          const filePath = join(PROFILES_DIR, entry.name);

          try {
            const content = await readFile(filePath, 'utf8');
            const profile = yaml.load(content);
            const validation = ProfileSchema.validate(profile);

            profiles.push({
              name,
              file: filePath,
              description: profile.metadata?.description || '',
              valid: validation.valid,
              errors: validation.errors,
              istioVersion: ProfileSchema.getIstioVersion(profile),
              hasRoles: ProfileSchema.hasRoles(profile),
              infra: ProfileSchema.getInfra(profile),
              componentCount: ProfileSchema.getBaseComponents(profile).length,
              addonCount: ProfileSchema.getBaseAddons(profile).length,
            });
          } catch (error) {
            profiles.push({
              name,
              file: filePath,
              description: '',
              valid: false,
              errors: [error.message],
              istioVersion: null,
              hasRoles: false,
              componentCount: 0,
              addonCount: 0,
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

  /**
   * Interactive profile selection.
   */
  static async select() {
    const profiles = await this.list();

    if (profiles.length === 0) {
      throw new Error('No profiles found in config/profiles/');
    }

    const choices = profiles.map(p => ({
      name: p.name,
      short: p.name,
      description: p.description.trim() || null,
      value: p.name,
    }));

    const selected = await Prompts.select('Select installation profile:', choices);
    const profile = profiles.find(p => p.name === selected);

    return {
      name: profile.name,
      file: profile.file,
    };
  }

  /**
   * Get a summary of the profile for display.
   */
  static async getProfileSummary(profileName) {
    const profile = await this.load(profileName);
    const mesh = ProfileSchema.getMesh(profile);

    const summary = {
      name: profile.metadata?.name || profileName,
      description: profile.metadata?.description || '',
      istioVersion: mesh?.istioVersion || 'unknown',
      meshProfile: mesh?.profile || 'ambient',
      infra: ProfileSchema.getInfra(profile),
      components: ProfileSchema.getBaseComponents(profile),
      addons: ProfileSchema.getBaseAddons(profile),
      hasRoles: ProfileSchema.hasRoles(profile),
      roles: Object.keys(ProfileSchema.getRoles(profile)),
      clusterOverrides: ProfileSchema.getClusterOverrides(profile).map(c => c.name),
    };

    return summary;
  }
}
