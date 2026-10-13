// dsh-open-artifacts —— host 半边
//
// 做三件事：
//   GET  /__open-artifacts/scan?sessionId=…         → 这个会话产出过文件的目录清单
//   POST /__open-artifacts/open {sessionId,path}    → 用资源管理器打开（先校验路径属于该会话）
//   POST /__open-artifacts/mkdir {sessionId,name}   → 在工作区里建一个产物目录并打开
//
// 为什么自建 HTTP 路由、不用内置 host.openPath()：
//   Windows 上内置实现走 `powershell Invoke-Item`，对**中文路径静默失败**（报告成功却不开窗）。
//   这里直接 spawn explorer.exe，Node 在 Windows 下用 CreateProcessW 传宽字符参数，
//   中文路径不需要额外编码处理。
//
// 会话日志是 zstd 逐帧压缩的 JSONL（见 lib/zstd-session.mjs），
// 产出路径来自两种事件：tool/call 里成功的 write/edit，以及 deliverables/presented。
// 会话自己声明的 cwd 取日志首帧的 "session" 事件 —— 比投影缓存可靠。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findSessionLog, producedPathsFromEvents } from './scan-session-core.mjs';
import { readSessionEvents } from './zstd-session.mjs';

export const name = 'dsh-open-artifacts';

// 不声明任何必需服务：webServer 是可选的（有就注册路由）。
export const inject = [];

const ROUTE = '/__open-artifacts';
const CACHE_MS = 30_000;

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}
function sessionsRoot() {
  return path.join(dshHome(), 'sessions');
}

// --- 会话 → 产出目录 -------------------------------------------------------------

const cache = new Map(); // sessionId -> { at, value }

// 插件自己建出来的目录：日志里没有任何写入记录，scan 看不见，所以单独放行，
// 否则刚建完的空目录连「打开」都会被自己的白名单拒掉。
const createdDirs = new Map(); // sessionId -> Set<绝对路径>

function rememberCreatedDir(sessionId, dir) {
  const set = createdDirs.get(sessionId) || new Set();
  set.add(path.resolve(dir));
  createdDirs.set(sessionId, set);
}

/** present 工具登记过的产物路径（字段名按版本宽松探测，认不出来就当没有） */
function presentedPaths(events) {
  const out = [];
  for (const e of events) {
    if (!e || e.type !== 'deliverables/presented') continue;
    const d = e.data || {};
    for (const key of ['path', 'filePath', 'file_path', 'absolutePath']) {
      if (typeof d[key] === 'string' && d[key]) out.push(d[key]);
    }
    if (Array.isArray(d.items)) {
      for (const it of d.items) {
        if (it && typeof it.path === 'string' && it.path) out.push(it.path);
      }
    }
  }
  return out;
}

/** 扫一个会话，算出它的产物散在哪几个目录里（结果缓存 30 秒） */
export function scanArtifacts(sessionId) {
  const hit = cache.get(sessionId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const value = {
    sessionId,
    cwd: null,
    dirs: [],        // 工作区内的专属子目录（真正的「产物文件夹」）
    rootFiles: [],   // 工作区根目录下的散文件（升级日志.md 这类公用资产）
    outsideDirs: [], // 工作区之外的产出，按所在目录归类
    eventCount: 0,
    error: null,
    scannedAt: Date.now(),
  };

  try {
    const log = findSessionLog(sessionsRoot(), sessionId);
    if (!log || !log.file) {
      value.error = '找不到这个会话的日志文件';
    } else {
      const { events } = readSessionEvents(log.file);
      value.eventCount = Array.isArray(events) ? events.length : 0;

      for (const e of events) {
        if (e && e.type === 'session' && typeof e.cwd === 'string' && e.cwd) {
          value.cwd = e.cwd;
          break;
        }
      }

      const paths = producedPathsFromEvents(events).concat(presentedPaths(events));
      if (!value.cwd) {
        value.cwd = null;
      }

      if (value.cwd) {
        const cwdResolved = path.resolve(value.cwd);
        const dirMap = new Map();
        const outsideMap = new Map();

        for (const p of paths) {
          if (typeof p !== 'string' || !p) continue;
          // 噪音：依赖目录与系统临时目录，不是「这个对话的产物」
          if (/[\\/]node_modules[\\/]/i.test(p)) continue;
          if (/[\\/]AppData[\\/]Local[\\/]Temp[\\/]/i.test(p)) continue;
          const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwdResolved, p);
          const rel = path.relative(cwdResolved, abs);

          if (!rel) continue;
          if (rel.startsWith('..') || path.isAbsolute(rel)) {
            // 工作区之外：按所在目录归类
            const dir = path.resolve(path.dirname(abs));
            const item = outsideMap.get(dir) || { name: path.basename(dir) || dir, path: dir, fileCount: 0 };
            item.fileCount += 1;
            outsideMap.set(dir, item);
            continue;
          }

          if (!rel.includes(path.sep)) {
            // 直接躺在工作区根目录下的散文件（AGENTS.md、升级日志.md、临时 _*.mjs 这类）
            value.rootFiles.push(rel);
            continue;
          }

          const seg = rel.split(path.sep)[0];
          const top = path.join(cwdResolved, seg);
          const item = dirMap.get(top) || { name: seg, path: top, fileCount: 0, sample: [] };
          item.fileCount += 1;
          if (item.sample.length < 30) item.sample.push(rel);
          dirMap.set(top, item);
        }

        value.dirs = [...dirMap.values()].sort((a, b) => b.fileCount - a.fileCount);
        value.outsideDirs = [...outsideMap.values()].sort((a, b) => b.fileCount - a.fileCount).slice(0, 6);
      }
    }
  } catch (e) {
    value.error = (e && e.message) || String(e);
  }

  cache.set(sessionId, { at: Date.now(), value });
  return value;
}

/** 这个会话允许被打开的目录集合（防止拿任意路径来开窗） */
function allowedDirs(sessionId, value) {
  const set = new Set();
  for (const d of value.dirs) set.add(path.resolve(d.path));
  for (const d of value.outsideDirs) set.add(path.resolve(d.path));
  if (value.cwd) set.add(path.resolve(value.cwd));
  const extra = createdDirs.get(sessionId);
  if (extra) for (const d of extra) set.add(d);
  return set;
}

/** 用资源管理器打开一个目录；explorer 的成功/失败不能用退出码判断，spawn 不抛错就算发出去 */
function openInExplorer(dir) {
  const child = spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

// --- HTTP 小工具 -----------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function isLoopback(req) {
  const addr = (req.socket && req.socket.remoteAddress) || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === '';
}

// --- 路由 -----------------------------------------------------------------------

function registerHttp(host, targetCtx) {
  // 会话产物清单
  targetCtx.effect(() => host.register({
    kind: 'exact',
    path: ROUTE + '/scan',
    handler: async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      if (!isLoopback(req)) return sendJson(res, 403, { error: 'loopback only' });
      try {
        const url = new URL(req.url || '/', 'http://localhost');
        const sessionId = url.searchParams.get('sessionId');
        if (!sessionId) return sendJson(res, 400, { error: 'missing sessionId' });
        const value = scanArtifacts(sessionId);
        if (value.error && !value.cwd) return sendJson(res, 200, { ok: false, error: value.error });
        return sendJson(res, 200, { ok: true, ...value });
      } catch (e) {
        return sendJson(res, 500, { error: (e && e.message) || String(e) });
      }
    },
  }));

  // 打开一个目录
  targetCtx.effect(() => host.register({
    kind: 'exact',
    path: ROUTE + '/open',
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      if (!isLoopback(req)) return sendJson(res, 403, { error: 'loopback only' });
      try {
        const raw = await readBody(req);
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          return sendJson(res, 400, { error: 'bad json body' });
        }
        const sessionId = payload && payload.sessionId;
        const target = payload && payload.path;
        if (!sessionId || typeof target !== 'string' || !target) {
          return sendJson(res, 400, { error: 'missing sessionId or path' });
        }
        if (!path.isAbsolute(target)) {
          return sendJson(res, 400, { error: 'path must be absolute' });
        }

        // 只允许打开「这个会话产出过东西的目录」，不接受任意路径
        const value = scanArtifacts(sessionId);
        const allowed = allowedDirs(sessionId, value);
        const resolved = path.resolve(target);
        if (!allowed.has(resolved)) {
          return sendJson(res, 403, { error: 'not an artifact directory of this session' });
        }

        let st;
        try {
          st = fs.statSync(resolved);
        } catch {
          return sendJson(res, 404, { error: '目录不存在（可能已被移动或删除）' });
        }
        if (!st.isDirectory()) {
          return sendJson(res, 400, { error: 'not a directory' });
        }

        openInExplorer(resolved);
        return sendJson(res, 200, { ok: true, path: resolved });
      } catch (e) {
        return sendJson(res, 500, { error: (e && e.message) || String(e) });
      }
    },
  }));

  // 在工作区里新建一个产物目录（只收一个目录名，不收路径），建完直接打开
  targetCtx.effect(() => host.register({
    kind: 'exact',
    path: ROUTE + '/mkdir',
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      if (!isLoopback(req)) return sendJson(res, 403, { error: 'loopback only' });
      try {
        const raw = await readBody(req);
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          return sendJson(res, 400, { error: 'bad json body' });
        }
        const sessionId = payload && payload.sessionId;
        const rawName = payload && payload.name;
        if (!sessionId || typeof rawName !== 'string') {
          return sendJson(res, 400, { error: 'missing sessionId or name' });
        }

        // 只接受「一个目录名」：任何路径成分一律拒绝
        const dirName = rawName.trim();
        if (!dirName || dirName === '.' || dirName === '..' || dirName.length > 64) {
          return sendJson(res, 400, { error: '非法目录名' });
        }
        if (/[\\/:*?"<>|]/.test(dirName) || dirName.includes(path.sep)) {
          return sendJson(res, 400, { error: '目录名不能包含路径字符' });
        }

        const value = scanArtifacts(sessionId);
        if (!value.cwd) {
          return sendJson(res, 200, { ok: false, error: value.error || '拿不到这个会话的工作目录' });
        }

        const cwdResolved = path.resolve(value.cwd);
        const target = path.resolve(cwdResolved, dirName);
        // 双保险：拼出来的路径必须仍在工作区内
        const rel = path.relative(cwdResolved, target);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
          return sendJson(res, 400, { error: '目录必须落在工作区内' });
        }

        let existed = false;
        if (fs.existsSync(target)) {
          if (!fs.statSync(target).isDirectory()) {
            return sendJson(res, 409, { error: '同名文件已存在' });
          }
          existed = true;
        } else {
          fs.mkdirSync(target, { recursive: false });
        }

        rememberCreatedDir(sessionId, target);
        openInExplorer(target);
        return sendJson(res, 200, { ok: true, path: target, existed, name: dirName });
      } catch (e) {
        return sendJson(res, 500, { error: (e && e.message) || String(e) });
      }
    },
  }));
}

// --- 「产物目录」守门 -------------------------------------------------------------
//
// 只拦一种情况：往**工作区根目录**新建一个非 .md 文件。
// 为什么值得拦：AGENTS.md 的规矩是按主题建 <英文短名>\ 子目录，但那只是一段文字，
// 没有强制力，结果产物散在工作区根目录里，事后要靠翻会话日志才找得回来。
// 拦住这一次写入、给模型一段 reason，它就会先建目录再写 —— 比事后补救便宜得多。
//
// 有意不拦的东西：
//   · 子目录里的任何写入 —— 建目录这件事已经发生了
//   · 根目录的 *.md —— AGENTS.md / 升级日志.md / 基建备忘.md 这类跨会话公共文档
//   · 已存在的文件 —— 改它属于「编辑公共资产」，不是「这次对话的新产出」
//   · 名字不是 write 的调用（edit 只改已有文件；read 更不写）
const ROOT_DOC_OK = /\.md$/i;

function guardRootWrite(exec) {
  if (!exec || exec.name !== 'write') return null;
  const agent = exec.agent;
  const header = agent && agent.session && agent.session.header;
  if (!header || typeof header.cwd !== 'string' || !header.cwd) return null;
  const args = exec.arguments;
  if (!args || typeof args !== 'object' || typeof args.file_path !== 'string') return null;

  const cwd = path.resolve(header.cwd);
  const target = path.resolve(cwd, args.file_path);
  if (path.dirname(target) !== cwd) return null; // 子目录 / 工作区外：放行
  if (ROOT_DOC_OK.test(target)) return null; // 根目录的 .md：跨会话公共文档
  if (fs.existsSync(target)) return null; // 已存在：改公共资产，不算新产出

  const base = path.basename(target);
  return [
    `工作区根目录不是产物目录：新建 ${base} 已被拦下。`,
    '请先给这次对话建一个产物目录，再把它写进去。命名规则（见工作区 AGENTS.md）：',
    '2~4 个英文单词、kebab-case、全小写，直接描述这次对话的内容；',
    '不要 trivial / simple / quick / misc / temp / test 这类形容词，也不要 chat / work / task 这类空泛后缀；同名已存在就加序号。',
    `做法二选一：POST /__open-artifacts/mkdir，body {"sessionId":"<本次会话 id>","name":"<目录名>"}；`,
    `或在 ${cwd} 下直接建同名子目录。`,
    `然后把这次调用的 file_path 改成 ${cwd}\\<目录名>\\${base} 重试。`,
    '（工作区根目录里的 .md 公共文档不受此限制。）',
  ].join('\n');
}

export function apply(ctx) {
  const ws = ctx.get('webServer');
  if (ws) registerHttp(ws, ctx);
  else ctx.inject(['webServer'], (sub) => registerHttp(sub.webServer, sub));

  // tools/pre-execute 是 waterfall：返回非 undefined 即短路。
  // deny.reason 就是模型看得到的反馈文本（没有「改写参数」这种能力，只能让它重试）。
  ctx.on('tools/pre-execute', (exec, next) => {
    let reason = null;
    try {
      reason = guardRootWrite(exec);
    } catch {
      reason = null; // 守卫自己出错不能连累工具调用
    }
    if (reason) return { kind: 'deny', reason };
    return typeof next === 'function' ? next() : undefined;
  });
}
