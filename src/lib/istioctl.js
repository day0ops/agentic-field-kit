import { join } from 'path';
import { writeFileSync, unlinkSync } from 'fs';
import { CommandRunner, Logger } from './common.js';

const ISTIOCTL_LOCAL_DIR = join(process.cwd(), '._istioctl_dir');
const ISTIOCTL_INSTALL_SCRIPT_URL =
  'https://raw.githubusercontent.com/solo-io/doc-examples/main/istio/install-istioctl.sh';

/**
 * Resolve, download, and run istioctl / solo-istioctl commands.
 */
export class IstioctlHelper {
  static #istioctlStandardPath() {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    return join(home, '.istioctl', 'bin', 'istioctl');
  }

  /**
   * Resolve istioctl binary: solo-istioctl in PATH, cached ~/.istioctl/bin/istioctl, or download.
   * @param {{ istioImage?: string }} [options]
   * @returns {Promise<string|null>}
   */
  static async resolve({ istioImage } = {}) {
    const r = await CommandRunner.exec('which solo-istioctl', { ignoreError: true });
    if (!r.exitCode && r.stdout?.trim()) return 'solo-istioctl';

    const standardPath = this.#istioctlStandardPath();
    const check = await CommandRunner.exec(`test -x "${standardPath}"`, { ignoreError: true });
    if (!check.exitCode) return standardPath;

    Logger.info('istioctl not found — downloading via Solo install script...');
    return await this.#downloadIstioctl(istioImage);
  }

  static async #downloadIstioctl(istioImage = '') {
    const scriptPath = join(ISTIOCTL_LOCAL_DIR, 'install-istioctl.sh');

    await CommandRunner.exec(`mkdir -p "${ISTIOCTL_LOCAL_DIR}"`, { ignoreError: true });

    const dlResult = await CommandRunner.exec(
      `curl -fsSL "${ISTIOCTL_INSTALL_SCRIPT_URL}" -o "${scriptPath}"`,
      { ignoreError: true }
    );
    if (dlResult.exitCode) {
      Logger.warn('Failed to download istioctl install script');
      return null;
    }

    await CommandRunner.exec(`chmod +x "${scriptPath}"`, { ignoreError: true });

    const runResult = await CommandRunner.exec(`ISTIO_IMAGE=${istioImage} sh "${scriptPath}"`, {
      ignoreError: true,
    });
    if (runResult.stderr?.trim()) {
      Logger.warn(`Install script: ${runResult.stderr.trim()}`);
    }

    const standardPath = this.#istioctlStandardPath();
    const check = await CommandRunner.exec(`test -x "${standardPath}"`, { ignoreError: true });
    if (!check.exitCode) {
      Logger.info(`Downloaded istioctl to ${standardPath}`);
      return standardPath;
    }

    Logger.warn('istioctl not found after download');
    return null;
  }

  /**
   * Generate and apply an east-west gateway via istioctl multicluster expose.
   */
  static async deployViaIstioctl(cluster, namespace, contextFlag) {
    Logger.info(`Running istioctl multicluster expose on ${cluster.name}...`);

    const generateResult = await CommandRunner.exec(
      `solo-istioctl multicluster expose --namespace ${namespace} ${contextFlag} --generate`,
      { ignoreError: true }
    );

    if (generateResult.exitCode || !generateResult.stdout) {
      Logger.warn('solo-istioctl not available, falling back to istioctl...');
      const istioctl = await this.resolve();
      if (!istioctl) {
        throw new Error(`Failed to resolve istioctl for east-west gateway on ${cluster.name}`);
      }
      const bin = istioctl.includes('/') ? `"${istioctl}"` : istioctl;
      const fallbackResult = await CommandRunner.exec(
        `${bin} multicluster expose --namespace ${namespace} ${contextFlag} --generate`,
        { ignoreError: true }
      );

      if (fallbackResult.exitCode || !fallbackResult.stdout) {
        throw new Error(`Failed to generate east-west gateway manifest for ${cluster.name}`);
      }

      generateResult.stdout = fallbackResult.stdout;
    }

    const tempFile = `/tmp/.agentic-ew-gateway-${cluster.name}-${process.pid}.yaml`;
    writeFileSync(tempFile, generateResult.stdout);

    try {
      const kubectlCtx = cluster.context ? `--context=${cluster.context}` : '';
      await CommandRunner.exec(`kubectl ${kubectlCtx} apply -f ${tempFile}`);
      Logger.info(`East-west gateway applied on ${cluster.name}`);
    } finally {
      try {
        unlinkSync(tempFile);
      } catch {
        /* best effort */
      }
    }
  }

  /**
   * Run istioctl zc endpoints for a service in a cluster context.
   * @returns {Promise<string>} combined stdout/stderr output
   */
  static async zcEndpoints({ service, serviceNamespace, context, istioImage, timeoutMs = 30000 }) {
    const istioctl = await this.resolve({ istioImage });
    if (!istioctl) {
      throw new Error('istioctl could not be resolved or downloaded');
    }

    const bin = istioctl.includes('/') ? `"${istioctl}"` : istioctl;
    const contextFlag = context ? ` --context=${context}` : '';
    const cmd = `${bin} zc endpoints --service ${service} --service-namespace ${serviceNamespace}${contextFlag}`;

    const result = await CommandRunner.exec(cmd, {
      ignoreError: true,
      timeout: timeoutMs,
    });

    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    if (result.exitCode) {
      throw new Error(
        `istioctl zc endpoints failed (exit ${result.exitCode}): ${output || '(no output)'}`
      );
    }
    return output;
  }
}
