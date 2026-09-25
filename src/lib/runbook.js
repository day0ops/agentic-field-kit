// src/lib/runbook.js
import inquirer from 'inquirer';
const { Separator } = inquirer;
import fs from 'fs';
import path from 'path';
import { load as yamlLoad } from 'js-yaml';
import { glob } from 'glob';
import { Prompts } from './prompts.js';

export class RunbookPicker {
  async pick(options = {}) {
    // 1. Load and filter profiles
    const profiles = await this.listProfiles();
    const filtered = profiles.filter(p => p.spec?.infra && p.spec?.environment);

    if (filtered.length === 0) {
      throw new Error('No profiles with spec.infra found in config/profiles/');
    }

    // 2. Interactive profile selection
    const profileName = await Prompts.select(
      'Select a profile to generate a runbook for:',
      filtered.map(p => ({
        name: p.metadata.name,
        short: p.metadata.name,
        description: (p.metadata.description || '').trim() || null,
        value: p.metadata.name,
      }))
    );

    const profile = filtered.find(p => p.metadata.name === profileName);
    const infraProfile = await this.loadInfraProfile(profile.spec.infra);
    const environment = await this.loadEnvironment(profile.spec.environment);

    // 3. Use case selection — category → use cases funnel, pre-scoped to whichever topology
    // (single-cluster vs multi-cluster) the selected profile's infra actually has. A
    // single-cluster profile can never satisfy a multi-cluster use case's spec.clusters, and
    // vice versa, so there's nothing to ask — it's fully determined by the profile's cluster
    // count, not a separate choice.
    const scope = inferUsecaseScope(infraProfile);
    const allUsecases = (await this.listUsecases(infraProfile)).filter(
      u => u._filePath.split('/')[2] === scope
    );
    let selectedUsecases = [];
    if (allUsecases.length > 0) {
      const humanize = s => s.replace(/-/g, ' ');
      const getPathParts = u => u._filePath.split('/'); // config/usecases/<scope>/<category>/...

      console.log(
        `\nUse case scope: ${humanize(scope)} (inferred from ${infraProfile.spec?.clusters?.length || 0} cluster(s) in profile)`
      );

      // Category → use cases loop — back to category, until done
      const availableCategories = [...new Set(allUsecases.map(u => getPathParts(u)[3]))].sort();
      const selectedNames = new Set();

      while (true) {
        const count = selectedNames.size;
        const { selectedCategory } = await inquirer.prompt([
          {
            type: 'list',
            name: 'selectedCategory',
            message: `Select category${count > 0 ? ` (${count} use case${count > 1 ? 's' : ''} selected)` : ''}:`,
            choices: [
              ...availableCategories.map(c => ({ name: humanize(c), value: c })),
              new Separator(),
              { name: 'done', value: '__done__' },
            ],
          },
        ]);

        if (selectedCategory === '__done__') break;

        const categoryFiltered = allUsecases.filter(u => getPathParts(u)[3] === selectedCategory);
        const usecaseChoices = categoryFiltered.map(u => ({
          name: `${u.metadata.name}  —  ${(u.metadata.description || '').split('\n')[0].trim()}`,
          value: u.metadata.name,
          checked: selectedNames.has(u.metadata.name),
        }));

        const { usecaseNames } = await inquirer.prompt([
          {
            type: 'checkbox',
            name: 'usecaseNames',
            message: `Select use cases from ${humanize(selectedCategory)}:`,
            choices: usecaseChoices,
          },
        ]);

        // Sync selections for this category (allow deselect on revisit)
        for (const u of categoryFiltered) {
          if (usecaseNames.includes(u.metadata.name)) selectedNames.add(u.metadata.name);
          else selectedNames.delete(u.metadata.name);
        }

        // Show current selection summary
        if (selectedNames.size === 0) {
          console.log('\n  (none selected)\n');
        } else {
          console.log('');
          for (const name of selectedNames) {
            console.log(`  • ${name}`);
          }
          console.log('');
        }
      }

      selectedUsecases = allUsecases.filter(u => selectedNames.has(u.metadata.name));
    }

    // 4. Output config — always prefix today's date (local), stripping any existing date prefix
    const _d = new Date();
    const today = [
      _d.getFullYear(),
      String(_d.getMonth() + 1).padStart(2, '0'),
      String(_d.getDate()).padStart(2, '0'),
    ].join('-');
    const baseFilename = (options.filename || profileName).replace(/^\d{4}-\d{2}-\d{2}-/, '');
    const defaultFilename = `${today}-${baseFilename}`;

    const { outputDir, filename } = await inquirer.prompt([
      {
        type: 'input',
        name: 'outputDir',
        message: 'Output directory:',
        default: options.output || 'docs/runbooks',
      },
      {
        type: 'input',
        name: 'filename',
        message: 'Filename (without .md):',
        default: defaultFilename,
      },
    ]);

    return { profile, infraProfile, environment, usecases: selectedUsecases, outputDir, filename };
  }

  async listProfiles() {
    const files = await glob('config/profiles/*.yaml');
    const loaded = await Promise.all(
      files.map(async f => {
        try {
          return yamlLoad(await fs.promises.readFile(f, 'utf8'));
        } catch {
          return null;
        }
      })
    );
    return loaded.filter(Boolean);
  }

  async loadInfraProfile(name) {
    const filePath = `config/infra/${name}.yaml`;
    return yamlLoad(await fs.promises.readFile(filePath, 'utf8'));
  }

  async loadEnvironment(name) {
    const filePath = `config/environments/${name}.yaml`;
    return yamlLoad(await fs.promises.readFile(filePath, 'utf8'));
  }

  async listUsecases(infraProfile) {
    const files = await glob('config/usecases/**/*.yaml');
    const clusterNames = (infraProfile.spec.clusters || []).map(c => c.name);
    const loaded = await Promise.all(
      files.map(async f => {
        try {
          const data = yamlLoad(await fs.promises.readFile(f, 'utf8'));
          if (data) {
            // Derive category from path: config/usecases/<scope>/<category>/...
            const parts = f.split('/');
            data._filePath = f;
            data._category = parts.length >= 4 ? `${parts[2]} / ${parts[3]}` : 'other';
          }
          return data;
        } catch {
          return null;
        }
      })
    );
    return loaded.filter(u => {
      if (!u || u.kind !== 'UseCase') return false;
      if (!u.spec?.clusters || u.spec.clusters.length === 0) return true;
      return u.spec.clusters.some(c => clusterNames.includes(c.name));
    });
  }
}

// A use case under config/usecases/single-cluster/ can only ever declare 0 or 1 clusters in
// spec.clusters; one under multi-cluster/ is written assuming 2+. Matching that folder to the
// profile's actual cluster count is the only sensible scope — never a user choice.
export function inferUsecaseScope(infraProfile) {
  return (infraProfile.spec?.clusters || []).length > 1 ? 'multi-cluster' : 'single-cluster';
}

export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/ /g, '-');
}

export function scanHeadings(content) {
  const entries = [];
  for (const line of content.split('\n')) {
    const h2 = line.match(/^## (.+)$/);
    const h3 = line.match(/^### (.+)$/);
    const h4 = line.match(/^#### (.+)$/);
    if (h2) {
      entries.push({ level: 2, text: h2[1], anchor: slugify(h2[1]) });
    } else if (h3) {
      entries.push({ level: 3, text: h3[1], anchor: slugify(h3[1]) });
    } else if (h4) {
      entries.push({ level: 4, text: h4[1], anchor: slugify(h4[1]) });
    }
  }
  return entries;
}

function _buildToc(content) {
  const lines = scanHeadings(content).map(e => {
    const indent = '  '.repeat(e.level - 2);
    return `${indent}- [${e.text}](#${e.anchor})`;
  });
  return `## Table of Contents\n\n${lines.join('\n')}`;
}

export class RunbookBuilder {
  constructor(selection) {
    this.selection = selection;
  }

  async _assemble() {
    const { InfraAdapter } = await import('./runbook-adapters/infra.js');
    const { EnvAdapter } = await import('./runbook-adapters/env.js');
    const { DiagramAdapter } = await import('./runbook-adapters/diagram.js');
    const { InstallAdapter } = await import('./runbook-adapters/install.js');
    const { AddonAdapter } = await import('./runbook-adapters/addon.js');
    const { UseCaseAdapter } = await import('./runbook-adapters/usecase.js');

    const infraAdapter = new InfraAdapter();
    const envAdapter = new EnvAdapter();
    const diagramAdapter = new DiagramAdapter();
    const installAdapter = new InstallAdapter();
    const addonAdapter = new AddonAdapter();
    const usecaseAdapter = new UseCaseAdapter();

    // Collect env vars from sync adapters (deduplicated)
    const allEnvVars = [];
    const allEnvExports = [];
    const seenVars = new Set();
    const seenExports = new Set();

    const syncAdapters = [infraAdapter, envAdapter, diagramAdapter, installAdapter, usecaseAdapter];
    for (const adapter of syncAdapters) {
      for (const v of adapter.envVars(this.selection) || []) {
        if (!seenVars.has(v.name)) {
          seenVars.add(v.name);
          allEnvVars.push(v);
        }
      }
      for (const e of adapter.envExports(this.selection) || []) {
        if (!seenExports.has(e.name)) {
          seenExports.add(e.name);
          allEnvExports.push(e);
        }
      }
    }

    // Collect from async addon sidecars
    for (const v of await addonAdapter.envVars(this.selection)) {
      if (!seenVars.has(v.name)) {
        seenVars.add(v.name);
        allEnvVars.push(v);
      }
    }
    for (const e of await addonAdapter.envExports(this.selection)) {
      if (!seenExports.has(e.name)) {
        seenExports.add(e.name);
        allEnvExports.push(e);
      }
    }

    // Generate all lab sections
    const now = new Date();
    const today = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ].join('-');
    const timestamp = `${today} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')} (local)`;

    const header = `# Agentic Demo Runbook\n\nGenerated: ${timestamp}\n\n---\n`;
    // infra generates prereqs (0) + auth (1) here; provisioning moves to lab 3, after env
    // vars, since env vars (credentials, region, etc.) must be predefined before terraform
    // can use them.
    const labs01 = infraAdapter.generate(0, this.selection);
    const lab2 = envAdapter.generate(2, this.selection, allEnvVars, allEnvExports);
    const lab3 = infraAdapter.generateProvisioning(3, this.selection);
    const lab4 = diagramAdapter.generate(4, this.selection);
    // Cert/trust bootstrap (cacerts secrets, SPIRE distinct roots) must exist before ANY
    // addon or mesh component installs — mirrors installer.js's real global-then-per-cluster
    // order (see InstallAdapter.generateCertSetup). Addons (Lab 6) come after, not before.
    const addonPreambles = await addonAdapter.generatePreambles(this.selection);
    const lab5 = installAdapter.generateCertSetup(5, this.selection, addonPreambles);
    const lab6 = await addonAdapter.generate(6, this.selection);
    const lab7 = installAdapter.generate(7, this.selection);
    const lab8 = await usecaseAdapter.generate(8, this.selection);

    // Lab 9 aggregates cleanup from every adapter, in reverse of install order:
    // use cases -> Istio Ambient -> addons -> infrastructure (terraform destroy).
    let cleanupIndex = 1;
    const cleanupSections = [];

    const usecaseCleanup = usecaseAdapter.generateCleanupSections(9, this.selection, cleanupIndex);
    cleanupSections.push(...usecaseCleanup);
    cleanupIndex += usecaseCleanup.length;

    const installCleanup = installAdapter.generateCleanupSections(9, this.selection, cleanupIndex);
    cleanupSections.push(...installCleanup);
    cleanupIndex += installCleanup.length;

    const addonCleanup = await addonAdapter.generateCleanupSections(9, this.selection, cleanupIndex);
    cleanupSections.push(...addonCleanup);
    cleanupIndex += addonCleanup.length;

    const infraCleanup = infraAdapter.generateCleanupSections(9, this.selection, cleanupIndex);
    cleanupSections.push(...infraCleanup);

    const lab9 = cleanupSections.length
      ? `## Lab 9 — Cleanup\n\n${cleanupSections.join('\n\n---\n\n')}`
      : '';

    const body = [labs01, lab2, lab3, lab4, lab5, lab6, lab7, lab8, lab9]
      .filter(Boolean)
      .join('\n\n');
    const toc = _buildToc(body);
    const content = [header, toc, body].join('\n\n');

    return { content };
  }

  async build() {
    const { content } = await this._assemble();

    const { outputDir, filename } = this.selection;
    fs.mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, `${filename}.md`);
    fs.writeFileSync(outputPath, content, 'utf8');

    const lineCount = content.split('\n').length;
    console.log(`\nRunbook written to ${outputPath} (${lineCount} lines)`);
    return outputPath;
  }

  async buildHtml() {
    const { content } = await this._assemble();
    const { HtmlRenderer } = await import('./runbook-html.js');
    const html = new HtmlRenderer().render(content, this.selection);

    const { outputDir, filename } = this.selection;
    fs.mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, `${filename}.html`);
    fs.writeFileSync(outputPath, html, 'utf8');

    const lineCount = html.split('\n').length;
    console.log(`\nRunbook written to ${outputPath} (${lineCount} lines)`);
    return outputPath;
  }
}
