// src/lib/environment.js
import { readdir, readFile } from 'fs/promises';
import { join, basename } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { existsSync } from 'fs';
import yaml from 'js-yaml';
import { InfraStateManager } from './infra-state.js';
import { InfraSchema } from './infra-schema.js';
import { ProfileSchema } from './profile-schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');

export class EnvironmentManager {
  static ENVIRONMENTS_DIR = join(PROJECT_ROOT, 'config/environments');

  /**
   * List available environments
   * @param {string} [root] - Optional project root directory. Defaults to this project's root.
   * @returns {Promise<Array<{name: string, file: string, description: string}>>}
   */
  static async list(root) {
    const dir = root ? join(root, 'config', 'environments') : this.ENVIRONMENTS_DIR;
    if (!existsSync(dir)) {
      return [];
    }
    const files = await readdir(dir);
    const yamlFiles = files.filter(f => f.endsWith('.yaml'));
    const environments = [];
    for (const file of yamlFiles) {
      const name = basename(file, '.yaml');
      const filePath = join(dir, file);
      try {
        const content = await readFile(filePath, 'utf8');
        const env = yaml.load(content);
        environments.push({
          name,
          file: filePath,
          description: env.metadata?.description || '',
        });
      } catch {
        environments.push({ name, file: filePath, description: '' });
      }
    }
    return environments.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Load environment by name
   * @param {string} name - Environment name
   * @returns {Promise<object>} Parsed environment object
   */
  static async load(name) {
    const filePath = join(this.ENVIRONMENTS_DIR, `${name}.yaml`);

    if (!existsSync(filePath)) {
      throw new Error(`Environment '${name}' not found at ${filePath}`);
    }

    const content = await readFile(filePath, 'utf8');
    const env = yaml.load(content);

    this.validate(env, name);

    return env;
  }

  /**
   * Validate environment schema
   * @param {object} env - Environment object
   * @param {string} name - Environment name for error messages
   */
  static validate(env, name) {
    if (!env.apiVersion || env.apiVersion !== 'agentic.demo/v1') {
      throw new Error(`Environment '${name}' has invalid apiVersion (expected 'agentic.demo/v1')`);
    }

    if (!env.kind || env.kind !== 'Environment') {
      throw new Error(`Environment '${name}' has invalid kind (expected 'Environment')`);
    }

    if (!env.metadata?.name) {
      throw new Error(`Environment '${name}' missing metadata.name`);
    }

    if (!env.spec) {
      throw new Error(`Environment '${name}' missing spec`);
    }

    if (!env.spec.domains || typeof env.spec.domains !== 'object') {
      throw new Error(`Environment '${name}' missing spec.domains`);
    }

    // Validate DNS config if present
    if (env.spec.dns) {
      const dns = env.spec.dns;
      const validProviders = ['route53', 'azure-dns', 'cloud-dns'];
      if (!validProviders.includes(dns.provider)) {
        throw new Error(
          `Environment '${name}' has invalid DNS provider '${dns.provider}' (expected: ${validProviders.join(', ')})`
        );
      }

      if (!dns.parentZone?.domain) {
        throw new Error(`Environment '${name}' missing dns.parentZone.domain`);
      }

      if (!dns.childZone) {
        throw new Error(`Environment '${name}' missing dns.childZone`);
      }
    }
  }

  /**
   * Check if an environment exists
   * @param {string} name - Environment name
   * @returns {Promise<boolean>}
   */
  static async exists(name) {
    const filePath = join(this.ENVIRONMENTS_DIR, `${name}.yaml`);
    return existsSync(filePath);
  }

  /**
   * Resolve the active environment name.
   *
   * Resolution order:
   *   1. profile.spec.environment (if profileName provided)
   *   2. provisioned infra profile spec.environment
   *   3. 'local' (default)
   *
   * @param {string} [profileName] - Optional installation profile name to check first
   * @returns {Promise<string>} Environment name
   */
  static async resolveActive(profileName = null) {
    // 1. Check installation profile directly (mirrors agentic pattern)
    if (profileName) {
      try {
        const profilePath = join(PROJECT_ROOT, 'config', 'profiles', `${profileName}.yaml`);
        if (existsSync(profilePath)) {
          const content = await readFile(profilePath, 'utf8');
          const profile = yaml.load(content);
          const envName = ProfileSchema.getEnvironment(profile);
          if (envName) return envName;
        }
      } catch {
        // fall through
      }
    }

    // 2. Check provisioned infra state
    try {
      const profiles = await InfraStateManager.listInfraProfiles();
      const provisioned = profiles.find(p => p.provisioned);

      if (provisioned) {
        const infraPath = join(PROJECT_ROOT, 'config', 'infra', `${provisioned.name}.yaml`);
        if (existsSync(infraPath)) {
          const content = await readFile(infraPath, 'utf8');
          const infraProfile = yaml.load(content);
          const envName = InfraSchema.getEnvironment(infraProfile);
          if (envName) return envName;
        }
      }
    } catch {
      // fall through to default
    }

    return 'local';
  }

  /**
   * Resolve a single template string
   * @param {string} template - Template string like '{{env.domains.core.keycloak}}'
   * @param {object} env - Environment object
   * @returns {string} Resolved string
   */
  static resolveTemplate(template, env) {
    if (typeof template !== 'string') {
      return template;
    }

    return template.replace(/\{\{env\.([^}]+)\}\}/g, (match, path) => {
      const value = this.getNestedValue(env.spec, path);
      if (value === undefined) {
        throw new Error(
          `Template variable '{{env.${path}}}' not found in environment '${env.metadata.name}'`
        );
      }
      return value;
    });
  }

  /**
   * Get nested value from object using dot notation
   * @param {object} obj - Object to traverse
   * @param {string} path - Dot-separated path like 'domains.core.keycloak'
   * @returns {*} Value at path or undefined
   */
  static getNestedValue(obj, path) {
    const parts = path.split('.');
    let current = obj;

    for (const part of parts) {
      if (current === null || current === undefined) {
        return undefined;
      }
      current = current[part];
    }

    return current;
  }

  /**
   * Resolve all templates in an object recursively
   * @param {*} obj - Object, array, or primitive to resolve
   * @param {object} env - Environment object
   * @returns {*} Resolved object
   */
  static resolveAllTemplates(obj, env) {
    if (typeof obj === 'string') {
      return this.resolveTemplate(obj, env);
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.resolveAllTemplates(item, env));
    }

    if (obj !== null && typeof obj === 'object') {
      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.resolveAllTemplates(value, env);
      }
      return result;
    }

    return obj;
  }
}
