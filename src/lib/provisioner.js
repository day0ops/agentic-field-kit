import fs from 'fs';
import path from 'path';
import { CommandRunner, Logger, BoxedOutput } from './common.js';

/**
 * TerraformRunner - Manages Terraform operations
 */
const TF_PROGRESS_RE =
  /^(Still |Waiting |\S+: (Still |Creation |Destruction |Modifications |Read ))/;

export class TerraformRunner {
  constructor(terraformDir) {
    this.terraformDir = terraformDir;
  }

  static capturingBoxHandler(box, captured) {
    return line => {
      captured.push(line);
      if (TF_PROGRESS_RE.test(BoxedOutput.stripAnsi(line))) {
        box.writeProgress(line);
      } else {
        box.writeLine(line);
      }
    };
  }

  async init(options = {}) {
    const { stream = false, ...rest } = options;
    const command = `terraform -chdir=${this.terraformDir} init`;

    if (stream) {
      const captured = [];
      const box = new BoxedOutput('terraform init');
      box.open();
      try {
        await CommandRunner.execStream(
          command,
          TerraformRunner.capturingBoxHandler(box, captured),
          rest
        );
      } catch (err) {
        box.close();
        throw TerraformRunner.enhanceError(err, captured);
      }
      box.close();
    } else {
      Logger.info('Running terraform init...');
      await CommandRunner.exec(command, rest);
    }
  }

  async apply(varFile, stateFile, options = {}) {
    const { autoApprove = true, stream = false, ...rest } = options;

    let command =
      `terraform -chdir=${this.terraformDir} apply` + ` -var-file ${varFile} -state ${stateFile}`;
    if (autoApprove) command += ' -auto-approve';

    if (stream) {
      const captured = [];
      const box = new BoxedOutput('terraform apply');
      box.open();
      try {
        await CommandRunner.execStream(
          command,
          TerraformRunner.capturingBoxHandler(box, captured),
          rest
        );
      } catch (err) {
        box.close();
        throw TerraformRunner.enhanceError(err, captured);
      }
      box.close();
    } else {
      Logger.info('Running terraform apply...');
      await CommandRunner.exec(command, rest);
    }
  }

  async destroy(varFile, stateFile, options = {}) {
    const { autoApprove = true, stream = false, ...rest } = options;

    let command =
      `terraform -chdir=${this.terraformDir} destroy` + ` -var-file ${varFile} -state ${stateFile}`;
    if (autoApprove) command += ' -auto-approve';

    if (stream) {
      const captured = [];
      const box = new BoxedOutput('terraform destroy');
      box.open();
      try {
        await CommandRunner.execStream(
          command,
          TerraformRunner.capturingBoxHandler(box, captured),
          rest
        );
      } catch (err) {
        box.close();
        throw TerraformRunner.enhanceError(err, captured);
      }
      box.close();
    } else {
      Logger.info('Running terraform destroy...');
      await CommandRunner.exec(command, rest);
    }
  }

  static enhanceError(originalError, capturedLines) {
    const output = capturedLines.map(l => BoxedOutput.stripAnsi(l)).join('\n');
    const parsed = TerraformRunner.parseErrorOutput(output);

    if (parsed) {
      const err = new Error(parsed);
      err.terraformOutput = output;
      return err;
    }

    return originalError;
  }

  static parseErrorOutput(output) {
    if (/No valid credential sources found/.test(output)) {
      const provider = output.match(/with provider\["[^"]*\/(\w+)"\]/)?.[1] || 'cloud';
      const lines = [`${provider.toUpperCase()} credentials not found or invalid.`];

      if (provider === 'aws') {
        if (/refresh cached SSO token/.test(output) || /InvalidGrantException/.test(output)) {
          lines.push(
            '',
            'Your AWS SSO session has expired. Re-authenticate:',
            '',
            '  aws sso login --profile <your-profile>'
          );
        } else {
          lines.push(
            '',
            'Configure AWS credentials using one of:',
            '',
            '  aws configure',
            '  aws sso login --profile <your-profile>',
            '  export AWS_ACCESS_KEY_ID=... && export AWS_SECRET_ACCESS_KEY=...'
          );
        }
      } else if (provider === 'google') {
        lines.push('', 'Authenticate with:', '', '  gcloud auth application-default login');
      } else if (provider === 'azurerm') {
        lines.push('', 'Authenticate with:', '', '  az login');
      }

      return lines.join('\n');
    }

    if (
      /failed to refresh cached credentials/.test(output) ||
      /refresh cached SSO token/.test(output)
    ) {
      return [
        'AWS SSO session has expired. Re-authenticate:',
        '',
        '  aws sso login --profile <your-profile>',
      ].join('\n');
    }

    if (
      /GOOGLE_APPLICATION_CREDENTIALS/.test(output) ||
      /could not find default credentials/.test(output)
    ) {
      return [
        'GCP credentials not found.',
        '',
        'Authenticate with:',
        '',
        '  gcloud auth application-default login',
        '  export GOOGLE_APPLICATION_CREDENTIALS=/path/to/credentials.json',
      ].join('\n');
    }

    if (/AuthorizationFailed|AADSTS/.test(output)) {
      return ['Azure authentication failed.', '', 'Authenticate with:', '', '  az login'].join(
        '\n'
      );
    }

    return null;
  }

  /**
   * Get terraform output
   */
  async getOutput(stateFile, outputName) {
    try {
      const result = await CommandRunner.exec(
        `terraform -chdir=${this.terraformDir} output -state ${stateFile} -json`,
        { ignoreError: true }
      );

      if (!result.stdout) {
        Logger.debug(`Terraform output ${outputName} not available yet`);
        return null;
      }

      const outputs = JSON.parse(result.stdout);
      const value = outputs[outputName]?.value;

      if (value === null || value === undefined) {
        return null;
      }

      if (typeof value === 'string') {
        return value.trim();
      }

      return value;
    } catch (err) {
      Logger.debug(`Failed to get terraform output ${outputName}: ${err.message}`);
      return null;
    }
  }
}

/**
 * EnvFileWriter - Writes environment files in .env and env.sh formats
 */
export class EnvFileWriter {
  /**
   * Escape a value for use in .env file format
   */
  static escapeEnvValue(value) {
    if (value === null || value === undefined) {
      return '""';
    }
    const strValue = String(value);
    if (/[\s"$`\\]/.test(strValue) || /^\d/.test(strValue)) {
      return `"${strValue.replace(/"/g, '\\"').replace(/\\/g, '\\\\')}"`;
    }
    return strValue;
  }

  /**
   * Write environment files (both .env and env.sh formats)
   */
  static writeEnvFiles(outputDir, envVars, options = {}) {
    const {
      envShName = 'env.sh',
      envDotenvName = '.env',
      envShHeader = '#!/bin/sh\n',
      makeExecutable = true,
    } = options;

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const envShPath = path.join(outputDir, envShName);
    const envDotenvPath = path.join(outputDir, envDotenvName);

    let envShContent = envShHeader;
    let envDotenvContent = '';

    for (const { key, value } of envVars) {
      if (value !== null && value !== undefined) {
        envShContent += `export ${key}="${String(value).replace(/"/g, '\\"')}"\n`;
        envDotenvContent += `${key}=${this.escapeEnvValue(value)}\n`;
      }
    }

    fs.writeFileSync(envShPath, envShContent);
    fs.writeFileSync(envDotenvPath, envDotenvContent);

    if (makeExecutable) {
      fs.chmodSync(envShPath, 0o755);
    }

    Logger.info(`Environment files created:`);
    Logger.info(`  - Shell script: source ${envShPath}`);
    Logger.info(`  - Dotenv file: ${envDotenvPath}`);

    return {
      envShPath,
      envDotenvPath,
      envShContent,
      envDotenvContent,
    };
  }

  /**
   * Substitute environment variables in a template string
   */
  static envSubst(template, env = {}) {
    const allEnv = { ...process.env, ...env };

    return template.replace(/\$\{(\w+)\}/g, (match, varName) => {
      if (allEnv[varName] !== undefined) {
        return allEnv[varName];
      }
      return match;
    });
  }
}
