// 脱离 DSH 单测 host 端的扫描逻辑：
//   node test/probe.mjs [sessionId]
// 不给 sessionId 时用最近修改过的一个会话日志。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanArtifacts } from '../lib/index.js';

function latestSessionId() {
  const root = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions');
  let best = null;
  let bestAt = 0;
  for (const bucket of fs.readdirSync(root)) {
    const dir = path.join(root, bucket);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const log = path.join(dir, e.name, 'session.v4.jsonl.zstd');
      let st;
      try {
        st = fs.statSync(log);
      } catch {
        continue;
      }
      if (st.mtimeMs > bestAt) {
        bestAt = st.mtimeMs;
        best = e.name;
      }
    }
  }
  return best;
}

const id = process.argv[2] || latestSessionId();
if (!id) {
  console.error('没找到任何会话日志，用法：node test/probe.mjs <sessionId>');
  process.exit(1);
}

const t0 = Date.now();
const v = scanArtifacts(id);

console.log('sessionId :', v.sessionId);
console.log('耗时      :', Date.now() - t0, 'ms');
console.log('cwd       :', v.cwd);
console.log('事件数    :', v.eventCount);
console.log('错误      :', v.error);
console.log('产出目录  : 共', v.dirs.length, '个');
for (const d of v.dirs.slice(0, 15)) {
  console.log('   ', d.path, '| 文件数', d.fileCount, '| 样例', d.sample.slice(0, 3).join(', '));
}
console.log('根散文件  :', v.rootFiles.length, v.rootFiles.slice(0, 6).join(', '));
console.log('工作区外  :', v.outsideDirs.map((d) => d.path + ' (' + d.fileCount + ')').join(' ; '));
