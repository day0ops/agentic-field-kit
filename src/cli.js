#!/usr/bin/env node

import { Command, Option } from 'commander';
import chalk from 'chalk';
import figlet from 'figlet';
import logSymbols from 'log-symbols';
import { Logger, checkDependencies } from './lib/common.js';
import { ProfileManager } from './lib/profiles.js';
import { ProfileSchema } from './lib/profile-schema.js';
import { InfraManager } from './lib/infra-manager.js';
import { InfraStateManager } from './lib/infra-state.js';
import { InstallerManager } from './lib/installer.js';
import { ProfileStateManager } from './lib/profile-state.js';
import { FeatureManager } from './lib/feature.js';
import { UseCaseManager } from './lib/usecase.js';
import '../features/index.js';
import '../addons/index.js';
import { Prompts } from './lib/prompts.js';
import { CLI_VERSION, CLI_DESCRIPTION } from './lib/version.js';

// SIGINT handled via ExitPromptError catch at bottom of file (avoids unsettled top-level await warning)

const program = new Command();

// Show CLI banner
function showBanner() {
  const banner = figlet.textSync('Agentic', { font: 'Standard', horizontalLayout: 'default' });
  console.log(chalk.cyan(banner));
  console.log(chalk.gray(`  Agentic Field Kit v${CLI_VERSION}\n`));
}

program
  .name('agentic')
  .description(CLI_DESCRIPTION)
  .version(CLI_VERSION)
  .hook('preAction', () => {
    showBanner();
  });

program
  .command('version')
  .description('Display banner, version, and description')
  .option('-s, --short', 'Print only version and description')
  .action(options => {
    if (options.short) {
      console.log(CLI_VERSION);
      console.log(CLI_DESCRIPTION);
      return;
    }
    console.log(chalk.gray('  Description: ') + chalk.white(CLI_DESCRIPTION));
    console.log(chalk.gray('  Version:     ') + chalk.white(CLI_VERSION));
    console.log(chalk.gray('  Node:        ') + chalk.white(process.version));
    console.log();
  });

// ============================================
// Base commands
// ============================================
const base = program.command('base').description('Manage base infrastructure');

// Infra commands
const infra = base.command('infra').description('Manage infrastructure');

// ============================================
// Cloud infrastructure subcommands
// ============================================

function printCloudInfraStatus(status, { kubeContext, matchedByContext } = {}) {
  if (kubeContext) {
    const matchLabel = matchedByContext ? chalk.green(' (matched)') : '';
    console.log(`\n${chalk.bold('Kubectl context:')} ${kubeContext}${matchLabel}`);
  }
  console.log(`${chalk.bold('Infra Profile:')} ${chalk.cyan(status.name)}`);
  console.log(`${chalk.bold('Provider:')} ${status.provider}`);
  console.log(`${chalk.bold('Defined clusters:')} ${status.defined}`);

  let phaseDisplay;
  switch (status.phase) {
    case 'provisioned':
      phaseDisplay = chalk.green('provisioned');
      break;
    case 'failed':
      phaseDisplay = chalk.red('failed');
      break;
    case 'provisioning':
      phaseDisplay = chalk.yellow('provisioning');
      break;
    case 'destroying':
      phaseDisplay = chalk.yellow('destroying');
      break;
    default:
      phaseDisplay = chalk.gray('not provisioned');
  }
  console.log(`${chalk.bold('Phase:')} ${phaseDisplay}`);

  if (status.error) {
    console.log(`${chalk.bold('Error:')} ${chalk.red(status.error)}`);
  }

  if (status.terraformStateExists && !status.provisioned) {
    console.log(
      `${chalk.bold('Terraform State:')} ${chalk.yellow('exists (partial resources may be provisioned)')}`
    );
  }

  if (status.needsCleanup && !status.provisioned) {
    console.log(
      `\n${chalk.yellow('⚠')}  Run ${chalk.cyan(`agentic base infra cloud destroy -p ${status.name}`)} to clean up partial resources`
    );
  }

  if (status.updatedAt) {
    console.log(`${chalk.bold('Last updated:')} ${status.updatedAt}`);
  }

  if (status.clusters.length > 0) {
    console.log(`\n${chalk.bold('Clusters:')}`);
    for (const cluster of status.clusters) {
      console.log(`  ${chalk.bold(cluster.name)}`);
      if (cluster.cluster) {
        console.log(`    ${chalk.bold('Cluster:')}  ${cluster.cluster}`);
      }
      if (cluster.context && cluster.context !== kubeContext) {
        console.log(`    ${chalk.bold('Context:')}  ${cluster.context}`);
      }
      if (cluster.kubeconfig) {
        console.log(
          `    ${chalk.bold('Kubeconfig:')} ${InfraStateManager.formatProjectPath(cluster.kubeconfig)}`
        );
      } else if (!cluster.context) {
        console.log(`    ${chalk.yellow('not provisioned')}`);
      }
    }
  }

  if (status.dns?.enabled) {
    console.log(`\n${chalk.bold('DNS:')}`);
    console.log(`  ${chalk.bold('Zone:')} ${status.dns.zoneName}`);
    console.log(`  ${chalk.bold('Zone ID:')} ${status.dns.zoneId}`);
    if (status.dns.nameservers?.length > 0) {
      console.log(`  ${chalk.bold('Nameservers:')}`);
      status.dns.nameservers.forEach(ns => console.log(`    ${ns}`));
    }
  }

  if (status.provisioned) {
    const envSh = InfraStateManager.formatProjectPath(status.envShPath);
    console.log(`\n${chalk.bold('Env:')} source ${envSh}`);
  }
}

const cloud = infra.command('cloud').description('Manage cloud infrastructure (EKS, GKE, AKS)');

cloud
  .command('list')
  .description('List available infra profiles')
  .action(async () => {
    try {
      const profiles = await InfraManager.list();

      if (profiles.length === 0) {
        Logger.info('No infra profiles found in config/infra/');
        return;
      }

      console.log('\nAvailable infra profiles:');
      for (const p of profiles) {
        const status = p.provisioned ? chalk.green('provisioned') : chalk.gray('not provisioned');
        console.log(
          `  ${chalk.cyan(p.name.padEnd(18))} ${p.provider.padEnd(10)} ${String(p.clusterCount).padEnd(3)} cluster${p.clusterCount === 1 ? ' ' : 's'}  [${status}]`
        );
        if (p.description) {
          console.log(`  ${' '.repeat(18)} ${chalk.gray(p.description)}`);
        }
      }
      console.log('');
    } catch (error) {
      Logger.error(`Failed to list infra profiles: ${error.message}`);
      process.exit(1);
    }
  });

cloud
  .command('provision')
  .description('Provision infrastructure from an infra profile')
  .option('-p, --profile <name>', 'Infra profile name')
  .option('-y, --yes', 'Auto-approve provisioning without prompts')
  .action(async options => {
    try {
      let infraName = options.profile;

      if (!infraName) {
        const profiles = await InfraManager.list();
        if (profiles.length === 0) {
          Logger.error('No infra profiles found in config/infra/');
          process.exit(1);
        }
        const choices = profiles.map(p => ({
          name: `${p.name} (${p.infraName ? `name: ${p.infraName}, ` : ''}cloud: ${p.provider}, clusters: ${p.clusterCount})`,
          value: p.name,
        }));
        infraName = await Prompts.select('Select an infra profile:', choices);
      }

      const manager = new InfraManager(infraName);
      await manager.provision({ autoApprove: options.yes });
      Logger.success(`Infrastructure provisioned for: ${infraName}`);
    } catch (error) {
      Logger.error(`Failed to provision infrastructure: ${error.message}`);
      process.exit(1);
    }
  });

cloud
  .command('destroy')
  .description('Destroy provisioned infrastructure')
  .option('-p, --profile <name>', 'Infra profile name')
  .option('-y, --yes', 'Auto-approve destruction without prompts')
  .action(async options => {
    try {
      let infraName = options.profile;

      if (!infraName) {
        const profiles = await InfraManager.list();
        const provisioned = profiles.filter(p => p.needsCleanup);
        if (provisioned.length === 0) {
          Logger.info('No provisioned infrastructure found');
          return;
        }
        const choices = provisioned.map(p => ({
          name: `${p.name} (${p.infraName ? `name: ${p.infraName}, ` : ''}cloud: ${p.provider}, clusters: ${p.clusterCount})`,
          value: p.name,
        }));
        infraName = await Prompts.select('Select infrastructure to destroy:', choices);
      }

      if (!options.yes) {
        const confirmed = await Prompts.confirm(
          chalk.yellow('This will destroy all infrastructure. Are you sure?'),
          false
        );
        if (!confirmed) {
          Logger.info('Destroy cancelled');
          return;
        }
      }

      const manager = new InfraManager(infraName);
      await manager.destroy({ autoApprove: true });
      Logger.success(`Infrastructure destroyed for: ${infraName}`);
    } catch (error) {
      Logger.error(`Failed to destroy infrastructure: ${error.message}`);
      process.exit(1);
    }
  });

cloud
  .command('status')
  .description(
    'Show cloud infrastructure provisioning status (matches active kubectl context when possible)'
  )
  .option('-p, --profile <name>', 'Infra profile name')
  .action(async options => {
    try {
      const { targets, kubeContext, matchedByContext } =
        await InfraStateManager.resolveInfraStatusTargets(options.profile);

      if (targets.length === 0) {
        Logger.info('No cloud infrastructure state found');
        Logger.info('Provision with: agentic base infra cloud provision');
        Logger.info('List profiles with: agentic base infra cloud list');
        return;
      }

      for (let i = 0; i < targets.length; i++) {
        const manager = new InfraManager(targets[i]);
        const status = await manager.status();
        printCloudInfraStatus(status, {
          kubeContext,
          matchedByContext: matchedByContext && targets.length === 1,
        });
        if (i < targets.length - 1) {
          console.log(chalk.gray('─'.repeat(60)));
        }
      }

      console.log('');
    } catch (error) {
      Logger.error(`Failed to get status: ${error.message}`);
      process.exit(1);
    }
  });

cloud
  .command('env')
  .description('Print path to env.sh or its contents')
  .option('-p, --profile <name>', 'Infra profile name')
  .option('--print', 'Print env.sh contents to stdout instead of the path')
  .action(async options => {
    try {
      let infraName = options.profile;

      if (!infraName) {
        const profiles = await InfraManager.list();
        const provisioned = profiles.filter(p => p.provisioned);
        if (provisioned.length === 0) {
          Logger.error('No provisioned infrastructure found');
          process.exit(1);
        }
        const choices = provisioned.map(p => ({ name: p.name, value: p.name }));
        infraName = await Prompts.select('Select infrastructure:', choices);
      }

      const envShPath = InfraStateManager.getEnvShPath(infraName);
      const { existsSync } = await import('fs');

      if (!existsSync(envShPath)) {
        Logger.error(
          `No env.sh found for '${infraName}'. Run 'agentic base infra cloud provision -p ${infraName}' first.`
        );
        process.exit(1);
      }

      if (options.print) {
        const { readFile } = await import('fs/promises');
        const content = await readFile(envShPath, 'utf8');
        process.stdout.write(content);
      } else {
        process.stdout.write(envShPath + '\n');
      }
    } catch (error) {
      Logger.error(`Failed to get env: ${error.message}`);
      process.exit(1);
    }
  });

// ============================================
// Install command (mesh installation)
// ============================================
base
  .command('install')
  .description('Install Istio Ambient mesh on clusters')
  .option('--profile <name>', 'Installation profile (from config/profiles/)')
  .option('--infra <name>', 'Infra profile name (resolves cluster contexts from provisioned state)')
  .option('--context <contexts...>', 'Explicit kube context(s) for pre-existing clusters')
  .action(async options => {
    try {
      let profileName = options.profile;
      if (!profileName) {
        const profiles = await ProfileManager.list();
        if (profiles.length === 0) {
          Logger.error('No installation profiles found in config/profiles/');
          process.exit(1);
        }
        const choices = profiles.map(p => ({
          name: p.name,
          short: p.name,
          description: p.description.trim() || null,
          value: p.name,
        }));
        profileName = await Prompts.select('Select installation profile:', choices);
      }

      let clusters = [];
      let resolvedInfra = options.infra;

      // If no explicit infra/context, check if the profile declares an infra binding
      if (!resolvedInfra && !options.context) {
        const profile = await ProfileManager.load(profileName);
        const profileInfra = ProfileSchema.getInfra(profile);

        if (profileInfra) {
          resolvedInfra = profileInfra;
          Logger.info(`Using infra '${resolvedInfra}' from profile '${profileName}'`);
        }
      }

      // Still nothing — fall back to auto-detecting from provisioned state
      if (!resolvedInfra && !options.context) {
        const provisioned = (await InfraStateManager.listInfraProfiles()).filter(
          p => p.provisioned
        );

        if (provisioned.length === 1) {
          resolvedInfra = provisioned[0].name;
          Logger.info(`Auto-detected provisioned infra: ${resolvedInfra}`);
        } else if (provisioned.length > 1) {
          const choices = provisioned.map(p => ({
            name: `${p.name} (${p.infraName ? `name: ${p.infraName}, ` : ''}cloud: ${p.provider}, clusters: ${p.clusterCount})`,
            value: p.name,
          }));
          resolvedInfra = await Prompts.select(
            'Multiple provisioned infra profiles found. Select one:',
            choices
          );
        } else {
          Logger.error(
            'No provisioned infrastructure found.\n' +
              '  Either provision first:  make infra-provision PROFILE=<name>\n' +
              '  Or directly:             agentic base infra cloud provision -p <name>\n' +
              '  Or specify explicitly:   make install-agentic INFRA=<name>  or  KUBE_CONTEXT=<ctx>'
          );
          process.exit(1);
        }
      }

      let infraProvisionedAt = null;
      if (resolvedInfra) {
        const infraState = await InfraStateManager.load(resolvedInfra);
        if (!infraState?.status?.provisioned) {
          Logger.error(
            `Infra '${resolvedInfra}' is not provisioned. Run 'agentic base infra cloud provision -p ${resolvedInfra}' first.`
          );
          process.exit(1);
        }
        infraProvisionedAt = infraState.status.provisionedAt || null;

        const infraManager = new InfraManager(resolvedInfra);
        const infraProfile = await infraManager.loadInfraProfile();
        const infraClusters = infraProfile.spec?.clusters || [];

        const extraKubeconfigs = [];
        for (const ic of infraClusters) {
          const context = InfraStateManager.resolveContextForCluster(infraState, ic.name);
          if (!context) {
            Logger.error(`Could not resolve context for cluster '${ic.name}' from infra state`);
            process.exit(1);
          }
          const clusterState = infraState.status.clusters.find(c => c.name === ic.name);
          if (clusterState?.kubeconfig) {
            extraKubeconfigs.push(clusterState.kubeconfig);
          }
          clusters.push({
            name: ic.name,
            context,
            role: ic.role || null,
          });
        }

        if (extraKubeconfigs.length > 0) {
          const existing = process.env.KUBECONFIG || '';
          const merged = [
            ...new Set([...existing.split(':').filter(Boolean), ...extraKubeconfigs]),
          ].join(':');
          process.env.KUBECONFIG = merged;
        }
      } else if (options.context) {
        for (const ctx of options.context) {
          clusters.push({
            name: ctx,
            context: ctx,
            role: null,
          });
        }
      }

      if (clusters.length === 0) {
        Logger.error('No clusters resolved');
        process.exit(1);
      }

      await InstallerManager.installAll({
        profileName,
        clusters,
      });

      if (resolvedInfra) {
        await ProfileStateManager.setProfileName(resolvedInfra, profileName, infraProvisionedAt);
      }
    } catch (error) {
      Logger.error(`Failed to install: ${error.message}`);
      process.exit(1);
    }
  });

base
  .command('clean-addons')
  .description('Clean up all profile-based addons')
  .action(async () => {
    try {
      const confirmed = await Prompts.confirm(
        chalk.yellow('This will uninstall all addons. Are you sure?'),
        false
      );
      if (!confirmed) {
        Logger.info('Aborted');
        return;
      }

      const addonNames = ['cilium', 'solo-ui', 'keycloak', 'external-dns', 'cert-manager'];
      Logger.info('Cleaning up all addons...');
      for (const name of addonNames) {
        if (FeatureManager.has(name)) {
          try {
            await FeatureManager.cleanup(name);
          } catch (err) {
            Logger.warn(`Failed to clean up addon '${name}': ${err.message}`);
          }
        }
      }
      Logger.success('All addons cleaned up');
    } catch (error) {
      Logger.error('Failed to clean addons');
      if (error.message) Logger.error(error.message);
      process.exit(1);
    }
  });

base
  .command('clean')
  .description('Uninstall Istio Ambient from cluster(s)')
  .option('--profile <name>', 'Installation profile (from config/profiles/)')
  .option('--infra <name>', 'Infra profile name (resolves cluster contexts from provisioned state)')
  .option('--context <contexts...>', 'Explicit kube context(s) for pre-existing clusters')
  .option('-a, --addons', 'Also clean up all profile-based addons')
  .action(async options => {
    try {
      let profileName = options.profile;
      let clusters = [];
      let resolvedInfra = options.infra;

      if (!resolvedInfra && !options.context) {
        if (profileName) {
          const profile = await ProfileManager.load(profileName);
          const profileInfra = ProfileSchema.getInfra(profile);
          if (profileInfra) {
            resolvedInfra = profileInfra;
          }
        }
      }

      if (!resolvedInfra && !options.context) {
        const provisioned = (await InfraStateManager.listInfraProfiles()).filter(
          p => p.provisioned
        );

        if (provisioned.length === 1) {
          resolvedInfra = provisioned[0].name;
          Logger.info(`Auto-detected provisioned infra: ${resolvedInfra}`);
        } else if (provisioned.length > 1) {
          const choices = provisioned.map(p => ({
            name: `${p.name} (${p.infraName ? `name: ${p.infraName}, ` : ''}cloud: ${p.provider}, clusters: ${p.clusterCount})`,
            value: p.name,
          }));
          resolvedInfra = await Prompts.select('Select infra to clean up:', choices);
        } else {
          Logger.error('No provisioned infrastructure found. Use --context to specify cluster(s).');
          process.exit(1);
        }
      }

      if (resolvedInfra) {
        const infraState = await InfraStateManager.load(resolvedInfra);
        if (!infraState?.status?.provisioned) {
          Logger.error(`Infra '${resolvedInfra}' is not provisioned.`);
          process.exit(1);
        }

        const infraManager = new InfraManager(resolvedInfra);
        const infraProfile = await infraManager.loadInfraProfile();
        const infraClusters = infraProfile.spec?.clusters || [];

        const extraKubeconfigs = [];
        for (const ic of infraClusters) {
          const context = InfraStateManager.resolveContextForCluster(infraState, ic.name);
          if (!context) {
            Logger.error(`Could not resolve context for cluster '${ic.name}' from infra state`);
            process.exit(1);
          }
          const clusterState = infraState.status.clusters.find(c => c.name === ic.name);
          if (clusterState?.kubeconfig) {
            extraKubeconfigs.push(clusterState.kubeconfig);
          }
          clusters.push({
            name: ic.name,
            context,
            role: ic.role || null,
          });
        }

        if (extraKubeconfigs.length > 0) {
          const existing = process.env.KUBECONFIG || '';
          const merged = [
            ...new Set([...existing.split(':').filter(Boolean), ...extraKubeconfigs]),
          ].join(':');
          process.env.KUBECONFIG = merged;
        }

        if (!profileName) {
          // First try: read profile recorded at install time
          const savedProfile = await ProfileStateManager.getProfileName(
            resolvedInfra,
            infraState.status.provisionedAt || null
          );
          if (savedProfile) {
            profileName = savedProfile;
            Logger.info(`Auto-detected profile: ${profileName}`);
          } else {
            // Fallback: match by infra binding in profile YAML
            const allProfiles = await ProfileManager.list();
            const matches = allProfiles.filter(p => p.infra === resolvedInfra);
            if (matches.length === 1) {
              profileName = matches[0].name;
              Logger.info(`Auto-detected profile: ${profileName}`);
            } else if (matches.length > 1) {
              const choices = matches.map(p => ({ name: p.name, value: p.name }));
              profileName = await Prompts.select(
                `Multiple profiles found for infra '${resolvedInfra}'. Select one:`,
                choices
              );
            }
          }
        }
      } else if (options.context) {
        for (const ctx of options.context) {
          clusters.push({ name: ctx, context: ctx, role: null });
        }
      }

      if (clusters.length === 0) {
        Logger.error('No clusters resolved');
        process.exit(1);
      }

      await InstallerManager.uninstallAll({
        profileName,
        clusters,
        uninstallAddons: !!options.addons,
      });
    } catch (error) {
      Logger.error(`Failed to clean: ${error.message}`);
      process.exit(1);
    }
  });

base
  .command('verify')
  .description('Verify Istio Ambient installation')
  .option('-c, --context <context>', 'Kubernetes context')
  .action(async options => {
    try {
      const allPassed = await InstallerManager.verify(options.context);
      if (!allPassed) {
        process.exit(1);
      }
    } catch (error) {
      Logger.error(`Verification failed: ${error.message}`);
      process.exit(1);
    }
  });

// ============================================
// Application commands
// ============================================
const app = program.command('app').description('Manage applications');

app
  .command('deploy')
  .description('Deploy an application')
  .option('-n, --name <name>', 'Application name')
  .option('--namespace <namespace>', 'Namespace override')
  .option('--no-prompt', 'Skip interactive prompts')
  .action(async options => {
    try {
      let appName = options.name;

      if (!appName && options.prompt !== false) {
        const { readdir } = await import('fs/promises');
        const { join, dirname } = await import('path');
        const { fileURLToPath } = await import('url');

        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);
        const appsDir = join(__dirname, '..', 'extras', 'applications');

        try {
          const entries = await readdir(appsDir, { withFileTypes: true });
          const appList = entries.filter(e => e.isDirectory()).map(e => e.name);

          if (appList.length === 0) {
            Logger.error('No applications found in extras/applications/');
            process.exit(1);
          }

          const choices = appList.map(name => ({ name, value: name }));
          appName = await Prompts.select('Select an application:', choices);
          Logger.info(`Selected application: ${appName}`);
        } catch {
          Logger.error('Could not list applications');
          process.exit(1);
        }
      }

      if (!appName) {
        Logger.error('Please specify an application with --name or run without --no-prompt');
        process.exit(1);
      }

      await UseCaseManager.deployApplication(appName, options.namespace);
      Logger.success('Application deployed successfully');
    } catch (error) {
      Logger.error(`Failed to deploy application: ${error.message}`);
      process.exit(1);
    }
  });

app
  .command('list')
  .description('List available applications')
  .action(async () => {
    try {
      const { readdir } = await import('fs/promises');
      const { join, dirname } = await import('path');
      const { fileURLToPath } = await import('url');

      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const appsDir = join(__dirname, '..', 'extras', 'applications');

      const entries = await readdir(appsDir, { withFileTypes: true });
      const appList = entries.filter(e => e.isDirectory()).map(e => e.name);

      console.log('\nAvailable applications:');
      appList.forEach(name => {
        console.log(`  ${chalk.cyan('•')} ${name}`);
      });
      console.log('');
    } catch (error) {
      Logger.error(`Failed to list applications: ${error.message}`);
      process.exit(1);
    }
  });

// ============================================
// Use case commands
// ============================================
const usecase = program.command('usecase').description('Manage use cases');

usecase
  .command('list')
  .description('List available use cases')
  .action(async () => {
    try {
      const usecases = await UseCaseManager.list();

      const byCategory = {};
      usecases.forEach(u => {
        const category = u.category || 'root';
        if (!byCategory[category]) {
          byCategory[category] = [];
        }
        byCategory[category].push(u);
      });

      console.log('\nAvailable use cases:');
      Object.keys(byCategory)
        .sort()
        .forEach(category => {
          const categoryName = category === 'root' ? 'General' : category.toUpperCase();
          console.log(`\n  ${chalk.bold(categoryName)}:`);
          byCategory[category]
            .sort((a, b) => a.name.localeCompare(b.name))
            .forEach(u => {
              const name = u.category ? `${u.category}/${u.name}` : u.name;
              const deprecatedTag = u.deprecated
                ? chalk.yellow(` ${logSymbols.warning} [DEPRECATED → ${u.deprecated.replacedBy}]`)
                : '';
              console.log(`    ${chalk.cyan('•')} ${name}${deprecatedTag}`);
            });
        });
      console.log('');
    } catch (error) {
      Logger.error(`Failed to list use cases: ${error.message}`);
      process.exit(1);
    }
  });

usecase
  .command('deploy')
  .description('Deploy a use case')
  .option('-n, --name <name>', 'Use case name')
  .option('-y, --yes', 'Non-interactive: skip step-by-step prompts and run all steps automatically')
  .option('--no-diagrams', 'Hide ASCII flow diagrams during stepped deploy')
  .option('--skip-tests', 'Skip running tests after deployment')
  .action(async options => {
    try {
      let usecaseName = options.name;

      if (!usecaseName) {
        const selected = await UseCaseManager.select();
        usecaseName = selected.name;
        Logger.info(`Selected use case: ${usecaseName}`);
      }

      await UseCaseManager.deploy(usecaseName, {
        interactive: !options.yes,
        skipTests: options.skipTests,
        diagrams: options.diagrams,
      });
    } catch {
      // UseCaseManager.deploy already prints the failure via spinner.fail().
      process.exit(1);
    }
  });

usecase
  .command('clean')
  .description('Remove a deployed use case (features, apps, tracking)')
  .option('-n, --name <name>', 'Use case name')
  .option(
    '-c, --current',
    'Clean the use case tracked as currently deployed (ConfigMap agentic-feature-catalog-current-usecase)'
  )
  .action(async options => {
    try {
      if (options.current) {
        await UseCaseManager.cleanupAll();
        return;
      }

      let usecaseName = options.name;

      if (!usecaseName) {
        const selected = await UseCaseManager.select();
        usecaseName = selected.name;
        Logger.info(`Selected use case: ${usecaseName}`);
      }

      if (!usecaseName) {
        Logger.error('Specify --name <usecase> or --current for the tracked deployment');
        process.exit(1);
      }

      await UseCaseManager.cleanup(usecaseName);
    } catch (error) {
      Logger.error(`Failed to clean use case: ${error.message}`);
      process.exit(1);
    }
  });

usecase
  .command('test')
  .description('Test a deployed use case')
  .option('-n, --name <name>', 'Use case name')
  .action(async options => {
    try {
      let usecaseName = options.name;

      if (!usecaseName) {
        const selected = await UseCaseManager.select();
        usecaseName = selected.name;
        Logger.info(`Selected use case: ${usecaseName}`);
      }

      await UseCaseManager.test(usecaseName);
    } catch (error) {
      Logger.error(`Failed to test use case: ${error.message}`);
      process.exit(1);
    }
  });

// ============================================
// Profile commands
// ============================================
const profile = program.command('profile').description('Manage installation profiles');

profile
  .command('list')
  .description('List available installation profiles')
  .action(async () => {
    try {
      const profiles = await ProfileManager.list();

      if (profiles.length === 0) {
        Logger.info('No installation profiles found in config/profiles/');
        return;
      }

      console.log('\nAvailable installation profiles:');
      for (const p of profiles) {
        const version = p.istioVersion ? chalk.gray(`v${p.istioVersion}`) : '';
        const roles = p.hasRoles ? chalk.magenta('multicluster') : chalk.gray('single');
        const infraTag = p.infra ? chalk.yellow(`infra:${p.infra}`) : '';
        const validity = p.valid ? '' : chalk.red(' (invalid)');
        console.log(
          `  ${chalk.cyan(p.name.padEnd(20))} ${roles.padEnd(25)} ${version} ${infraTag}${validity}`
        );
        if (p.description) {
          console.log(`  ${' '.repeat(20)} ${chalk.gray(p.description)}`);
        }
      }
      console.log('');
    } catch (error) {
      Logger.error(`Failed to list installation profiles: ${error.message}`);
      process.exit(1);
    }
  });

profile
  .command('show')
  .description('Show details of an installation profile')
  .option('-n, --name <name>', 'Profile name')
  .action(async options => {
    try {
      let profileName = options.name;

      if (!profileName) {
        const profiles = await ProfileManager.list();
        if (profiles.length === 0) {
          Logger.info('No installation profiles found');
          return;
        }
        const choices = profiles.map(p => ({ name: p.name, value: p.name }));
        profileName = await Prompts.select('Select an installation profile:', choices);
      }

      const summary = await ProfileManager.getProfileSummary(profileName);

      console.log(`\n${chalk.bold('Profile:')} ${chalk.cyan(summary.name)}`);
      console.log(`${chalk.bold('Description:')} ${summary.description}`);
      console.log(
        `${chalk.bold('Infra:')} ${summary.infra ? chalk.cyan(summary.infra) : chalk.gray('not set (auto-detect)')}`
      );
      console.log(`${chalk.bold('Istio Version:')} ${summary.istioVersion}`);
      console.log(`${chalk.bold('Mesh Profile:')} ${summary.meshProfile}`);
      console.log(`${chalk.bold('Components:')} ${summary.components.join(', ')}`);

      if (summary.addons.length > 0) {
        const addonNames = summary.addons.map(a => (typeof a === 'string' ? a : a.name));
        console.log(`${chalk.bold('Addons:')} ${addonNames.join(', ')}`);
      }

      if (summary.hasRoles) {
        console.log(`\n${chalk.bold('Role overrides:')}`);
        for (const role of summary.roles) {
          console.log(`  ${chalk.green(role)}`);
        }
      }

      if (summary.clusterOverrides.length > 0) {
        console.log(`\n${chalk.bold('Cluster overrides:')}`);
        for (const cluster of summary.clusterOverrides) {
          console.log(`  ${chalk.yellow(cluster)}`);
        }
      }

      console.log('');
    } catch (error) {
      Logger.error(`Failed to show installation profile: ${error.message}`);
      process.exit(1);
    }
  });

// ============================================
// Runbook commands
// ============================================
const runbookCmd = new Command('runbook').description('Runbook generation commands');

runbookCmd.addCommand(
  new Command('generate')
    .description('Interactively generate a setup runbook from a profile')
    .option('--output <dir>', 'Output directory', 'docs/runbooks')
    .option('--filename <name>', 'Output filename (without file extension)')
    .addOption(
      new Option('--format <fmt>', 'Output format').choices(['md', 'html', 'both']).default('md')
    )
    .action(async options => {
      const { RunbookPicker, RunbookBuilder } = await import('./lib/runbook.js');
      const picker = new RunbookPicker();
      const selection = await picker.pick(options);
      const builder = new RunbookBuilder(selection);
      if (options.format === 'md' || options.format === 'both') {
        await builder.build();
      }
      if (options.format === 'html' || options.format === 'both') {
        await builder.buildHtml();
      }
    })
);

program.addCommand(runbookCmd);

// ============================================
// Utility commands
// ============================================
program
  .command('check-deps')
  .description('Check if required dependencies are installed')
  .action(async () => {
    const allInstalled = await checkDependencies();
    if (!allInstalled) {
      process.exit(1);
    }
  });

try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err?.name === 'ExitPromptError' || err?.constructor?.name === 'ExitPromptError') {
    process.exit(130);
  }
  throw err;
}

if (process.argv.length === 2) {
  program.help();
}

process.exit(0);
