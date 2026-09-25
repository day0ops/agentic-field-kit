// test/lib/profile-state.test.js
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { ProfileStateManager } from '../../src/lib/profile-state.js';

const TEST_INFRA_NAME = '__test-infra-profile-state__';

beforeEach(() => {
  const dir = ProfileStateManager.getOutputDir(TEST_INFRA_NAME);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  const dir = ProfileStateManager.getOutputDir(TEST_INFRA_NAME);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

test('getProfileName returns the saved profile when no generation check is requested', async () => {
  await ProfileStateManager.setProfileName(TEST_INFRA_NAME, 'my-profile', '2026-08-21T00:00:00Z');

  const profileName = await ProfileStateManager.getProfileName(TEST_INFRA_NAME);
  expect(profileName).toBe('my-profile');
});

test('getProfileName returns the saved profile when the infra generation matches', async () => {
  await ProfileStateManager.setProfileName(TEST_INFRA_NAME, 'my-profile', '2026-08-21T00:00:00Z');

  const profileName = await ProfileStateManager.getProfileName(
    TEST_INFRA_NAME,
    '2026-08-21T00:00:00Z'
  );
  expect(profileName).toBe('my-profile');
});

test('getProfileName treats a record from a different infra generation as stale', async () => {
  await ProfileStateManager.setProfileName(TEST_INFRA_NAME, 'old-profile', '2026-06-14T00:00:00Z');

  const profileName = await ProfileStateManager.getProfileName(
    TEST_INFRA_NAME,
    '2026-08-21T00:00:00Z'
  );
  expect(profileName).toBeNull();
});

test('getProfileName returns null when nothing has been saved', async () => {
  const profileName = await ProfileStateManager.getProfileName(TEST_INFRA_NAME);
  expect(profileName).toBeNull();
});
