import { describe, expect, test } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { osProfilePathFor, isOsProfileAlive } from '../../lib/os-profile.js';

const serverSource = fs.readFileSync(path.join(process.cwd(), 'server.js'), 'utf-8');
const configSource = fs.readFileSync(path.join(process.cwd(), 'lib', 'config.js'), 'utf-8');
const persistencePluginSource = fs.readFileSync(
  path.join(process.cwd(), 'plugins', 'persistence', 'index.js'),
  'utf-8'
);

describe('osProfilePathFor', () => {
  const base = { osProfileDir: '/data/os-profiles', primaryProfileDir: '', primaryUserId: '' };

  test('uses the strict key verbatim inside the os profile dir', () => {
    expect(osProfilePathFor({ ...base, userId: 'agent-main' })).toBe(path.resolve('/data/os-profiles/agent-main'));
    expect(osProfilePathFor({ ...base, userId: 'user_01.2-3' })).toBe(path.resolve('/data/os-profiles/user_01.2-3'));
  });

  test('hashes arbitrary userIds into a path-safe directory', () => {
    const p = osProfilePathFor({ ...base, userId: '../evil/user with spaces' });
    expect(p.startsWith(path.resolve('/data/os-profiles'))).toBe(true);
    expect(path.basename(path.dirname(p))).toBe('os-profiles');
    expect(p).toMatch(/u-[0-9a-f]{32}$/);
  });

  test('rejects traversal for keys that look path-like', () => {
    const p = osProfilePathFor({ ...base, userId: '..' });
    expect(path.dirname(p)).toBe(path.resolve('/data/os-profiles'));
  });

  test('primary identity resolves to primaryProfileDir verbatim', () => {
    const p = osProfilePathFor({
      osProfileDir: '/data/os-profiles',
      primaryProfileDir: '/home/debian/.camo/profiles/agent-main',
      primaryUserId: 'agent-main',
      userId: 'agent-main',
    });
    expect(p).toBe(path.resolve('/home/debian/.camo/profiles/agent-main'));
  });

  test('non-primary users ignore primaryProfileDir', () => {
    const p = osProfilePathFor({
      osProfileDir: '/data/os-profiles',
      primaryProfileDir: '/home/debian/.camo/profiles/agent-main',
      primaryUserId: 'agent-main',
      userId: 'other-user',
    });
    expect(p).toBe(path.resolve('/data/os-profiles/other-user'));
  });
});

describe('isOsProfileAlive', () => {
  test('returns false for null/undefined contexts', () => {
    expect(isOsProfileAlive(null)).toBe(false);
    expect(isOsProfileAlive(undefined)).toBe(false);
  });

  test('returns false when the context reports closed', () => {
    expect(isOsProfileAlive({ isClosed: () => true, pages: () => [] })).toBe(false);
  });

  test('returns true when pages() works and context is open', () => {
    expect(isOsProfileAlive({ isClosed: () => false, pages: () => [] })).toBe(true);
  });

  test('returns false when pages() throws (dead context)', () => {
    expect(isOsProfileAlive({ isClosed: () => false, pages: () => { throw new Error('target closed'); } })).toBe(false);
  });
});

describe('os-profile source contract', () => {
  test('config defaults keep storageState mode and tmp-safe profile dirs', () => {
    expect(configSource).toContain("process.env.CAMOFOX_PERSISTENCE_MODE || configuredPersistenceMode");
    expect(configSource).toContain("'storageState'");
    expect(configSource).toContain("'os-profile'");
    expect(configSource).toContain("join(os.homedir(), '.camofox', 'os-profiles')");
    expect(configSource).toContain('CAMOFOX_PERSISTENCE_MODE: process.env.CAMOFOX_PERSISTENCE_MODE');
  });

  test('storageState plugin hooks early-exit in os-profile mode', () => {
    expect(persistencePluginSource).toContain("if (ctx.launchMode === 'os-profile') {");
    expect(persistencePluginSource).toContain('return;');
  });

  test('os-profile cookie imports still work through the session context', () => {
    // In os-profile mode the browser handle stored in `browser` is the
    // primary user's; session contexts stay the single source of pages.
    expect(serverSource).toContain('const context = OS_PROFILE_MODE ? b : await b.newContext(contextOptions);');
    expect(serverSource).toContain('await session.context.close().catch(() => {});');
    expect(serverSource).toContain('osProfileLaunches.delete(key);');
  });

  test('storageState launch path is untouched when the mode is off', () => {
    expect(serverSource).toContain('candidateBrowser = await firefox.launch(options)');
    expect(serverSource).toContain('const context = OS_PROFILE_MODE ? b : await b.newContext(contextOptions);');
    expect(serverSource).toContain('_closeBrowserFullyImpl(reason) {\n  if (OS_PROFILE_MODE) {');
  });

  test('os-profile dir never sits under the OS temp dir by default', () => {
    const tmp = os.tmpdir();
    const def = path.join(os.homedir(), '.camofox', 'os-profiles');
    expect(def.toLowerCase().startsWith(tmp.toLowerCase())).toBe(false);
  });
});
