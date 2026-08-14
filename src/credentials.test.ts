import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readCredentials } from './credentials';

const OAUTH = {
  accessToken: 'sk-ant-oat-live',
  refreshToken: 'sk-ant-ort-live',
  expiresAt: 1786000000000,
  scopes: ['user:inference'],
  subscriptionType: 'pro',
  rateLimitTier: 'default',
};

const payload = JSON.stringify({ claudeAiOauth: OAUTH });

// The whole point of the issue: on a standard macOS install the credentials
// file does not exist, because Claude Code keeps them in the login Keychain.
test('on macOS, credentials come from the Keychain', () => {
  const creds = readCredentials({
    platform: 'darwin',
    keychain: () => payload,
    readFile: () => { throw new Error('no such file'); },
  });

  assert.equal(creds?.accessToken, 'sk-ant-oat-live');
  assert.equal(creds?.subscriptionType, 'pro');
});

// Not every macOS install keeps credentials in the Keychain — an older install,
// or one that authenticated through the file, must keep working.
test('on macOS, an empty Keychain falls back to the credentials file', () => {
  const creds = readCredentials({
    platform: 'darwin',
    keychain: () => { throw new Error('The specified item could not be found'); },
    readFile: () => payload,
  });

  assert.equal(creds?.accessToken, 'sk-ant-oat-live');
});

// Windows and Linux keep the file-based behaviour they had before this change.
// Shelling out to `security` there would at best fail and at worst hit an
// unrelated binary of the same name, so the Keychain is never consulted.
test('off macOS, credentials come from the file and the Keychain is left alone', () => {
  for (const platform of ['win32', 'linux']) {
    let keychainConsulted = false;

    const creds = readCredentials({
      platform,
      keychain: () => { keychainConsulted = true; return payload; },
      readFile: () => payload,
    });

    assert.equal(creds?.accessToken, 'sk-ant-oat-live', platform);
    assert.equal(keychainConsulted, false, `${platform} consulted the Keychain`);
  }
});

// Credentials are one segment of the status line. However they fail, the caller
// gets an absence it can render around — never an exception that takes the rest
// of the line down with it.
test('every way of failing to get credentials degrades quietly', () => {
  const denied = () => { throw new Error('User denied Keychain access'); };
  const missing = () => { throw new Error('no such file or directory'); };

  const failures: Record<string, () => string> = {
    'denied Keychain prompt': denied,
    'no entry at all': missing,
    'empty payload': () => '',
    'unparseable payload': () => 'not json{',
    'JSON without the oauth object': () => JSON.stringify({ somethingElse: true }),
    'oauth object explicitly null': () => JSON.stringify({ claudeAiOauth: null }),
  };

  for (const [label, source] of Object.entries(failures)) {
    for (const platform of ['darwin', 'win32', 'linux']) {
      const creds = readCredentials({ platform, keychain: source, readFile: source });
      assert.equal(creds, null, `${platform}: ${label}`);
    }
  }
});

// The macOS fallback must survive the file failing too — a Keychain miss on a
// machine with no credentials file is the ordinary logged-out state.
test('on macOS, both sources failing yields no credentials rather than an error', () => {
  const creds = readCredentials({
    platform: 'darwin',
    keychain: () => { throw new Error('item could not be found'); },
    readFile: () => { throw new Error('no such file or directory'); },
  });

  assert.equal(creds, null);
});

// A Keychain entry that exists but carries no usable token is the same as no
// entry: preferring it would strand a machine whose working credentials sit in
// the file, which is exactly the silent failure this change exists to remove.
test('on macOS, a tokenless Keychain entry does not shadow a usable file', () => {
  const creds = readCredentials({
    platform: 'darwin',
    keychain: () => JSON.stringify({ claudeAiOauth: { subscriptionType: 'pro' } }),
    readFile: () => payload,
  });

  assert.equal(creds?.accessToken, 'sk-ant-oat-live');
});
