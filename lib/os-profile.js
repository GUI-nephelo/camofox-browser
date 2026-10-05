/**
 * OS profile persistence helpers (persistence.mode = "os-profile").
 *
 * In os-profile mode each userId maps 1:1 to a Firefox profile directory on
 * disk. Sessions are created with playwright's launchPersistentContext so
 * cookies/localStorage live in the profile's own sqlite -- no
 * addCookies/addInitScript protocol injection happens at session start.
 */

import crypto from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const PROFILE_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function osProfilePathFor({ osProfileDir, primaryProfileDir, primaryUserId, userId }) {
  const key = String(userId);
  if (primaryProfileDir && primaryUserId && key === primaryUserId) {
    return path.resolve(primaryProfileDir);
  }
  if (PROFILE_KEY_RE.test(key)) {
    return path.resolve(osProfileDir, key);
  }
  const hashed = crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
  return path.resolve(osProfileDir, `u-${hashed}`);
}

export async function ensureOsProfileDir(userDataDir) {
  await mkdir(userDataDir, { recursive: true });
  return userDataDir;
}

export function isOsProfileAlive(context) {
  if (!context) return false;
  try {
    if (typeof context.isClosed === 'function' && context.isClosed()) return false;
    context.pages();
    return true;
  } catch {
    return false;
  }
}
