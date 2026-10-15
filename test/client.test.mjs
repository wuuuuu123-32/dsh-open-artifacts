// lib/client.js 的离线单测：不构建、不浏览器，用 stub 把模块表喂进 vm 里加载。
// 验证两件事：① apply() 注册了哪些插槽；② 更新卡片该不该显示 + 渲染出的文案。
// 运行：node test/client.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8');

// —— stub 掉客户端 runtime ——
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
  useState: (init) => [init, () => {}],
  useEffect: () => {},
  Fragment: 'Fragment',
};

const primitives = new Proxy(
  {},
  {
    get: (t, key) => {
      if (key === 'Button' || key === 'MenuItemButton') return key;
      if (key === 'Modal') return 'Modal';
      return undefined; // 图标一律缺省，组件里有兜底
    },
  }
);

const store = new Map();
let loaded = null;
const sandbox = {
  console,
  window: {
    __ModuleLoader__: { load: (def) => { loaded = def; } },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    open: () => {},
  },
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

assert.ok(loaded, 'client.js 应当调用 window.__ModuleLoader__.load');
assert.equal(loaded.id, 'dsh-open-artifacts');

const requireStub = (id) => {
  if (id === 'react') return React;
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
  throw new Error('unexpected require: ' + id);
};
const mod = loaded.factory(requireStub);
const internals = mod.__internals;

let passed = 0;
function ok(label, fn) {
  fn();
  passed += 1;
  console.log('  ok ' + label);
}

console.log('inject / apply');
{
  const regs = [];
  const ctx = {
    get: () => null,
    effect: (fn) => { fn(); },
    slots: {
      inject: (slot, gen) => { for (const r of gen()) regs.push(r); },
      register: (meta, comp) => ({ meta, comp }),
    },
  };
  mod.apply(ctx);
  // 注意：vm 里造出来的数组跨 realm，deepStrictEqual 会因为原型不同而失败，只能比内容
  ok('声明了 slots 依赖', () => assert.equal(Array.from(mod.inject).join(','), 'slots'));
  ok('注册 4 个插槽（菜单 / 标题 / 弹窗 / 更新提示）', () => {
    assert.deepEqual(
      regs.map((r) => r.meta.id),
      ['open-artifacts:menu', 'open-artifacts:header', 'open-artifacts:overlay', 'open-artifacts:update-notice']
    );
  });
  ok('更新提示挂在 shell.overlay、带自己的 id', () => {
    const r = regs[3];
    assert.equal(r.meta.name, 'shell.overlay');
    assert.equal(r.meta.locale, 'open-artifacts');
    assert.equal(typeof r.comp, 'function');
  });
}

console.log('shouldShowUpdate');
const upd = (over) => Object.assign({ hasUpdate: true, latestVersion: '0.4.0' }, over);
ok('有新版本且没被忽略 → 显示', () => assert.equal(internals.shouldShowUpdate(upd(), ''), true));
ok('没有更新 → 不显示', () => assert.equal(internals.shouldShowUpdate(upd({ hasUpdate: false }), ''), false));
ok('host 查询失败（ok:false）→ 不显示', () =>
  assert.equal(internals.shouldShowUpdate({ ok: false, hasUpdate: false, error: 'offline' }, ''), false));
ok('state 为空 → 不显示', () => assert.equal(internals.shouldShowUpdate(null, ''), false));
ok('latestVersion 缺失 → 不显示', () => assert.equal(internals.shouldShowUpdate(upd({ latestVersion: null }), ''), false));
ok('已忽略这个版本 → 不显示', () => assert.equal(internals.shouldShowUpdate(upd(), '0.4.0'), false));
ok('忽略的是旧版本 → 新版本仍然显示', () =>
  assert.equal(internals.shouldShowUpdate(upd({ latestVersion: '0.5.0' }), '0.4.0'), true));

console.log('UpdateNotice 渲染');
function collectStrings(node, out = []) {
  if (node == null || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const n of node) collectStrings(n, out); return out; }
  if (typeof node === 'object') {
    collectStrings(node.children, out);
    if (typeof node.type === 'function') collectStrings(node.type(node.props), out);
    return out;
  }
  return out;
}
ok('默认（无更新）不渲染', () => assert.equal(internals.UpdateNotice(), null));
ok('有更新时渲染版本号与更新说明按钮', () => {
  internals.setUpdateState({
    ok: true,
    hasUpdate: true,
    currentVersion: '0.3.1',
    latestVersion: '0.4.0',
    releaseUrl: 'https://github.com/wuuuuu123-32/dsh-open-artifacts/releases/tag/v0.4.0',
    notes: '修好了某个东西',
  });
  const tree = internals.UpdateNotice();
  const text = collectStrings(tree).join(' | ');
  assert.match(text, /插件有新版本/);
  assert.match(text, /0\.3\.1 → 最新 0\.4\.0/);
  assert.match(text, /更新说明/);
  assert.match(text, /忽略这个版本/);
  assert.match(text, /dsh plugin add dsh-open-artifacts/);
});
ok('被忽略的版本不渲染', () => {
  internals.rememberDismissed('0.4.0');
  assert.equal(internals.readDismissed(), '0.4.0');
  assert.equal(internals.UpdateNotice(), null);
});
ok('更高的新版本会重新渲染', () => {
  internals.setUpdateState({ ok: true, hasUpdate: true, currentVersion: '0.3.1', latestVersion: '0.5.0', notes: '' });
  const text = collectStrings(internals.UpdateNotice()).join(' | ');
  assert.match(text, /0\.5\.0/);
});

console.log('\n全部通过：' + passed + ' 组断言');
