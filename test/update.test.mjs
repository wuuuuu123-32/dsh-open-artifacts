// lib/update.mjs 的单测：版本比较、Release 折算、缓存与失败退避。
// 运行：node test/update.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareVersions,
  evaluateUpdate,
  readOwnVersion,
  createUpdateChecker,
} from '../lib/update.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = path.join(here, '.tmp-cache');
fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(tmpDir, { recursive: true });

let passed = 0;
function ok(label, fn) {
  fn();
  passed += 1;
  console.log('  ok ' + label);
}

console.log('compareVersions');
ok('补丁号更大', () => assert.equal(compareVersions('1.2.3', '1.2.2'), 1));
ok('相同', () => assert.equal(compareVersions('0.3.1', '0.3.1'), 0));
ok('带 v 前缀', () => assert.equal(compareVersions('v0.4.0', '0.3.1'), 1));
ok('两位数字段按数值比', () => assert.equal(compareVersions('0.3.10', '0.3.9'), 1));
ok('段数不同按 0 补齐', () => assert.equal(compareVersions('1.0', '1.0.0'), 0));
ok('预发布小于正式', () => assert.equal(compareVersions('1.0.0-beta.1', '1.0.0'), -1));
ok('正式大于预发布', () => assert.equal(compareVersions('1.0.0', '1.0.0-beta.1'), 1));
ok('降级', () => assert.equal(compareVersions('0.2.0', '0.3.1'), -1));

console.log('evaluateUpdate');
ok('有新版本', () => {
  const r = evaluateUpdate('0.3.1', {
    tag_name: 'v0.4.0',
    html_url: 'https://example.com/r',
    body: 'notes',
    published_at: '2026-01-01T00:00:00Z',
  });
  assert.deepEqual(r, {
    latestVersion: '0.4.0',
    hasUpdate: true,
    releaseUrl: 'https://example.com/r',
    notes: 'notes',
    publishedAt: '2026-01-01T00:00:00Z',
  });
});
ok('同版本不算更新', () => assert.equal(evaluateUpdate('0.3.1', { tag_name: 'v0.3.1' }).hasUpdate, false));
ok('空 release 不炸', () => assert.equal(evaluateUpdate('0.3.1', null).hasUpdate, false));

console.log('readOwnVersion');
ok('读本仓库 package.json', () => {
  const v = readOwnVersion(path.join(here, '..', 'package.json'));
  assert.match(v, /^\d+\.\d+\.\d+/);
});
ok('文件不存在退化 0.0.0', () => assert.equal(readOwnVersion(path.join(tmpDir, 'nope.json')), '0.0.0'));

function fakeGh(tag) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      tag_name: tag,
      html_url: 'https://github.com/x/y/releases/tag/' + tag,
      body: 'changelog for ' + tag,
      published_at: '2026-10-15T00:00:00Z',
    }),
  });
}

console.log('createUpdateChecker');
{
  let calls = 0;
  const cacheFile = path.join(tmpDir, 'a.json');
  const checker = createUpdateChecker({
    currentVersion: '0.3.1',
    cacheFile,
    fetchImpl: async (url, init) => {
      calls += 1;
      assert.match(url, /\/repos\/wuuuuu123-32\/dsh-open-artifacts\/releases\/latest$/);
      assert.equal(init.headers['user-agent'], 'dsh-open-artifacts-update-check');
      return (await fakeGh('v0.4.0')(url, init));
    },
  });

  const first = await checker.check();
  ok('首次打网络并判定有新版本', () => {
    assert.equal(calls, 1);
    assert.equal(first.ok, true);
    assert.equal(first.hasUpdate, true);
    assert.equal(first.latestVersion, '0.4.0');
    assert.equal(first.cached, false);
    assert.equal(first.currentVersion, '0.3.1');
  });

  const second = await checker.check();
  ok('第二次吃内存缓存，不打网络', () => {
    assert.equal(calls, 1);
    assert.equal(second.cached, true);
    assert.equal(second.hasUpdate, true);
  });

  const forced = await checker.check({ force: true });
  ok('force 绕过缓存', () => {
    assert.equal(calls, 2);
    assert.equal(forced.cached, false);
  });

  ok('缓存文件已落盘', () => {
    const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    assert.equal(saved.value.latestVersion, '0.4.0');
    assert.equal(typeof saved.at, 'number');
  });

  // 新实例只读文件缓存，不打网络
  let calls2 = 0;
  const checker2 = createUpdateChecker({
    currentVersion: '0.3.1',
    cacheFile,
    fetchImpl: async () => {
      calls2 += 1;
      throw new Error('不该被调用');
    },
  });
  const fromFile = await checker2.check();
  ok('重启后从文件缓存恢复', () => {
    assert.equal(calls2, 0);
    assert.equal(fromFile.cached, true);
    assert.equal(fromFile.latestVersion, '0.4.0');
  });
}

{
  let calls = 0;
  const cacheFile = path.join(tmpDir, 'b.json');
  const checker = createUpdateChecker({
    currentVersion: '0.3.1',
    cacheFile,
    fetchImpl: async () => {
      calls += 1;
      throw new Error('offline');
    },
  });
  const r = await checker.check();
  ok('网络失败返回 ok:false 而不是抛错', () => {
    assert.equal(r.ok, false);
    assert.equal(r.hasUpdate, false);
    assert.match(r.error, /offline/);
    assert.equal(calls, 1);
  });
  const again = await checker.check();
  ok('失败也进缓存，短时间内不重试', () => {
    assert.equal(calls, 1);
    assert.equal(again.ok, false);
    assert.equal(again.cached, true);
  });
  const third = await checker.check({ force: true });
  ok('force 会重试失败的网络', () => {
    assert.equal(calls, 2);
    assert.equal(third.ok, false);
  });
}

{
  const checker = createUpdateChecker({
    currentVersion: '0.4.0',
    cacheFile: null,
    fetchImpl: fakeGh('v0.4.0'),
  });
  const r = await checker.check();
  ok('已是最新版时不提示', () => assert.equal(r.hasUpdate, false));
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('\n全部通过：' + passed + ' 组断言');
