// dsh-open-artifacts —— 更新检查（host 半边的一个独立模块）
//
// 为什么不去 npm 查：这个包没有发布到 npm（registry.npmjs.org/dsh-open-artifacts 返回 404），
// 唯一权威来源是 GitHub Releases —— 每次发布都由 release-tools 建好 tag + Release，
// 所以「最新 Release 的 tag」就是「最新版本号」，它的 body 就是更新说明。
//
// 为什么要缓存：api.github.com 未认证限额 60 次/小时，而界面每次挂载都会问一次。
// 所以默认 6 小时缓存（内存 + ~/.dsh/.cache 下的文件，重启不丢），
// 界面走缓存，只有带 ?force=1 才真打网络；网络失败时用 30 分钟退避缓存，
// 免得用户连点刷新把限额打光。
//
// 除了网络，这个模块不依赖 DSH 的任何 API —— 便于单测（注入 fetchImpl / now / cacheFile）。

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_REPO = 'wuuuuu123-32/dsh-open-artifacts';
export const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_FAIL_TTL_MS = 30 * 60 * 1000;

/** 'v1.2.3' / '1.2.3' / '1.2.3-beta.1' → { nums:[1,2,3], pre:'beta.1' } */
function splitVersion(v) {
  const s = String(v == null ? '' : v).trim().replace(/^v/i, '');
  const dash = s.indexOf('-');
  const core = dash >= 0 ? s.slice(0, dash) : s;
  const pre = dash >= 0 ? s.slice(dash + 1) : '';
  const nums = core.split('.').map((n) => {
    const m = /^\d+/.exec(n.trim());
    return m ? parseInt(m[0], 10) : 0;
  });
  return { nums, pre };
}

/** a > b → 1，a < b → -1，相等 → 0。正式版大于同号预发布版。 */
export function compareVersions(a, b) {
  const A = splitVersion(a);
  const B = splitVersion(b);
  const len = Math.max(A.nums.length, B.nums.length);
  for (let i = 0; i < len; i += 1) {
    const x = A.nums[i] || 0;
    const y = B.nums[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  if (A.pre === B.pre) return 0;
  if (!A.pre) return 1;
  if (!B.pre) return -1;
  return A.pre > B.pre ? 1 : -1;
}

/** 把 GitHub Releases API 的一个 release 对象折算成界面要用的字段 */
export function evaluateUpdate(currentVersion, release) {
  const r = release && typeof release === 'object' ? release : {};
  const tag = r.tag_name || r.tagName || '';
  const latestVersion = String(tag).trim().replace(/^v/i, '') || null;
  return {
    latestVersion,
    hasUpdate: !!latestVersion && compareVersions(latestVersion, currentVersion) > 0,
    releaseUrl: r.html_url || r.htmlUrl || null,
    notes: typeof r.body === 'string' ? r.body : '',
    publishedAt: r.published_at || r.publishedAt || null,
  };
}

/** 读插件自己的 package.json 版本号；读不到就当 0.0.0（最保守：任何发布都算新版本） */
export function readOwnVersion(packageJsonPath) {
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function createUpdateChecker(options = {}) {
  const repo = options.repo || DEFAULT_REPO;
  const name = options.name || 'dsh-open-artifacts';
  const currentVersion = options.currentVersion || '0.0.0';
  const cacheFile = options.cacheFile || null;
  const ttlMs = options.ttlMs || DEFAULT_TTL_MS;
  const failTtlMs = options.failTtlMs || DEFAULT_FAIL_TTL_MS;
  const timeoutMs = options.timeoutMs || 8000;
  const apiBase = options.apiBase || 'https://api.github.com';
  const fetchImpl = options.fetchImpl || ((url, init) => fetch(url, init));
  const now = options.now || (() => Date.now());
  const log = options.log || (() => {});

  let memory = null; // { at, value }
  let inflight = null;

  function readCacheFile() {
    if (!cacheFile) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (raw && typeof raw.at === 'number' && raw.value && typeof raw.value === 'object') return raw;
      return null;
    } catch {
      return null;
    }
  }

  function writeCacheFile(entry) {
    if (!cacheFile) return;
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(entry), 'utf8');
    } catch (e) {
      log('cache write failed: ' + ((e && e.message) || e));
    }
  }

  function cachedEntry() {
    if (memory) return memory;
    const fromFile = readCacheFile();
    if (fromFile) memory = fromFile;
    return memory;
  }

  function isFresh(entry) {
    if (!entry) return false;
    const ttl = entry.value && entry.value.ok === false ? failTtlMs : ttlMs;
    return now() - entry.at < ttl;
  }

  async function fetchLatestRelease() {
    const url = apiBase + '/repos/' + repo + '/releases/latest';
    const init = {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'dsh-open-artifacts-update-check',
      },
    };
    // AbortSignal.timeout 在 Node 18+ 都有；注入的 fetchImpl 若不认 signal 也无所谓
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) init.signal = AbortSignal.timeout(timeoutMs);
    const res = await fetchImpl(url, init);
    if (!res || !res.ok) throw new Error('GitHub API ' + (res ? res.status : 'no response'));
    return res.json();
  }

  function project(entry, extra) {
    return Object.assign(
      {
        name,
        repo,
        currentVersion,
        checkedAt: entry ? entry.at : null,
      },
      entry && entry.value ? entry.value : {},
      extra || {}
    );
  }

  /**
   * 查最新版本。默认吃缓存（新鲜就直接返回），force:true 才真打网络。
   * 网络挂了也不抛错：返回 ok:false + error，界面据此不提示更新。
   */
  async function check({ force = false } = {}) {
    const entry = cachedEntry();
    if (!force && isFresh(entry)) return project(entry, { cached: true, ok: !(entry.value && entry.value.ok === false) });

    if (inflight) return inflight;

    inflight = (async () => {
      try {
        const release = await fetchLatestRelease();
        const value = Object.assign({ ok: true, error: null }, evaluateUpdate(currentVersion, release));
        const fresh = { at: now(), value };
        memory = fresh;
        writeCacheFile(fresh);
        return project(fresh, { cached: false });
      } catch (e) {
        const message = (e && e.message) || String(e);
        log('update check failed: ' + message);
        const failed = {
          at: now(),
          value: {
            ok: false,
            error: message,
            latestVersion: null,
            hasUpdate: false,
            releaseUrl: null,
            notes: '',
            publishedAt: null,
          },
        };
        memory = failed;
        writeCacheFile(failed);
        return project(failed, { cached: false });
      } finally {
        inflight = null;
      }
    })();

    return inflight;
  }

  return { check, currentVersion, repo, name };
}
