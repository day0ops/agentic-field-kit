import { join } from 'path';
import { tmpdir } from 'os';
import { readFile, unlink } from 'fs/promises';
import { spawn } from 'child_process';
import { CommandRunner, Logger } from './common.js';

const ARCTL_LOCAL_DIR = join(process.cwd(), '._arctl_dir');
const ARCTL_INSTALL_SCRIPT_URL =
  'https://storage.googleapis.com/agentregistry-enterprise/install.sh';

/**
 * Regex that identifies CLIENT-side auth errors requiring a device-login retry.
 * Intentionally excludes bare 'token' and 'login' — too broad and matches
 * server-side messages like "authentication token expired during deployment; please retry"
 * which are retriable operations, not client re-auth scenarios.
 *
 * Also covers a stale locally-cached session whose OIDC issuer no longer resolves
 * (e.g. after an environment's domain changes) - arctl reports this as a failed
 * token refresh / OIDC discovery / JWT parse rather than the phrases above, but a
 * fresh device-authorization login (using the current, correct issuer URL) fixes
 * it the same way.
 */
const AUTH_ERROR_RE =
  /unauthenticated|unauthorized|session expired|re-authenticate|authentication failed|no valid token|token is invalid|invalid token|failed to refresh token|failed to discover oidc configuration|failed to parse jwt/i;

/**
 * True if an arctl error message indicates the local session/token is unusable
 * and a fresh device-authorization login should be attempted automatically.
 */
export function isAuthError(message) {
  return AUTH_ERROR_RE.test(message);
}

/**
 * Resolve, install, and run arctl commands.
 *
 * Binary resolution order:
 *   1. arctl on PATH
 *   2. ._arctl_dir/arctl  (project-local, preferred)
 *   3. Download via Solo install script into ._arctl_dir
 *
 * No persistent fallback to ~/.arctl/bin — always keeps the binary project-local.
 */
export class ArctlHelper {
  static #localBinaryPath() {
    return join(ARCTL_LOCAL_DIR, 'arctl');
  }

  /**
   * Resolve arctl binary path. Downloads + installs to ._arctl_dir if not found.
   * @param {{ version?: string }} [options]  version defaults to '' (latest)
   * @returns {Promise<string>} resolved binary path
   */
  static async resolve({ version = 'v2026.5.4' } = {}) {
    // 1. Check PATH
    const r = await CommandRunner.exec('which arctl', { ignoreError: true });
    if (!r.exitCode && r.stdout?.trim()) return 'arctl';

    // 2. Check project-local ._arctl_dir — but only reuse it if its version actually
    // matches what was requested. A stale cached binary from an earlier default/version
    // silently ignored later `version` overrides here otherwise (e.g. a feature config
    // pinning a newer arctl to pick up a manifest kind the cached binary predates).
    const local = this.#localBinaryPath();
    const localCheck = await CommandRunner.exec(`test -x "${local}"`, { ignoreError: true });
    if (!localCheck.exitCode) {
      const cachedVersion = await this.#cachedVersion(local);
      if (cachedVersion === version) return local;
      Logger.info(
        `Cached arctl is ${cachedVersion || 'unknown version'}, requested ${version} — redownloading...`
      );
    }

    // 3. Download into ._arctl_dir
    Logger.info(`Downloading arctl ${version} to ._arctl_dir...`);
    return await this.#download(version);
  }

  /**
   * Parse `<binary> version`'s first line ("arctl version vX.Y.Z") for the installed
   * version string. Returns null if the binary can't be run or output doesn't match.
   */
  static async #cachedVersion(binPath) {
    const result = await CommandRunner.exec(`"${binPath}" version`, { ignoreError: true });
    const match = result.stdout?.match(/^arctl version (\S+)/m);
    return match ? match[1] : null;
  }

  static async #download(version) {
    const scriptPath = join(ARCTL_LOCAL_DIR, 'install.sh');
    const local = this.#localBinaryPath();

    await CommandRunner.exec(`mkdir -p "${ARCTL_LOCAL_DIR}"`, { ignoreError: true });

    const dlResult = await CommandRunner.exec(
      `curl -fsSL "${ARCTL_INSTALL_SCRIPT_URL}" -o "${scriptPath}"`,
      { ignoreError: true }
    );
    if (dlResult.exitCode) {
      throw new Error('arctl install failed — could not download install script');
    }

    await CommandRunner.exec(`chmod +x "${scriptPath}"`, { ignoreError: true });

    // Install script always places binary at $HOME/.arctl/bin/arctl (ARCTL_INSTALL_DIR not supported)
    const versionEnv = version ? `ARCTL_VERSION=${version} ` : '';
    const runResult = await CommandRunner.exec(`${versionEnv}sh "${scriptPath}"`, {
      ignoreError: true,
    });
    if (runResult.stderr?.trim()) {
      Logger.warn(`arctl install: ${runResult.stderr.trim()}`);
    }

    // Copy from $HOME/.arctl/bin into ._arctl_dir to keep binary project-local
    const homeBin = join(process.env.HOME || '', '.arctl', 'bin', 'arctl');
    const homeCheck = await CommandRunner.exec(`test -x "${homeBin}"`, { ignoreError: true });
    if (!homeCheck.exitCode) {
      await CommandRunner.exec(`cp "${homeBin}" "${local}" && chmod +x "${local}"`, {
        ignoreError: true,
      });
      const copyCheck = await CommandRunner.exec(`test -x "${local}"`, { ignoreError: true });
      if (!copyCheck.exitCode) {
        Logger.info(`arctl ${version} installed to ${local}`);
        process.env.PATH = `${ARCTL_LOCAL_DIR}:${process.env.PATH}`;
        return local;
      }
    }

    throw new Error(`arctl install failed — binary not found at ${local} after install`);
  }

  /**
   * Ensure PATH includes ._arctl_dir so arctl calls work after resolve().
   */
  static ensurePath() {
    if (!process.env.PATH?.includes(ARCTL_LOCAL_DIR)) {
      process.env.PATH = `${ARCTL_LOCAL_DIR}:${process.env.PATH}`;
    }
  }

  /**
   * Perform device-authorization OIDC login interactively.
   *
   * The process is spawned with stdio:inherit so arctl can print the device-code
   * URL and poll until the user approves in the browser.
   *
   * The caller is responsible for stopping any active spinner before calling this.
   *
   * @param {string} bin  Resolved (unquoted) binary path or 'arctl'
   * @param {{ registryUrl: string, oidcIssuerUrl: string, oidcClientId?: string }} loginOptions
   * @returns {Promise<void>}
   */
  static async #doLogin(bin, { registryUrl, oidcIssuerUrl, oidcClientId = 'ar-cli' }) {
    Logger.info(`arctl device-authorization login (${registryUrl})...`);
    await new Promise((resolve, reject) => {
      const proc = spawn(
        bin,
        [
          'user',
          'login',
          '--registry-url',
          registryUrl,
          '--oidc-issuer-url',
          oidcIssuerUrl,
          '--oidc-flow',
          'device-authorization',
          '--oidc-client-id',
          oidcClientId,
        ],
        { stdio: 'inherit' }
      );

      proc.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`arctl device login failed with exit code ${code}`));
      });
      proc.on('error', reject);
    });
    Logger.info('arctl login successful');
  }

  /**
   * Build exec env: sets ARCTL_API_BASE_URL so subcommands that ignore --registry-url
   * (e.g. runtime setup bedrock-agent-core) still reach the correct registry.
   */
  static #execEnv(registryUrl) {
    return registryUrl ? { ...process.env, ARCTL_API_BASE_URL: registryUrl } : undefined;
  }

  /**
   * Ensure a valid arctl session exists for registryUrl, blocking on the
   * interactive device-authorization login if it doesn't. A cheap no-op
   * (one `arctl user whoami` call) when already logged in.
   *
   * Meant to be called as an explicit, unmissable preflight step before a
   * multi-step deploy reaches any arctl-dependent feature -- triggering the
   * device flow implicitly, deep inside one step among many (especially in
   * a non-interactive/backgrounded run nobody is watching in real time),
   * risks the device code expiring before anyone notices it appeared.
   *
   * @param {{ registryUrl: string, oidcIssuerUrl: string, oidcClientId?: string, version?: string }} options
   * @returns {Promise<void>}
   */
  static async ensureLoggedIn({
    registryUrl,
    oidcIssuerUrl,
    oidcClientId = 'ar-cli',
    version,
  } = {}) {
    const binPath = await this.resolve({ version });
    this.ensurePath();

    const bin = binPath.replace(/^"|"$/g, '');
    const b = binPath.includes('/') ? `"${binPath}"` : binPath;
    const registryFlag = registryUrl ? ` --registry-url ${registryUrl}` : '';
    const env = this.#execEnv(registryUrl);

    const result = await CommandRunner.exec(`${b} user whoami${registryFlag}`, {
      ignoreError: true,
      env,
    });
    if (!result.exitCode) return; // already logged in

    const msg = [result.stderr?.trim(), result.stdout?.trim()].filter(Boolean).join('\n');
    if (!isAuthError(msg)) {
      throw new Error(`arctl user whoami failed: ${msg}`);
    }

    await this.#doLogin(bin, { registryUrl, oidcIssuerUrl, oidcClientId });
  }

  /**
   * Login via device-authorization flow then apply a manifest.
   *
   * @param {string} filePath  Path to manifest file
   * @param {{
   *   registryUrl: string,
   *   oidcIssuerUrl: string,
   *   oidcClientId?: string,
   *   version?: string,
   * }} options
   */
  static async deviceLoginAndApplyFile(
    filePath,
    { registryUrl, oidcIssuerUrl, oidcClientId = 'ar-cli', version } = {}
  ) {
    const binPath = await this.resolve({ version });
    this.ensurePath();

    const bin = binPath.replace(/^"|"$/g, '');
    const b = binPath.includes('/') ? `"${binPath}"` : binPath;
    const registryFlag = registryUrl ? ` --registry-url ${registryUrl}` : '';
    const env = this.#execEnv(registryUrl);

    // Try apply with existing session first; only login if unauthenticated
    const tryApply = async () => {
      const result = await CommandRunner.exec(`${b} apply${registryFlag} -f "${filePath}"`, {
        ignoreError: true,
        env,
      });
      if (!result.exitCode) {
        Logger.info('arctl apply successful');
        return true;
      }
      const msg = [result.stderr?.trim(), result.stdout?.trim()].filter(Boolean).join('\n');
      if (isAuthError(msg)) {
        return false; // needs login
      }
      throw new Error(`arctl apply failed: ${msg}`);
    };

    if (await tryApply()) return;

    // Session invalid — device-authorization login
    await this.#doLogin(bin, { registryUrl, oidcIssuerUrl, oidcClientId });

    Logger.info('Applying manifest after login...');
    await tryApply();
  }

  /**
   * Run an arbitrary arctl command with the same try-login-retry pattern.
   *
   * Attempts the command with any existing session first. If the command fails
   * with an auth error the device-authorization flow is triggered and the command
   * is retried once after successful login.
   *
   * The caller is responsible for stopping any active spinner before calling this
   * because the device flow requires interactive terminal output.
   *
   * @param {string[]} args  CLI args (excluding --registry-url which is added automatically)
   * @param {{
   *   registryUrl: string,
   *   oidcIssuerUrl: string,
   *   oidcClientId?: string,
   *   version?: string,
   * }} options
   * @returns {Promise<string>} stdout from the command
   */
  static async deviceLoginAndExec(
    args,
    { registryUrl, oidcIssuerUrl, oidcClientId = 'ar-cli', version } = {}
  ) {
    const binPath = await this.resolve({ version });
    this.ensurePath();

    const bin = binPath.replace(/^"|"$/g, '');
    const b = binPath.includes('/') ? `"${binPath}"` : binPath;
    // Append --registry-url after subcommand args (cobra flag inheritance with deep subcommands)
    const registryFlag = registryUrl ? ` --registry-url ${registryUrl}` : '';
    // Also set ARCTL_API_BASE_URL — some subcommands read env var instead of the flag
    const env = this.#execEnv(registryUrl);

    // Redirect stdout/stderr to temp files — avoids execa buffering issues with large outputs
    const ts = Date.now();
    const outFile = join(tmpdir(), `arctl-out-${ts}.txt`);
    const errFile = join(tmpdir(), `arctl-err-${ts}.txt`);

    const tryExec = async () => {
      const result = await CommandRunner.exec(
        `${b} ${args.join(' ')}${registryFlag} > "${outFile}" 2> "${errFile}"`,
        { ignoreError: true, env }
      );
      const [out, err] = await Promise.all([
        readFile(outFile, 'utf8').catch(() => ''),
        readFile(errFile, 'utf8').catch(() => ''),
      ]);
      unlink(outFile).catch(() => {});
      unlink(errFile).catch(() => {});
      if (!result.exitCode) {
        // stdout is authoritative; fall back to stderr if stdout empty
        return { ok: true, stdout: out.trim() ? out : err };
      }
      const msg = [err.trim(), out.trim()].filter(Boolean).join('\n');
      if (isAuthError(msg)) {
        return { ok: false, stdout: '' }; // needs login
      }
      throw new Error(`arctl ${args[0]} failed: ${msg}`);
    };

    const first = await tryExec();
    if (first.ok) return first.stdout;

    // Session invalid — device-authorization login
    await this.#doLogin(bin, { registryUrl, oidcIssuerUrl, oidcClientId });

    const second = await tryExec();
    return second.stdout;
  }

  /**
   * Run an arbitrary arctl command and return stdout.
   * Assumes a valid session already exists (call after deviceLoginAndApplyFile or deviceLoginAndExec).
   *
   * @param {string[]} args       CLI arguments e.g. ['get', 'deployment', 'foo', '-o', 'yaml']
   * @param {{ registryUrl?: string, version?: string, timeout?: number }} [options]
   * @returns {Promise<string>} stdout
   */
  static async exec(args, { registryUrl, version, timeout = 15_000 } = {}) {
    const binPath = await this.resolve({ version });
    this.ensurePath();
    const b = binPath.includes('/') ? `"${binPath}"` : binPath;
    const registryFlag = registryUrl ? ` --registry-url ${registryUrl}` : '';
    const env = this.#execEnv(registryUrl);
    const result = await CommandRunner.exec(`${b} ${args.join(' ')}${registryFlag}`, {
      ignoreError: true,
      timeout,
      env,
    });
    if (result.exitCode) {
      const msg = [result.stderr?.trim(), result.stdout?.trim()].filter(Boolean).join('\n');
      throw new Error(`arctl ${args[0]} failed: ${msg}`);
    }
    return result.stdout || '';
  }
}
