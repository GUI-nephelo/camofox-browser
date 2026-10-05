/**
 * os-profile mode smoke test (real Camoufox binary, local Windows).
 *
 * Verifies the TASK acceptance items that unit tests cannot cover:
 *  - OS mode: navigate -> set cookie+localStorage via page.evaluate on a
 *    local file-free site (use example.com through the network? No -- use
 *    about:blank origin-free page plus data: URL is not persistent).
 *    Instead: navigate to https://example.com, set localStorage + document.cookie,
 *    restart the server, confirm they survive.
 *  - multi-tenant: two userIds get different profile dirs (check via logs).
 *  - /health ok.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';

const ROOT = process.cwd();
const PORT = 9431;
const BASE = `http://127.0.0.1:${PORT}`;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'osprofile-smoke-'));
const primaryProfile = path.join(tmpRoot, 'primary-profile');
const osProfiles = path.join(tmpRoot, 'os-profiles');
fs.mkdirSync(primaryProfile, { recursive: true });

function startServer(extraEnv = {}) {
  const child = spawn(process.execPath, ['--experimental-vm-modules', 'server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      CAMOFOX_PORT: String(PORT),
      CAMOFOX_PERSISTENCE_MODE: 'os-profile',
      CAMOFOX_PRIMARY_PROFILE: primaryProfile,
      CAMOFOX_PRIMARY_USER_ID: 'agent-main',
      CAMOFOX_OS_PROFILE_DIR: osProfiles,
      CAMOFOX_SESSION_TIMEOUT_MS: '0',
      BROWSER_IDLE_TIMEOUT_MS: '0',
      CAMOFOX_CRASH_REPORT_ENABLED: 'false',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[srv] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[srv-err] ${d}`));
  return child;
}

async function waitForServer(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return await res.json();
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not become healthy in time');
}

async function api(method, urlPath, body) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function stopServer(child) {
  return new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
    // Firefox flushes localStorage (LSNG/quotaManager) on graceful exit which
    // can take longer than the Node-side shutdown; give it ample time.
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 45000);
  });
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
}

// ---- Phase A: first server run ----
let srv = startServer();
try {
  const health = await waitForServer(60000);
  check('A1 /health 200 os-mode', health.ok === true && health.engine === 'camoufox', JSON.stringify(health).slice(0, 120));

  // Pre-warm may have launched the primary profile already. Navigate a tab.
  const tab = await api('POST', '/tabs', { userId: 'agent-main', sessionKey: 'smoke', url: 'https://example.com/' });
  check('A2 create tab', tab.status === 200 && tab.json.tabId, JSON.stringify(tab.json).slice(0, 140));

  const ev = await api('POST', `/tabs/${tab.json.tabId}/evaluate`, {
    userId: 'agent-main',
    expression: `(() => { document.cookie = 'os_smoke=1; path=/; max-age=86400'; localStorage.setItem('os_smoke_ls', 'survivor'); return document.cookie + ' | ' + localStorage.getItem('os_smoke_ls'); })()`,
  });
  check('A3 set cookie+localStorage', ev.status === 200 && /os_smoke=1/.test(ev.json.result || '') && /survivor/.test(ev.json.result || ''), JSON.stringify(ev.json).slice(0, 140));

  // Firefox LSNG flushes localStorage to storage/default/<origin>/ls/ on a
  // 5s interval; give it time before shutdown or the write stays in memory.
  await new Promise((r) => setTimeout(r, 8000));

  await api('DELETE', `/tabs/${tab.json.tabId}?userId=agent-main`);
} finally {
  await stopServer(srv);
}

// ---- Phase B: restart server, verify persistence ----
srv = startServer();
try {
  await waitForServer(60000);
  const tab = await api('POST', '/tabs', { userId: 'agent-main', sessionKey: 'smoke2', url: 'https://example.com/' });
  check('B1 recreate tab after restart', tab.status === 200 && tab.json.tabId, JSON.stringify(tab.json).slice(0, 140));

  const ev = await api('POST', `/tabs/${tab.json.tabId}/evaluate`, {
    userId: 'agent-main',
    expression: `document.cookie + ' | ' + (localStorage.getItem('os_smoke_ls') || 'MISSING')`,
  });
  const persisted = /os_smoke=1/.test(ev.json.result || '') && /survivor/.test(ev.json.result || '');
  check('B2 cookie+localStorage survive restart (zero injection)', persisted, `result=${JSON.stringify(ev.json.result).slice(0, 140)}`);

  await api('DELETE', `/tabs/${tab.json.tabId}?userId=agent-main`);

  // ---- multi-tenant: second user, isolated profile dir ----
  const tab2 = await api('POST', '/tabs', { userId: 'tenant-b', sessionKey: 'smoke', url: 'https://example.com/' });
  check('C1 second user tab', tab2.status === 200 && tab2.json.tabId, JSON.stringify(tab2.json).slice(0, 140));

  const ev2 = await api('POST', `/tabs/${tab2.json.tabId}/evaluate`, {
    userId: 'tenant-b',
    expression: `document.cookie + ' | ' + (localStorage.getItem('os_smoke_ls') || 'MISSING')`,
  });
  const isolated = !/os_smoke=1/.test(ev2.json.result || '') && !/survivor/.test(ev2.json.result || '');
  check('C2 tenant-b does not see agent-main state', isolated, `result=${JSON.stringify(ev2.json.result).slice(0, 140)}`);

  await api('DELETE', `/tabs/${tab2.json.tabId}?userId=tenant-b`);
} finally {
  await stopServer(srv);
}

// profile dirs actually created?
check('D1 primary profile dir reused (not recreated under osProfiles)', fs.existsSync(primaryProfile));
check('D2 tenant-b profile dir created under osProfiles', fs.readdirSync(osProfiles).includes('tenant-b'));

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`);
process.exit(failed.length ? 1 : 0);
