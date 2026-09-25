import { randomBytes } from 'crypto';
import { readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import chalk from 'chalk';
import {
  Logger,
  SpinnerLogger,
  KubernetesHelper,
  CommandRunner,
  waitForPublicUrl,
} from './common.js';
import { InfraStateManager } from './infra-state.js';
import { IstioctlHelper } from './istioctl.js';

/**
 * Use case test runner
 * Handles test execution for Istio Ambient use cases
 */
export class UseCaseTestRunner {
  /**
   * Run tests for a use case
   * @param {Object} usecase - Parsed use case object with metadata and spec
   * @returns {Promise<void>}
   */
  static async runTests(usecase) {
    const spinner = new SpinnerLogger();
    const { metadata, spec } = usecase;

    try {
      if (!spec.tests || spec.tests.length === 0) {
        Logger.warn(`No tests defined for use case '${metadata.name}'`);
        return;
      }

      const testLine =
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
      console.log('');
      console.log(chalk.cyan(chalk.bold(testLine)));
      console.log(chalk.cyan(chalk.bold(`  🧪 Running Tests -> (${spec.tests.length} test(s))`)));
      console.log(chalk.cyan(chalk.bold(testLine)));
      console.log('');

      let passed = 0;
      let failed = 0;
      let skipped = 0;
      const total = spec.tests.length;

      for (let i = 0; i < spec.tests.length; i++) {
        const test = spec.tests[i];
        const testName = test.name || 'unnamed-test';
        const testDesc = test.description || '';
        const idx = `[${i + 1}/${total}]`;
        const headerLabel = `  ${idx} ${testName} `;
        const headerFill = '─'.repeat(Math.max(0, testLine.length - headerLabel.length));

        console.log(chalk.dim(`${headerLabel}${headerFill}`));

        spinner.start(`Running test: ${testName}`);

        try {
          if (!test.steps || test.steps.length === 0) {
            spinner.warn(`Test '${testName}' has no steps - skipped`);
            skipped++;
            console.log('');
            continue;
          }

          if (test.setup && test.setup.length > 0) {
            spinner.setText(`Running setup for: ${testName}`);
            await this.executeTestSteps(
              { ...test, steps: test.setup },
              metadata.name,
              spec,
              spinner
            );
          }

          try {
            await this.executeTestSteps(test, metadata.name, spec, spinner);
          } finally {
            if (test.teardown && test.teardown.length > 0) {
              spinner.setText(`Running teardown for: ${testName}`);
              await this.executeTestSteps(
                { ...test, steps: test.teardown },
                metadata.name,
                spec,
                spinner
              );
            }
          }

          spinner.succeed(testName);
          if (testDesc) {
            console.log(chalk.dim(`  ${testDesc}`));
          }
          passed++;
        } catch (error) {
          spinner.fail(`${testName}: ${error.message}`);
          failed++;
        }

        console.log('');
      }

      const summaryColor = failed > 0 ? chalk.red : chalk.green;
      const skippedPart = skipped > 0 ? chalk.yellow(` · ${skipped} skipped`) : '';
      console.log(summaryColor(chalk.bold(testLine)));
      console.log(
        summaryColor(chalk.bold(`  Results: ${passed} passed · ${failed} failed${skippedPart}`))
      );
      console.log(summaryColor(chalk.bold(testLine)));
      console.log('');

      if (failed > 0) {
        throw new Error(`${failed} test(s) failed`);
      }
    } catch (error) {
      if (error.message.includes('test(s) failed')) {
        throw error;
      }
      spinner.fail(`Failed to run tests: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute test steps
   * @param {Object} test - Test definition with steps array
   * @param {string} usecaseName - Use case name
   * @param {Object} spec - Use case spec
   * @param {SpinnerLogger} spinner - Spinner logger
   * @returns {Promise<void>}
   */
  static async executeTestSteps(test, usecaseName, spec, spinner) {
    const defaultTimeout = test.timeout || 30000;
    let cachedGwAddress = null;
    let lastResponse = null;
    let lastResponseBody = null;
    let lastResponseStatus = null;

    for (const step of test.steps) {
      const action = step.action;

      switch (action) {
        case 'send-request': {
          const context = await this.resolveClusterContext(step, test, spec);

          if (!cachedGwAddress && step.autoDetectGwAddress !== false) {
            const ingressHttpRoute = spec.features?.find(f => f.name === 'ingress-httproute');
            const namespace =
              step.namespace ||
              step.gatewayNamespace ||
              ingressHttpRoute?.config?.gatewayNamespace ||
              spec.features?.find(f => f.name === 'ingress-gateway')?.config?.gateway?.namespace ||
              spec.features?.[0]?.config?.namespace ||
              'default';
            const gwName =
              step.gatewayName ||
              ingressHttpRoute?.config?.gatewayName ||
              spec.features?.find(f => f.name === 'gateway')?.config?.gatewayName ||
              null;
            spinner.setText(`Detecting gateway address (namespace: ${namespace})...`);
            cachedGwAddress = await this.detectGatewayAddress(namespace, gwName, context, 120);
            if (!cachedGwAddress) {
              throw new Error('Could not detect gateway address within timeout');
            }
            spinner.setText(`Gateway address: ${cachedGwAddress}`);
          }

          const address = step.address || cachedGwAddress;
          if (!address) {
            throw new Error('send-request requires "address" or auto-detected gateway address');
          }

          const timeout = this.parseTimeoutSecs(step.timeout || defaultTimeout);
          const path = step.path || '/';
          const method = (step.method || 'GET').toUpperCase();
          const hostname = step.hostname || null;
          const headers = step.headers || {};

          const headerArgs = [];
          if (hostname) {
            headerArgs.push('-H', `Host: ${hostname}`);
          }
          for (const [k, v] of Object.entries(headers)) {
            headerArgs.push('-H', `${k}: ${v}`);
          }

          let bodyArg = [];
          if (step.body) {
            const bodyStr = typeof step.body === 'string' ? step.body : JSON.stringify(step.body);
            bodyArg = ['-d', bodyStr];
          }

          const url = `http://${address}${path}`;
          const curlArgs = [
            '-s',
            '--max-time',
            String(timeout),
            '-X',
            method,
            url,
            ...headerArgs,
            ...bodyArg,
            '-w',
            '\n%{http_code}',
          ];

          spinner.setText(`Sending ${method} request to ${url}...`);
          Logger.debug(`curl ${curlArgs.join(' ')}`);

          const maxRetries = step.retries ?? 3;
          const retryDelay = step.retryDelay ?? 5000;
          let result;

          // Headers are captured via a temp file rather than `-D /dev/stderr` - curl
          // reopens /dev/stderr as a fresh file handle, which fails (exit 23) when the
          // process's real stderr is a pipe, as it reliably is on Linux CI runners.
          const headerFile = join(
            tmpdir(),
            `usecase-test-headers-${randomBytes(8).toString('hex')}.txt`
          );

          try {
            for (let attempt = 0; attempt <= maxRetries; attempt++) {
              if (attempt > 0) {
                spinner.setText(`Retrying request (attempt ${attempt + 1}/${maxRetries + 1})...`);
                await new Promise(r => setTimeout(r, retryDelay));
              }

              result = await CommandRunner.run('curl', [...curlArgs, '-D', headerFile], {
                ignoreError: true,
              });

              const raw = (result.stdout || '').trim();
              const lines = raw.split('\n');
              const httpStatus = parseInt(lines[lines.length - 1], 10);
              const responseBody = lines.slice(0, -1).join('\n').trim();

              let headerFileContent = '';
              try {
                headerFileContent = await readFile(headerFile, 'utf8');
              } catch {
                // curl may not have written the file if the connection failed before any response
              }
              const responseHeaders = {};
              for (const line of headerFileContent.split(/\r?\n/)) {
                const match = line.replace(/\r$/, '').match(/^([^:]+):\s*(.+)$/);
                if (match) {
                  responseHeaders[match[1].toLowerCase()] = match[2].trim();
                }
              }

              lastResponseStatus = httpStatus;
              lastResponseBody = responseBody;
              lastResponse = {
                status: httpStatus,
                body: responseBody,
                headers: responseHeaders,
              };

              if (httpStatus >= 200 && httpStatus < 500) break;
            }
          } finally {
            await unlink(headerFile).catch(() => {});
          }

          spinner.setText(`Request sent, status: ${lastResponseStatus}`);
          break;
        }

        case 'check-public-endpoint': {
          const hostname = step.hostname;
          if (!hostname) {
            throw new Error('check-public-endpoint requires a "hostname" field');
          }

          const protocol = step.protocol || 'https';
          const path = step.path || '/';

          // Waits indefinitely for DNS then HTTP reachability -- child-zone TTLs
          // (see waitForPublicUrl's doc comment) mean a fixed retry budget can time
          // out well before the record has actually propagated.
          await waitForPublicUrl(hostname, {
            protocol,
            path,
            spinner,
            log: (msg, level) => spinner.log(msg, level),
            requireTrustedTls: step.requireTrustedTls !== false,
          });

          lastResponseStatus = 200;
          lastResponseBody = '';
          lastResponse = { status: 200, body: '', headers: {} };
          spinner.setText(`Endpoint alive: ${protocol}://${hostname}${path}`);
          break;
        }

        case 'exec': {
          const command = step.command || step.cmd;
          if (!command) {
            throw new Error('exec action requires a "command" field');
          }

          const context = await this.resolveClusterContext(step, test, spec);
          const timeout = this.parseTimeoutSecs(step.timeout || defaultTimeout);
          const maxRetries = step.retries ?? 3;
          const retryDelay = step.retryDelay ?? 5000;

          let finalCmd = command;
          if (context && command.startsWith('kubectl ') && !command.includes('--context')) {
            finalCmd = command.replace('kubectl ', `kubectl --context=${context} `);
          }

          spinner.setText(`Executing: ${step.name || command.substring(0, 60)}...`);
          Logger.debug(`exec: ${finalCmd}`);

          let execResult;
          let execOutput;

          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (attempt > 0) {
              spinner.setText(`Retrying exec (attempt ${attempt + 1}/${maxRetries + 1})...`);
              await new Promise(r => setTimeout(r, retryDelay));
            }

            try {
              execResult = await CommandRunner.exec(finalCmd, {
                ignoreError: true,
                timeout: timeout * 1000,
              });
              execOutput = (execResult.stdout || '').trim();

              // For exec, store as a "response" so verify can check it
              lastResponseBody = execOutput;
              lastResponseStatus = execResult.exitCode === 0 ? 200 : 500;
              lastResponse = {
                status: lastResponseStatus,
                body: execOutput,
                headers: {},
                exitCode: execResult.exitCode,
              };

              if (execResult.exitCode === 0) break;
            } catch (error) {
              if (attempt >= maxRetries) {
                throw new Error(`exec failed: ${error.message}`);
              }
            }
          }

          spinner.setText(`Exec completed (exit code: ${execResult?.exitCode ?? 'unknown'})`);
          break;
        }

        case 'verify': {
          spinner.setText('Verifying response...');

          if (!lastResponse) {
            throw new Error('No response to verify - send-request or exec must come before verify');
          }

          await this.verifyResponse(
            lastResponse,
            lastResponseBody,
            lastResponseStatus,
            step,
            spinner
          );
          break;
        }

        case 'verify-resource': {
          const { kind, name: resName, namespace: resNs, expect: resExpect } = step;
          const ns = resNs || 'default';
          const context = await this.resolveClusterContext(step, test, spec);
          const contextArgs = context ? ['--context', context] : [];

          spinner.setText(`Verifying ${kind} '${resName}' in ${ns}...`);

          for (const check of resExpect) {
            const result = await KubernetesHelper.kubectl(
              [...contextArgs, 'get', kind, resName, '-n', ns, '-o', `jsonpath=${check.jsonpath}`],
              { ignoreError: true }
            );

            const actual = result.stdout.trim();
            const expected = String(check.value);

            if (actual !== expected) {
              throw new Error(
                `${kind} '${resName}' field ${check.jsonpath}: expected '${expected}', got '${actual}'`
              );
            }
          }
          break;
        }

        case 'wait': {
          const duration = step.duration || 1000;
          spinner.setText(`Waiting ${duration / 1000}s...`);
          await new Promise(r => setTimeout(r, duration));
          break;
        }

        case 'istioctl-zc-endpoints': {
          const service = step.service;
          const serviceNamespace = step.serviceNamespace || step.namespace;
          if (!service || !serviceNamespace) {
            throw new Error(
              'istioctl-zc-endpoints requires "service" and "serviceNamespace" (or "namespace")'
            );
          }

          const context = await this.resolveClusterContext(step, test, spec);
          const timeout = this.parseTimeoutSecs(step.timeout || defaultTimeout);
          const maxRetries = step.retries ?? 5;
          const retryDelay = step.retryDelay ?? 6000;

          spinner.setText(`Running istioctl zc endpoints for ${serviceNamespace}/${service}...`);

          let output;
          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (attempt > 0) {
              spinner.setText(
                `Retrying istioctl zc endpoints (attempt ${attempt + 1}/${maxRetries + 1})...`
              );
              await new Promise(r => setTimeout(r, retryDelay));
            }

            try {
              output = await IstioctlHelper.zcEndpoints({
                service,
                serviceNamespace,
                context,
                timeoutMs: timeout * 1000,
              });
              lastResponseBody = output;
              lastResponseStatus = 200;
              lastResponse = {
                status: 200,
                body: output,
                headers: {},
                exitCode: 0,
              };
              break;
            } catch (error) {
              if (attempt >= maxRetries) {
                throw error;
              }
            }
          }

          spinner.setText('istioctl zc endpoints completed');
          break;
        }

        default:
          spinner.clear();
          Logger.warn(`Unknown test action: ${action}`);
          spinner.render();
      }
    }
  }

  /**
   * Verify response against expected values
   */
  static async verifyResponse(response, body, status, step, _spinner) {
    const { expect = {} } = step;

    if (expect.statusCode !== undefined) {
      if (status !== expect.statusCode) {
        throw new Error(`Expected status code ${expect.statusCode}, got ${status}`);
      }
    }

    if (expect.status === 'success') {
      if (status < 200 || status >= 300) {
        throw new Error(`Expected success status (2xx), got ${status}`);
      }
    } else if (expect.status === 'error') {
      if (status < 400) {
        throw new Error(`Expected error status (4xx or 5xx), got ${status}`);
      }
    } else if (typeof expect.status === 'number') {
      if (status !== expect.status) {
        throw new Error(`Expected status ${expect.status}, got ${status}`);
      }
    }

    if (expect.contains) {
      const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
      Logger.debug(`Response body:\n${bodyStr.substring(0, 2000)}`);
      const items = Array.isArray(expect.contains) ? expect.contains : [expect.contains];
      const lowerBody = bodyStr.toLowerCase();
      for (const item of items) {
        if (!lowerBody.includes(String(item).toLowerCase())) {
          throw new Error(`Response does not contain expected text: "${item}"`);
        }
      }
    }

    if (expect.notContains) {
      const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
      const items = Array.isArray(expect.notContains) ? expect.notContains : [expect.notContains];
      const lowerBody = bodyStr.toLowerCase();
      for (const item of items) {
        if (lowerBody.includes(String(item).toLowerCase())) {
          throw new Error(`Response unexpectedly contains text: "${item}"`);
        }
      }
    }

    if (expect.exitCode !== undefined) {
      const actualExitCode = response.exitCode ?? (status === 200 ? 0 : 1);
      if (actualExitCode !== expect.exitCode) {
        throw new Error(`Expected exit code ${expect.exitCode}, got ${actualExitCode}`);
      }
    }

    if (expect.headers) {
      const respHeaders = response.headers || {};
      for (const [key, expectedValue] of Object.entries(expect.headers)) {
        const actualValue = respHeaders[key.toLowerCase()];
        if (actualValue === undefined) {
          throw new Error(`Expected header '${key}' not found in response`);
        }
        if (expectedValue !== '*' && actualValue !== expectedValue) {
          throw new Error(`Header '${key}': expected '${expectedValue}', got '${actualValue}'`);
        }
      }
    }
  }

  /**
   * Detect the external address of a Gateway resource.
   * Polls until an IP or hostname appears (up to timeoutSeconds).
   */
  static async detectGatewayAddress(namespace, gatewayName, context = null, timeoutSeconds = 120) {
    const contextFlag = context ? `--context=${context}` : '';
    const start = Date.now();

    while (Date.now() - start < timeoutSeconds * 1000) {
      try {
        const result = await CommandRunner.exec(
          `kubectl ${contextFlag} get gateway -n ${namespace} -o jsonpath='{.items[0].status.addresses[0].value}'`,
          { ignoreError: true }
        );
        const addr = (result.stdout || '').replace(/'/g, '').trim();
        if (addr && addr !== 'null') return addr;
      } catch {
        /* retry */
      }

      try {
        const result = await CommandRunner.exec(
          `kubectl ${contextFlag} get svc -n ${namespace} -l gateway.networking.k8s.io/gateway-name=${gatewayName || ''} -o jsonpath='{.items[0].status.loadBalancer.ingress[0].ip}{.items[0].status.loadBalancer.ingress[0].hostname}'`,
          { ignoreError: true }
        );
        const addr = (result.stdout || '').replace(/'/g, '').trim();
        if (addr && addr !== 'null') return addr;
      } catch {
        /* retry */
      }

      await new Promise(r => setTimeout(r, 5000));
    }

    return null;
  }

  /**
   * Resolve cluster context from step, test, or spec level cluster definitions
   */
  static async resolveClusterContext(step, test, spec) {
    const clusters = step.clusters || test.clusters || spec.clusters;
    if (!clusters || clusters.length === 0) return null;

    const cluster = clusters[0];
    if (!cluster.name) return null;

    const infraName = spec.infra;
    if (!infraName) return null;

    try {
      const infraState = await InfraStateManager.load(infraName);
      if (!infraState) return null;

      return InfraStateManager.resolveContextForCluster(infraState, cluster.name);
    } catch {
      return null;
    }
  }

  /**
   * Parse timeout value to seconds
   */
  static parseTimeoutSecs(val, fallbackSecs = 30) {
    if (val == null) return fallbackSecs;
    if (typeof val === 'number') return val > 1000 ? Math.ceil(val / 1000) : val;
    const s = String(val).trim();
    if (s.endsWith('ms')) return Math.ceil(parseFloat(s) / 1000);
    if (s.endsWith('m')) return parseFloat(s) * 60;
    if (s.endsWith('s')) return parseFloat(s);
    const n = parseFloat(s);
    return isNaN(n) ? fallbackSecs : n;
  }
}
