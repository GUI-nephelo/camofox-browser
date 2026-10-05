# PR 描述模板

> 目标仓库：`jo-inc/camofox-browser`（base: `master`）
> head: `GUI-nephelo:feat/os-profile-persistence`
> 使用时机：上游批准提交 PR 时，复制以下内容到 PR 描述。

---

## Add persistence.mode = "os-profile": per-user Firefox processes with launchPersistentContext

### Why

StorageState restoration requires protocol-level state injection — `context.addCookies()` / `addInitScript()` after launch. That injection is a detectable tell: restored cookie timelines look nothing like natural browsing history, and injection happens *after* the page's first scripts can observe storage events.

With `persistence.mode: "os-profile"`, each `userId` gets its own Firefox process rooted at a real profile directory. Cookies, localStorage, and IndexedDB live in the profile's own sqlite — the browser loads them natively at startup. **Zero protocol-level state injection.**

This revisits ideas from #4793 (`CAMOFOX_USER_DATA_DIR`) and #6525 (`CAMOFOX_PERSISTENT_PROFILES`), addressing the concerns raised there:

| Concern raised in #6525 | This implementation |
|---|---|
| Multi-tenant cost: N users → N processes | Intentional trade-off, opt-in via config; `MAX_SESSIONS` still caps admission. The target deployment (single primary browser + human VNC co-control) runs one process. |
| IndexedDB coverage gaps in storageState | OS profile persists IndexedDB natively — nothing to snapshot. |
| Session expiry breaks persistent logins (#10992) | Process-bound context survives session expiry by design; the reaper closes pages, the profile keeps state. |

### What changes

- **`persistence.mode: "storageState" \| "os-profile"`** — env `CAMOFOX_PERSISTENCE_MODE` or `camofox.config.json`. Default `storageState`: **zero behavior change** for existing users.
- **userDataDir resolution** (`lib/os-profile.js`, new ~50-line module):
  - userId == `CAMOFOX_PRIMARY_USER_ID` → `CAMOFOX_PRIMARY_PROFILE` verbatim (reuse an existing profile with zero migration)
  - strict-safe userId (`[a-z0-9._-]`, ≤64 chars) → `<CAMOFOX_OS_PROFILE_DIR>/<userId>`
  - anything else (incl. traversal attempts) → sha256-hashed dir name
- **Per-user single-flight launches** (`osProfileLaunches` map): concurrent first requests for the same user coalesce into one `launchPersistentContext`.
- **Lifecycle mapping**: `session.context.close()` now terminates the user's Firefox process (documented in code); `/health`, RSS-pressure and idle-shutdown semantics track the primary user's browser handle; the active health probe navigates a throwaway page in the primary context (persistent contexts can't spawn extra contexts).
- **Persistence plugin gates off in os-profile mode**: storageState hooks early-exit so nothing injects state over the protocol. `DELETE /sessions/:userId/storage_state` is not registered (state lives on disk; delete the profile directory instead).
- **Google SERP probe** (proxy rotation): probes through a throwaway page when the candidate launch is already a persistent context.

### What does NOT change

- `lib/persistence.js` untouched
- `plugins/persistence/index.js` storageState logic untouched (only a top-of-`register()` gate added)
- All 13 REST endpoints and error-code contract unchanged
- `storageState` mode passes the full unit suite unchanged (66 suites / 834 tests green)

### Archaeology

`git log -S launchPersistentContext` across all upstream history: **0 hits** — this branch adds a capability, it does not revert to an old design.

### Testing

- `tests/unit/osProfile.test.js` (new, 14 tests): path resolution (strict keys, traversal hashing, primary identity), context liveness probe, source contracts
- `tests/unit/launchCompat.test.js`: markers updated + 2 new os-profile branch contracts
- `tests/smoke/os-profile-smoke.mjs` (new): real-binary smoke — cookie + localStorage **survive a full server restart** via the profile, two userIds are isolated, profile dirs reused
- Full unit suite: 67 suites / 834 tests green (Windows, Node 22)

### Risks / limitations (also in README-OS-PROFILE.md)

1. N users = N Firefox processes under this mode — cap with `MAX_SESSIONS`
2. Session-level proxy rotation is launch-level per user in os-profile mode
3. One Firefox process per userDataDir (profile lock) — systemd-style single-instance deployment expected
4. `browser.process()` was removed in playwright 1.62; PID-based force-kill degrades to name-based snapshots (pre-existing behavior, unchanged)
