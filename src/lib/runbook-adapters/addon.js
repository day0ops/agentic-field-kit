// src/lib/runbook-adapters/addon.js
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class AddonAdapter {
  async envVars(selection) {
    const results = [];
    const seen = new Set();
    for (const { addon, clusterName, sidecar } of await this._iterateAddons(selection)) {
      if (!sidecar?.envVarsFor) continue;
      for (const v of sidecar.envVarsFor(addon, clusterName) || []) {
        if (!seen.has(v.name)) {
          seen.add(v.name);
          results.push(v);
        }
      }
    }
    return results;
  }

  async envExports(selection) {
    const results = [];
    const seen = new Set();
    const { profile, environment } = selection;
    for (const { addon, sidecar } of await this._iterateAddons(selection)) {
      if (!sidecar?.envExportsFor) continue;
      for (const e of sidecar.envExportsFor(addon, profile, environment) || []) {
        if (!seen.has(e.name)) {
          seen.add(e.name);
          results.push(e);
        }
      }
    }
    return results;
  }

  // Preambles cover setup that must happen once, globally, before ANY cluster installs
  // anything — e.g. SPIRE's distinctRoots pre-generating every cluster's independent root
  // before any cluster's SPIRE addon runs. Rendered as part of Lab "Cluster Bootstrap",
  // before addon installation even starts (not interleaved into the addon Lab itself).
  async generatePreambles(selection) {
    const addons = await this._iterateAddons(selection);
    const seen = new Set();
    const results = [];
    for (const { addon, sidecar } of addons) {
      if (!sidecar?.generatePreamble || seen.has(addon.name)) continue;
      seen.add(addon.name);
      const instances = addons.filter(a => a.addon.name === addon.name);
      const preamble = await sidecar.generatePreamble(instances, selection);
      if (preamble) results.push(preamble);
    }
    return results;
  }

  async generate(labNum, selection) {
    const { profile, environment } = selection;
    const addons = await this._iterateAddons(selection);
    const sections = [];
    let subIndex = 1;

    for (const { addon, clusterName, sidecar } of addons) {
      const label = clusterName === 'global' ? '(global)' : `(${clusterName})`;
      const heading = `### Lab ${labNum}.${subIndex} — ${addon.name} ${label}`;

      if (!sidecar?.generate) {
        sections.push(
          `${heading}\n\n> _No runbook sidecar found for \`${addon.name}\`. Skipping._`
        );
      } else {
        const content = await sidecar.generate(subIndex, addon, clusterName, profile, environment);
        sections.push(`${heading}\n\n${content}`);
      }
      subIndex++;
    }

    return `## Lab ${labNum} — Addon Installation\n\n${sections.join('\n\n---\n\n')}`;
  }

  async _iterateAddons(selection) {
    const { profile, infraProfile } = selection;
    const result = [];

    // A "global" addon (e.g. cilium, cert-manager) is part of every cluster's own addon
    // set (see ConfigResolver.resolveForCluster) — it installs once per cluster, not once
    // for the whole profile. Expand it to one entry per real cluster so the generated
    // commands actually target each cluster's context instead of silently running once.
    const clusterNames = (infraProfile?.spec?.clusters || []).map(c => c.name);
    for (const addon of profile.spec.addons?.global || []) {
      const sidecar = await this._loadSidecar(addon.name);
      if (clusterNames.length === 0) {
        result.push({ addon, clusterName: 'global', sidecar });
      } else {
        for (const clusterName of clusterNames) {
          result.push({ addon, clusterName, sidecar });
        }
      }
    }

    for (const clusterDef of profile.spec.addons?.clusters || []) {
      for (const addon of clusterDef.addons || []) {
        const sidecar = await this._loadSidecar(addon.name);
        result.push({ addon, clusterName: clusterDef.name, sidecar });
      }
    }

    return result;
  }

  async _loadSidecar(addonName) {
    const sidecarPath = path.resolve(__dirname, `../../../addons/${addonName}/runbook.js`);
    try {
      return await import(sidecarPath);
    } catch (e) {
      if (e.code === 'ERR_MODULE_NOT_FOUND') {
        console.warn(`[runbook] Warning: no runbook.js sidecar for addon "${addonName}", skipping`);
        return null;
      }
      throw e;
    }
  }

  cleanup(_selection) {
    return '';
  }

  async generateCleanupSections(labNum, selection, startIndex) {
    const addons = await this._iterateAddons(selection);
    if (addons.length === 0) return [];

    const lines = ['Remove in reverse order of installation:', ''];
    for (const { addon, clusterName, sidecar } of [...addons].reverse()) {
      const label = clusterName === 'global' ? '(global)' : `(${clusterName})`;
      lines.push(`**${addon.name} ${label}**`);
      lines.push('');
      if (!sidecar?.cleanup) {
        lines.push(
          `_No cleanup sidecar found for \`${addon.name}\`. Remove it manually if needed._`
        );
      } else {
        lines.push(await sidecar.cleanup(addon, clusterName));
      }
      lines.push('');
    }

    const heading = `### Lab ${labNum}.${startIndex} — Uninstall Addons`;
    return [`${heading}\n\n${lines.join('\n').trimEnd()}`];
  }
}
