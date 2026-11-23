import { test, expect } from 'bun:test';
import { CommandRunner } from '../../src/lib/common.js';

test('CommandRunner.run does not leak secret-bearing arg values in the thrown error message', async () => {
  let thrown;
  try {
    await CommandRunner.run('bash', [
      '-c',
      'exit 1',
      '--set-string',
      'oidc.clientSecret=super-secret-value',
      '--set',
      'grafanaAdminPassword=another-secret',
    ]);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeDefined();
  expect(thrown.message).not.toContain('super-secret-value');
  expect(thrown.message).not.toContain('another-secret');
  expect(thrown.message).not.toContain('oidc.clientSecret');
});

test('CommandRunner.run error message still identifies the failing command', async () => {
  let thrown;
  try {
    await CommandRunner.run('bash', ['-c', 'exit 1']);
  } catch (error) {
    thrown = error;
  }
  expect(thrown.message).toContain('bash');
});
