import chalk from 'chalk';
import { execa } from 'execa';
import { spawn } from 'child_process';
import ora from 'ora';
import logSymbols from 'log-symbols';
import stringWidth from 'string-width';

/**
 * Common utilities for Agentic Field Kit
 */

export class Logger {
  static info(message) {
    console.log(chalk.blue(logSymbols.info), message);
  }

  static success(message) {
    console.log(chalk.green(logSymbols.success), message);
  }

  static warn(message) {
    console.log(chalk.yellow(logSymbols.warning), message);
  }

  static error(message) {
    console.error(chalk.red(logSymbols.error), message);
  }

  static debug(message) {
    if (process.env.DEBUG === 'true') {
      console.log(chalk.gray(logSymbols.info), message);
    }
  }

  static logInfo(message) {
    return Logger.info(message);
  }
  static logSuccess(message) {
    return Logger.success(message);
  }
  static logWarn(message) {
    return Logger.warn(message);
  }
  static logError(message) {
    return Logger.error(message);
  }
  static logDebug(message) {
    return Logger.debug(message);
  }
}

/**
 * SpinnerLogger - Manages ora spinner with logging
 * Properly handles spinner state when logging messages
 */
export class SpinnerLogger {
  constructor(initialText = '') {
    this.spinner = ora(initialText);
    this.isSpinning = false;
  }

  start(text) {
    this.spinner.text = text;
    this.spinner.start();
    this.isSpinning = true;
    return this;
  }

  stop() {
    if (this.isSpinning) {
      this.spinner.stop();
      this.isSpinning = false;
    }
    return this;
  }

  succeed(message) {
    this.spinner.succeed(message);
    this.isSpinning = false;
    return this;
  }

  fail(message) {
    this.spinner.fail(message);
    this.isSpinning = false;
    return this;
  }

  warn(message) {
    this.spinner.warn(message);
    this.isSpinning = false;
    return this;
  }

  info(message) {
    this.spinner.info(message);
    this.isSpinning = false;
    return this;
  }

  setText(text) {
    this.spinner.text = text;
    return this;
  }

  /**
   * Safely log a message while spinner is running.
   * Stops the spinner, writes the line, then restarts with the same text.
   */
  log(message, level = 'info') {
    const wasSpinning = this.isSpinning;
    const currentText = this.spinner.text;

    if (wasSpinning) {
      this.spinner.stop();
    }

    switch (level) {
      case 'info':
        Logger.info(message);
        break;
      case 'success':
        Logger.success(message);
        break;
      case 'warn':
        Logger.warn(message);
        break;
      case 'error':
        Logger.error(message);
        break;
      case 'debug':
        Logger.debug(message);
        break;
    }

    if (wasSpinning) {
      this.spinner.text = currentText;
      this.spinner.start();
      this.isSpinning = true;
    }

    return this;
  }

  logInfo(message) {
    return this.log(message, 'info');
  }
  logSuccess(message) {
    return this.log(message, 'success');
  }
  logWarn(message) {
    return this.log(message, 'warn');
  }
  logError(message) {
    return this.log(message, 'error');
  }
  logDebug(message) {
    return this.log(message, 'debug');
  }

  clear() {
    if (this.isSpinning) {
      this.spinner.clear();
    }
    return this;
  }

  render() {
    if (this.isSpinning) {
      this.spinner.render();
    }
    return this;
  }
}

/**
 * BoxedOutput - Renders child process output inside a Unicode box frame.
 *
 * Usage:
 *   const box = new BoxedOutput('terraform init');
 *   box.open();
 *   box.writeLine('Initializing the backend...');
 *   box.close();
 */
export class BoxedOutput {
  // eslint-disable-next-line no-control-regex -- intentional: strips ANSI color escape codes
  static ANSI_RE = /\x1b\[[0-9;]*m/g;

  constructor(title = '', { indent = 2, minWidth = 60 } = {}) {
    this.title = title;
    this.indent = indent;
    this.minWidth = minWidth;
    this.lastLineCount = 0;
    this.lastWasProgress = false;
  }

  get boxWidth() {
    const cols = process.stdout.columns || 80;
    return Math.max(this.minWidth, cols - this.indent * 2);
  }

  get innerWidth() {
    return this.boxWidth - 4;
  }

  static stripAnsi(str) {
    return str.replace(BoxedOutput.ANSI_RE, '');
  }

  /**
   * Return the display column width of a Unicode code point.
   * Wide chars (CJK, emoji symbols) = 2. Zero-width (variation selectors, ZWJ) = 0. Rest = 1.
   */
  static charWidth(cp) {
    // Zero-width: variation selectors, ZWJ, combining enclosing keycap
    if (cp === 0xfe0f || cp === 0x200d || cp === 0x20e3 || (cp >= 0xfe00 && cp <= 0xfe0e)) return 0;
    // Wide: CJK and East-Asian blocks
    if (
      (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
      (cp >= 0x2e80 && cp <= 0x303e) || // CJK Radicals / Kangxi
      (cp >= 0x3040 && cp <= 0xa4cf) || // Kana, Bopomofo, CJK Unified, Yi
      (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f000 && cp <= 0x1ffff) || // Supplementary emoji (🀀-🿿)
      (cp >= 0x2300 && cp <= 0x23ff) || // Misc Technical (⏰ etc.)
      (cp >= 0x2600 && cp <= 0x27bf) || // Misc Symbols + Dingbats (✅ ⚠ ❌ ★ etc.)
      (cp >= 0x20000 && cp <= 0x2fffd) ||
      (cp >= 0x30000 && cp <= 0x3fffd)
    )
      return 2;
    return 1;
  }

  static visibleLength(str) {
    const stripped = BoxedOutput.stripAnsi(str);
    let width = 0;
    let prevCharWidth = 0;
    for (const char of stripped) {
      const cp = char.codePointAt(0);
      if (cp === 0xfe0f) {
        // Variation selector-16: upgrades previous 1-wide char to emoji (2-wide)
        if (prevCharWidth === 1) width += 1;
        prevCharWidth = 0;
      } else {
        const w = BoxedOutput.charWidth(cp);
        width += w;
        prevCharWidth = w;
      }
    }
    return width;
  }

  pad() {
    return ' '.repeat(this.indent);
  }

  open() {
    const w = this.boxWidth;
    const border = chalk.gray;
    let top;
    if (this.title) {
      const label = ` ${this.title} `;
      const remaining = Math.max(0, w - 2 - label.length - 1);
      top = border('┌─') + chalk.bold(label) + border('─'.repeat(remaining) + '┐');
    } else {
      top = border('┌' + '─'.repeat(w - 2) + '┐');
    }
    console.log('');
    console.log(this.pad() + top);
  }

  formatBoxLine(line) {
    const border = chalk.gray;
    const prefix = this.pad() + border('│') + ' ';
    const suffix = ' ' + border('│');
    const maxW = this.innerWidth;
    const visible = BoxedOutput.visibleLength(line);
    const padding = Math.max(0, maxW - visible);
    return prefix + line + ' '.repeat(padding) + suffix;
  }

  writeLine(rawLine) {
    const maxW = this.innerWidth;
    const lines = this.wrapLine(rawLine.replace(/\r/g, ''), maxW);
    for (const line of lines) {
      process.stdout.write(this.formatBoxLine(line) + '\n');
    }
    this.lastLineCount = lines.length;
    this.lastWasProgress = false;
  }

  writeProgress(rawLine) {
    const maxW = this.innerWidth;
    const lines = this.wrapLine(rawLine, maxW);
    const output = lines.map(l => this.formatBoxLine(l)).join('\n');

    if (this.lastWasProgress && this.lastLineCount > 0) {
      process.stdout.write(`\x1b[${this.lastLineCount}A\x1b[0J`);
    }

    process.stdout.write(output + '\n');
    this.lastLineCount = lines.length;
    this.lastWasProgress = true;
  }

  wrapLine(line, maxW) {
    const stripped = BoxedOutput.stripAnsi(line);
    if (stripped.length <= maxW) {
      return [line];
    }

    const results = [];
    let remaining = line;

    while (BoxedOutput.visibleLength(remaining) > maxW) {
      const target = results.length === 0 ? maxW : maxW - 2;
      let cutAt = this.findWrapPoint(remaining, target);
      const segment = remaining.slice(0, cutAt);
      remaining = remaining.slice(cutAt);

      if (remaining.length > 0 && remaining[0] === ' ') {
        remaining = remaining.slice(1);
      }

      results.push(segment);
      if (remaining.length > 0) {
        remaining = '  ' + remaining;
      }
    }

    if (remaining.length > 0) {
      results.push(remaining);
    }

    return results;
  }

  findWrapPoint(str, targetVisible) {
    let visible = 0;
    let inEscape = false;
    let lastSpace = -1;
    let lastSpaceVisible = -1;
    let prevCharWidth = 0;
    let byteIdx = 0;

    for (const char of str) {
      const cp = char.codePointAt(0);
      const byteLen = char.length; // 2 for surrogate pairs, 1 otherwise

      if (char === '\x1b') {
        inEscape = true;
        byteIdx += byteLen;
        continue;
      }
      if (inEscape) {
        if (char === 'm') inEscape = false;
        byteIdx += byteLen;
        continue;
      }

      let w;
      if (cp === 0xfe0f) {
        // Variation selector-16: upgrades previous 1-wide char to emoji (2-wide)
        w = prevCharWidth === 1 ? 1 : 0;
        prevCharWidth = 0;
      } else {
        w = BoxedOutput.charWidth(cp);
        prevCharWidth = w;
      }

      if (char === ' ') {
        lastSpace = byteIdx;
        lastSpaceVisible = visible;
      }

      visible += w;
      byteIdx += byteLen;

      if (visible >= targetVisible) {
        if (lastSpace > 0 && lastSpaceVisible >= targetVisible * 0.2) {
          return lastSpace;
        }
        return byteIdx;
      }
    }
    return str.length;
  }

  close() {
    const w = this.boxWidth;
    const border = chalk.gray;
    console.log(this.pad() + border('└' + '─'.repeat(w - 2) + '┘'));
    console.log('');
  }
}

/** Known error patterns that map to actionable hints. */
const ERROR_HINTS = [
  {
    pattern:
      /Token has expired and refresh failed|executable aws failed with exit code 255|getting credentials: exec:/i,
    hint: 'AWS credentials expired — run: aws sso login',
  },
  {
    pattern: /Unable to locate credentials|NoCredentialProviders|no EC2 IMDS role found/i,
    hint: 'AWS credentials not configured — run: aws configure or aws sso login',
  },
  {
    pattern: /x509: certificate signed by unknown authority/i,
    hint: 'TLS certificate error — cluster CA may not be trusted',
  },
  {
    pattern: /Unable to connect to the server.*dial tcp/i,
    hint: 'Cannot reach Kubernetes API server — check kubeconfig context and VPN',
  },
];

function enrichError(error) {
  const text = [error.message, error.stderr, error.stdout].filter(Boolean).join('\n');
  for (const { pattern, hint } of ERROR_HINTS) {
    if (pattern.test(text)) {
      const enriched = new Error(hint);
      enriched.cause = error;
      return enriched;
    }
  }
  return error;
}

export class CommandRunner {
  static async run(command, args = [], options = {}) {
    const { verbose = false, cwd = process.cwd() } = options;

    if (verbose) {
      Logger.debug(`Running: ${command} ${args.join(' ')}`);
    }

    try {
      const result = await execa(command, args, {
        cwd,
        ...options,
      });
      return result;
    } catch (error) {
      if (!options.ignoreError) {
        throw enrichError(error);
      }
      return error;
    }
  }

  static async exec(command, options = {}) {
    return this.run('bash', ['-c', command], options);
  }

  /**
   * Execute a command and stream each output line to a handler function.
   * Both stdout and stderr are interleaved and delivered line-by-line.
   * Uses native child_process.spawn to avoid library-specific buffering.
   * Forwards SIGINT/SIGTERM to the child so Ctrl+C works.
   */
  static async execStream(command, lineHandler, options = {}) {
    const { cwd = process.cwd(), env, ignoreError = false } = options;

    return new Promise((resolve, reject) => {
      const child = spawn('bash', ['-c', command], {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const onSigInt = () => {
        child.kill('SIGINT');
        setTimeout(() => process.exit(130), 500);
      };
      const onSigTerm = () => {
        child.kill('SIGTERM');
        setTimeout(() => process.exit(143), 500);
      };
      process.on('SIGINT', onSigInt);
      process.on('SIGTERM', onSigTerm);

      const pipeLines = stream => {
        let buffer = '';
        stream.on('data', chunk => {
          try {
            buffer += chunk.toString();
            let idx;
            while ((idx = buffer.search(/[\n\r]/)) !== -1) {
              const line = buffer.slice(0, idx);
              const sep = buffer[idx];
              buffer = buffer.slice(idx + 1);
              if (sep === '\r' && buffer[0] === '\n') buffer = buffer.slice(1);
              if (line.length > 0) lineHandler(line);
            }
          } catch (err) {
            Logger.error(`Stream handler error: ${err.message}`);
          }
        });
        stream.on('end', () => {
          try {
            if (buffer.length > 0) {
              lineHandler(buffer);
              buffer = '';
            }
          } catch (err) {
            Logger.error(`Stream end handler error: ${err.message}`);
          }
        });
      };

      pipeLines(child.stdout);
      pipeLines(child.stderr);

      child.on('error', err => {
        process.removeListener('SIGINT', onSigInt);
        process.removeListener('SIGTERM', onSigTerm);
        if (!ignoreError) reject(err);
        else resolve({ exitCode: 1 });
      });

      child.on('close', code => {
        process.removeListener('SIGINT', onSigInt);
        process.removeListener('SIGTERM', onSigTerm);
        if (code !== 0 && !ignoreError) {
          reject(new Error(`Command failed with exit code ${code}: ${command}`));
        } else {
          resolve({ exitCode: code });
        }
      });
    });
  }
}

export class KubernetesHelper {
  static async kubectl(args, options = {}) {
    return CommandRunner.run('kubectl', args, options);
  }

  static async helm(args, options = {}) {
    return CommandRunner.run('helm', args, options);
  }

  /**
   * Assert that a Helm release is in 'deployed' state.
   * Throws if the release exists but is in a non-deployed state (e.g. 'failed').
   * Silently passes if the release status cannot be determined.
   */
  static async assertHelmDeployed(releaseName, namespace, context = null) {
    const ctxFlag = context ? `--kube-context=${context}` : '';
    const result = await CommandRunner.exec(
      `helm ${ctxFlag} status ${releaseName} --namespace ${namespace} -o json`,
      { ignoreError: true }
    );
    try {
      const info = JSON.parse(result.stdout || '{}');
      const status = info.info?.status;
      if (status && status !== 'deployed') {
        throw new Error(`Helm release '${releaseName}' is in '${status}' state after install`);
      }
    } catch (err) {
      if (err.message.includes('is in')) throw err;
      // JSON parse failed or release not found — cannot verify, skip
    }
  }

  static async waitForPod(namespace, labelSelector, timeout = 300, externalSpinner = null) {
    const spinner = externalSpinner || new SpinnerLogger();
    const ownSpinner = !externalSpinner;

    if (ownSpinner) {
      spinner.start('Waiting for pod to be ready...');
    } else {
      spinner.setText('Waiting for pod to be ready...');
    }

    try {
      await this.kubectl(
        [
          'wait',
          '--for=condition=ready',
          'pod',
          '-l',
          labelSelector,
          '-n',
          namespace,
          `--timeout=${timeout}s`,
        ],
        { spinner }
      );

      if (ownSpinner) {
        spinner.succeed('Pod is ready');
      }
      return true;
    } catch (error) {
      if (ownSpinner) {
        spinner.fail('Pod failed to become ready');
      }
      throw error;
    }
  }

  static async waitForDeployment(
    namespace,
    deploymentName,
    timeout = 300,
    externalSpinner = null,
    context = null
  ) {
    const spinner = externalSpinner || new SpinnerLogger();
    const ownSpinner = !externalSpinner;
    const ctxArgs = context ? [`--context=${context}`] : [];

    const startTime = Date.now();
    const timeoutMs = timeout * 1000;

    if (ownSpinner) {
      spinner.start('Waiting for deployment to be created...');
    } else {
      spinner.setText('Waiting for deployment to be created...');
    }

    while (Date.now() - startTime < timeoutMs) {
      try {
        const result = await this.kubectl(
          [...ctxArgs, 'get', 'deployment', deploymentName, '-n', namespace],
          {
            ignoreError: true,
            spinner,
          }
        );

        if (result.exitCode === 0) {
          break;
        }
      } catch {
        // Deployment doesn't exist yet, continue waiting
      }

      await new Promise(resolve => setTimeout(resolve, 2000));

      if (Date.now() - startTime >= timeoutMs) {
        if (ownSpinner) {
          spinner.fail(`Timeout waiting for deployment ${deploymentName} to be created`);
        }
        throw new Error(`Deployment ${deploymentName} was not created within ${timeout}s`);
      }
    }

    spinner.setText('Waiting for deployment to be ready...');

    try {
      const remainingTimeout = Math.max(
        10,
        Math.floor((timeoutMs - (Date.now() - startTime)) / 1000)
      );

      await this.kubectl(
        [
          ...ctxArgs,
          'wait',
          '--for=condition=available',
          `deployment/${deploymentName}`,
          '-n',
          namespace,
          `--timeout=${remainingTimeout}s`,
        ],
        { spinner }
      );

      if (ownSpinner) {
        spinner.succeed('Deployment is ready');
      }
      return true;
    } catch (error) {
      if (ownSpinner) {
        spinner.fail('Deployment failed to become ready');
      }
      throw error;
    }
  }

  static async ensureNamespace(namespace, spinner = null, context = null) {
    const ctxArgs = context ? [`--context=${context}`] : [];
    const result = await this.kubectl([...ctxArgs, 'get', 'namespace', namespace], {
      ignoreError: true,
    });
    const exists = result.exitCode === 0;
    if (exists) {
      if (!spinner) {
        Logger.info(`Namespace ${namespace} already exists`);
      }
      return;
    }
    if (!spinner) {
      Logger.info(`Creating namespace ${namespace}...`);
    }
    await this.kubectl([...ctxArgs, 'create', 'namespace', namespace]);
    if (!spinner) {
      Logger.success(`Namespace ${namespace} created`);
    }
  }

  static async resourceExists(resourceType, name, namespace = null) {
    try {
      const args = ['get', resourceType, name];
      if (namespace) {
        args.push('-n', namespace);
      }
      args.push('--ignore-not-found=true', '-o', 'name');

      const result = await this.kubectl(args, { ignoreError: true });
      return result.stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  static async applyYaml(yamlContent, _spinner = null) {
    await this.kubectl(['apply', '-f', '-'], {
      input: yamlContent,
    });
  }

  static async deleteIfExists(resourceType, resourceName, namespace) {
    try {
      await this.kubectl(['get', resourceType, resourceName, '-n', namespace], {
        ignoreError: true,
      });
      await this.kubectl(['delete', resourceType, resourceName, '-n', namespace, '--wait=false']);
    } catch {
      // Silently ignore - resource doesn't exist
    }
  }

  static async getLoadBalancerAddress(namespace, serviceName, timeout = 300) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout * 1000) {
      try {
        const result = await this.kubectl(
          [
            'get',
            'svc',
            serviceName,
            '-n',
            namespace,
            '-o',
            'jsonpath={.status.loadBalancer.ingress[0].ip}{.status.loadBalancer.ingress[0].hostname}',
          ],
          { ignoreError: true }
        );

        const address = result.stdout.trim();
        if (address) {
          return address;
        }
      } catch {
        // Continue waiting
      }

      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    throw new Error('Timeout waiting for LoadBalancer address');
  }

  /**
   * Check whether the current (or given) kube context can reach the API server.
   * Bounds both kubectl's own request and the child process itself, so an unreachable
   * API server (dead VPN, stale kubeconfig, dropped packets) fails fast instead of hanging
   * indefinitely with no output.
   */
  static async isClusterAccessible(contextFlag = '') {
    const args = contextFlag
      ? [contextFlag, 'cluster-info', '--request-timeout=10s']
      : ['cluster-info', '--request-timeout=10s'];
    const spinner = new SpinnerLogger().start('Checking cluster accessibility...');
    const result = await this.kubectl(args, { ignoreError: true, timeout: 15000 });
    const accessible = result?.exitCode === 0;
    if (accessible) {
      spinner.stop();
    } else {
      spinner.fail('Cluster is not accessible');
    }
    return accessible;
  }

  /**
   * Label namespace for Istio Ambient mode
   */
  static async labelNamespaceForAmbient(namespace, context = null, { quiet = false } = {}) {
    const contextFlag = context ? ['--context', context] : [];
    try {
      await this.kubectl([
        ...contextFlag,
        'label',
        'namespace',
        namespace,
        'istio.io/dataplane-mode=ambient',
        '--overwrite',
      ]);
      if (!quiet) {
        Logger.info(`Namespace '${namespace}' labeled for Ambient mode`);
      }
    } catch (error) {
      if (!quiet) {
        Logger.warn(`Warning: Could not label namespace ${namespace}: ${error.message}`);
      }
    }
  }
}

export async function checkDependencies() {
  const required = ['kubectl', 'helm', 'terraform'];
  const missing = [];

  Logger.info('Checking dependencies...');

  for (const cmd of required) {
    try {
      await CommandRunner.run('command', ['-v', cmd], { ignoreError: true });
      console.log(chalk.green('✓'), cmd);
    } catch {
      console.log(chalk.yellow('✗'), cmd, chalk.gray('(missing)'));
      missing.push(cmd);
    }
  }

  if (missing.length > 0) {
    Logger.warn(`Missing dependencies: ${missing.join(', ')}`);
    Logger.info('Some features may not work without these dependencies.');
    return false;
  }

  Logger.success('All dependencies are installed');
  return true;
}

export function waitFor(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Build the AWS Load Balancer Controller annotation set for a public-facing NLB.
 * Always pins the scheme to internet-facing — AWS LBC's own default is `internal`
 * (private VPC IPs only), silently unreachable from outside the VPC; confirmed live
 * more than once as the cause of a "stuck"/timed-out install with no clear error.
 * Additionally gates the listener to a fixed CIDR allowlist (e.g. a VPN egress range)
 * when sourceRanges is non-empty.
 *
 * Two non-obvious AWS LBC gotchas, both confirmed live (source-ranges silently had no
 * effect, NLB stayed open to 0.0.0.0/0, until both were fixed):
 *  - The CIDR-allowlist key is `load-balancer-source-ranges` with NO `aws-` prefix —
 *    the one annotation in this whole system inherited from the generic in-tree
 *    cloud-provider convention rather than AWS LBC's own `aws-load-balancer-*` naming.
 *  - With nlb-target-type=ip, AWS disables client-IP preservation by default, and
 *    source-ranges is documented to be ignored entirely when that's disabled — so it
 *    must be turned back on via target-group-attributes.
 *
 * sourceRanges may contain a mix of plain CIDR strings and nested arrays — profile YAML
 * combines a whole-list template token (e.g. {{env.security.vpnSourceRanges}}, which
 * resolves to a raw array) with individual CIDR tokens in the same list; .flat() collapses
 * that one level before joining.
 */
export function nlbSourceRangeAnnotations(sourceRanges) {
  const ranges = (Array.isArray(sourceRanges) ? sourceRanges : [sourceRanges])
    .flat()
    .filter(Boolean);
  return {
    'service.beta.kubernetes.io/aws-load-balancer-type': 'external',
    'service.beta.kubernetes.io/aws-load-balancer-nlb-target-type': 'ip',
    'service.beta.kubernetes.io/aws-load-balancer-scheme': 'internet-facing',
    'service.beta.kubernetes.io/aws-load-balancer-target-group-attributes':
      'preserve_client_ip.enabled=true',
    ...(ranges.length > 0
      ? { 'service.beta.kubernetes.io/load-balancer-source-ranges': ranges.join(',') }
      : {}),
  };
}

/**
 * Wait indefinitely for a public hostname to resolve in DNS, then verify HTTP reachability.
 *
 * Phase 1 — DNS: polls dns.lookup(hostname) every `interval` ms until an IP is returned. Uses
 * dns.lookup() (getaddrinfo, the OS resolver) rather than dns.resolve4() (a raw query against
 * /etc/resolv.conf's nameserver) so this respects the same resolution path — split-DNS overrides
 * (e.g. macOS /etc/resolver/*), /etc/hosts, nsswitch.conf — that Phase 2's HTTP request below
 * already goes through. The two phases used to disagree: Phase 1 could hang on a stale answer
 * from a caching resolver (e.g. Pi-hole) that Phase 2 would have already bypassed.
 * Phase 2 — HTTP: polls the URL (ignoring TLS cert errors) until a non-5xx response is received.
 *
 * @param {string} hostname
 * @param {object} [options]
 * @param {string}   options.protocol  - 'https' (default) or 'http'
 * @param {string}   options.path      - URL path to probe (default: '/')
 * @param {number}   options.interval  - polling interval in ms (default: 10000)
 * @param {object}   options.spinner   - SpinnerLogger instance for status text updates
 * @param {Function} options.log       - log(message, level) function; falls back to Logger
 */
export async function waitForPublicUrl(
  hostname,
  {
    protocol = 'https',
    path = '/',
    interval = 10_000,
    spinner = null,
    log = null,
    requireTrustedTls = true,
  } = {}
) {
  const { promises: dns } = await import('dns');
  const lib = await import(protocol === 'https' ? 'https' : 'http');

  const logger = log || ((msg, level = 'info') => Logger[level]?.(msg) ?? Logger.info(msg));
  const startTime = Date.now();

  const elapsed = () => {
    const s = Math.floor((Date.now() - startTime) / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
  };

  // ── Phase 1: DNS resolution ────────────────────────────────────────────────
  logger(`Waiting for DNS to resolve: ${hostname}`, 'info');
  while (true) {
    try {
      const { address } = await dns.lookup(hostname, { family: 4 });
      logger(`DNS resolved: ${hostname} → ${address} (${elapsed()})`, 'success');
      break;
    } catch {
      // ENOTFOUND or similar — record not propagated yet
    }
    if (spinner) spinner.setText(`Waiting for DNS: ${hostname} (${elapsed()})`);
    await waitFor(interval);
  }

  // ── Phase 2: HTTP reachability (TLS-insecure — waits for service to be up) ──
  const url = `${protocol}://${hostname}${path}`;
  logger(`Waiting for URL to be reachable: ${url}`, 'info');
  const port = protocol === 'https' ? 443 : 80;

  while (true) {
    const { reachable, reason } = await new Promise(resolve => {
      const req = lib.request(
        { hostname, port, path, method: 'GET', rejectUnauthorized: false, timeout: 8_000 },
        res => {
          res.resume();
          resolve({ reachable: res.statusCode < 500, reason: `HTTP ${res.statusCode}` });
        }
      );
      req.on('error', err => resolve({ reachable: false, reason: err.code || err.message }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ reachable: false, reason: 'connection timed out (8s)' });
      });
      req.end();
    });

    if (reachable) break;
    if (spinner) spinner.setText(`Waiting for URL: ${url} (${elapsed()}) - ${reason}`);
    await waitFor(interval);
  }

  // ── Phase 3 (HTTPS only): TLS-verified — ensures cert is valid ────────────
  // Phase 2 uses rejectUnauthorized:false so it passes even with a dev/self-signed
  // cert (e.g. Keycloak start-dev). Downstream services (agentregistry, kagent) use
  // a strict TLS client and will get EOF if the cert is invalid. Block here until
  // the TLS handshake succeeds with a trusted cert. Skippable via requireTrustedTls
  // for callers that only need DNS + plain reachability (e.g. an insecure Admin API
  // client) and will run their own trusted-TLS wait later.
  if (protocol === 'https' && requireTrustedTls) {
    logger(`Waiting for valid TLS on: ${url}`, 'info');
    while (true) {
      const { tlsOk, reason } = await new Promise(resolve => {
        const req = lib.request(
          { hostname, port, path, method: 'GET', rejectUnauthorized: true, timeout: 8_000 },
          res => {
            res.resume();
            resolve({ tlsOk: res.statusCode < 500, reason: `HTTP ${res.statusCode}` });
          }
        );
        req.on('error', err => resolve({ tlsOk: false, reason: err.code || err.message }));
        req.on('timeout', () => {
          req.destroy();
          resolve({ tlsOk: false, reason: 'connection timed out (8s)' });
        });
        req.end();
      });

      if (tlsOk) {
        logger(`URL reachable with valid TLS: ${url} (${elapsed()})`, 'success');
        return;
      }
      if (spinner) spinner.setText(`Waiting for valid TLS: ${hostname} (${elapsed()}) - ${reason}`);
      await waitFor(interval);
    }
  }

  logger(`URL reachable: ${url} (${elapsed()})`, 'success');
}

export function wrapText(text, width = Math.min(process.stdout.columns || 100, 120), indent = '') {
  const maxContent = width - stringWidth(indent);
  const words = String(text).trim().split(/\s+/);
  const lines = [];
  let line = '';

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (stringWidth(candidate) > maxContent && line) {
      lines.push(indent + line);
      line = word;
    } else {
      line = candidate;
    }
  }

  if (line) lines.push(indent + line);
  return lines.join('\n');
}

export function formatDescription(text, indent = '  ') {
  if (!text) return '';
  const width = Math.min(process.stdout.columns || 100, 100);
  const lines = text.split('\n');
  const result = [];

  // Pending bullet/numbered item being accumulated across wrapped continuation lines
  // (source lines indented deeper than the marker line, with no marker of their own).
  let pendingList = null; // { prefix, lineIndent, content }

  const flushList = () => {
    if (!pendingList) return;
    const { prefix, lineIndent, content } = pendingList;
    const wrapped = wrapText(content, width - prefix.length, '');
    const wrappedLines = wrapped.split('\n');
    result.push(prefix + wrappedLines[0]);
    for (let i = 1; i < wrappedLines.length; i++) {
      result.push(lineIndent + wrappedLines[i]);
    }
    pendingList = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushList();
      result.push('');
      continue;
    }
    const isBullet = /^[-*]\s/.test(trimmed);
    const isNumbered = /^\d+[.)]\s/.test(trimmed);
    const hasContinuationIndent = /^\s/.test(line);

    if (isBullet || isNumbered) {
      flushList();
      const lineIndent = indent + '  ';
      const markerLen = isBullet
        ? trimmed.match(/^[-*]\s+/)[0].length
        : trimmed.match(/^\d+[.)]\s+/)[0].length;
      const prefix = isBullet
        ? indent + '• '
        : indent + trimmed.slice(0, markerLen).trimEnd() + ' ';
      const content = trimmed.slice(markerLen).trim();
      pendingList = { prefix, lineIndent, content };
    } else if (hasContinuationIndent && pendingList) {
      // Indented continuation line - append to the current bullet/numbered item
      // instead of rendering it as its own paragraph.
      pendingList.content += ' ' + trimmed;
    } else {
      flushList();
      result.push(wrapText(trimmed, width, indent));
    }
  }
  flushList();
  return result.join('\n');
}
