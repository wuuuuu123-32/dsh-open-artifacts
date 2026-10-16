// dsh-open-artifacts（客户端半边）
//
// 在会话行的「⋯」菜单和会话标题旁各加一个「打开产物文件夹」，
// 点了就去 host 那边问「这个对话产出过哪些目录」，只有一个就直接开，
// 有多个就弹个小列表让你选。
//
// 为什么不做 DOM 注入：本机 DSH 0.2.0-rc.2 里
// `sidebar.workspaces.session.menu.item` 和 `conversation.session.header.actions`
// 都是官方开放的正规插槽，两个都能直接拿到 sessionId（见插槽目录里的 standardProps）。
//
// 本文件是手写的模块表产物（与 dsh-session-delete 的 lib/client.js 同协议），
// 因此不需要构建步骤：工厂函数收 `require`，最后交出 apply / inject。
window.__ModuleLoader__.load({
  id: 'dsh-open-artifacts',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const P = require('@deepseek-ai/dsh-client-ui-primitives');

    // 只声明 slots；locale 通过 ctx.get() 惰性访问，声明成必需反而会让插件在缺它的客户端上等下去。
    const inject = ['slots'];

    const MENU_SLOT = 'sidebar.workspaces.session.menu.item';
    const HEADER_SLOT = 'conversation.session.header.actions';
    const OVERLAY_SLOT = 'shell.overlay';
    const NS = 'open-artifacts';
    const ROUTE = '/__open-artifacts';

    const DICT_ZH = {
      'menu.open': '打开产物文件夹',
      'action.open': '产物',
      'dialog.title': '产物文件夹',
      'dialog.loading': '正在读会话日志…',
      'dialog.chooseTitle': '选一个产物文件夹',
      'dialog.chooseDesc': '这个对话的产出散在几个地方：',
      'dialog.files': '{count} 个文件',
      'dialog.outsideNote': '工作区之外',
      'dialog.artifactNote': '产物根下（按时间推断，可能含别的对话）',
      'dialog.rootNote': '工作区根目录下的散文件',
      'dialog.emptyTitle': '没有找到产物',
      'dialog.empty': '这个对话在产物根和工作区里都没有找到产出。',
      'dialog.openWorkspace': '打开工作区根目录',
      'dialog.openArtifactRoot': '打开产物根目录',
      'dialog.create': '新建产物目录',
      'dialog.createTitle': '新建产物目录',
      'dialog.createDesc': '在产物根里建一个目录，建完直接打开。',
      'dialog.createPlaceholder': '目录名，例如 lab-report-9',
      'dialog.createConfirm': '创建并打开',
      'dialog.creating': '创建中…',
      'dialog.createEmpty': '请输入目录名',
      'dialog.createHint': '命名规则：2~4 个英文单词、kebab-case、全小写，直接描述这次对话的内容，不要形容词和空泛后缀。',
      'dialog.error': '打不开',
      'dialog.close': '关闭',
      'update.title': '插件有新版本',
      'update.version': '当前 {from} → 最新 {to}',
      'update.showNotes': '更新说明',
      'update.hideNotes': '收起说明',
      'update.noNotes': '（这条 Release 没写说明）',
      'update.openRelease': '打开 Release 页面',
      'update.ignore': '忽略这个版本',
      'update.dismiss': '关闭',
      'update.how': '更新方式：在市场插件页点「更新」，或运行 dsh plugin add dsh-open-artifacts（从 GitHub 装的写 github:wuuuuu123-32/dsh-open-artifacts）。',
    };
    const DICT_EN = {
      'menu.open': 'Open artifact folder',
      'action.open': 'Artifacts',
      'dialog.title': 'Artifact folder',
      'dialog.loading': 'Reading the session log…',
      'dialog.chooseTitle': 'Pick an artifact folder',
      'dialog.chooseDesc': 'This conversation wrote to several places:',
      'dialog.files': '{count} files',
      'dialog.outsideNote': 'outside the workspace',
      'dialog.artifactNote': 'under the artifact root (inferred by time; may include other chats)',
      'dialog.rootNote': 'loose files at the workspace root',
      'dialog.emptyTitle': 'No artifacts found',
      'dialog.empty': 'No artifacts found for this conversation, neither under the artifact root nor in the workspace.',
      'dialog.openWorkspace': 'Open the workspace root',
      'dialog.openArtifactRoot': 'Open the artifact root',
      'dialog.create': 'New artifact folder',
      'dialog.createTitle': 'New artifact folder',
      'dialog.createDesc': 'Create a folder under the artifact root and open it right away.',
      'dialog.createPlaceholder': 'folder name, e.g. lab-report-9',
      'dialog.createConfirm': 'Create and open',
      'dialog.creating': 'Creating…',
      'dialog.createEmpty': 'Enter a folder name',
      'dialog.createHint': '2-4 English words, kebab-case, all lowercase, describing what this conversation produced.',
      'dialog.error': 'Could not open',
      'dialog.close': 'Close',
      'update.title': 'Plugin update available',
      'update.version': 'current {from} → latest {to}',
      'update.showNotes': 'Release notes',
      'update.hideNotes': 'Hide notes',
      'update.noNotes': '(this release has no notes)',
      'update.openRelease': 'Open release page',
      'update.ignore': 'Ignore this version',
      'update.dismiss': 'Dismiss',
      'update.how':
        'To update: use the plugin page in the market, or run dsh plugin add dsh-open-artifacts (for GitHub installs: github:wuuuuu123-32/dsh-open-artifacts).',
    };

    let dict = DICT_ZH;
    function t(key, params) {
      let text = dict[key] ?? DICT_ZH[key] ?? key;
      if (params) {
        for (const k of Object.keys(params)) text = text.split('{' + k + '}').join(String(params[k]));
      }
      return text;
    }

    // ────────────────────── 请求状态（菜单项/标题按钮写，弹窗读） ──────────────────────

    let activeRequest = null;
    const subscribers = new Set();

    function setActiveRequest(next) {
      activeRequest = next;
      for (const fn of subscribers) {
        try {
          fn(next);
        } catch (e) {
          console.warn('[open-artifacts] subscriber failed', e);
        }
      }
    }

    function useActiveRequest() {
      const [value, setValue] = React.useState(activeRequest);
      React.useEffect(() => {
        const fn = (next) => setValue(next);
        subscribers.add(fn);
        setValue(activeRequest);
        return () => {
          subscribers.delete(fn);
        };
      }, []);
      return value;
    }

    // ────────────────────────────── host 通信 ──────────────────────────────

    async function getJson(url) {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      let data = {};
      try {
        data = await res.json();
      } catch (e) {
        data = {};
      }
      return { ok: res.ok, status: res.status, data };
    }

    async function postJson(url, body) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      let data = {};
      try {
        data = await res.json();
      } catch (e) {
        data = {};
      }
      return { ok: res.ok, status: res.status, data };
    }

    async function openPath(sessionId, target) {
      try {
        const r = await postJson(ROUTE + '/open', { sessionId, path: target });
        const ok = r.ok && r.data && r.data.ok !== false;
        return { ok, message: (r.data && r.data.error) || 'HTTP ' + r.status };
      } catch (e) {
        return { ok: false, message: (e && e.message) || String(e) };
      }
    }

    async function createDir(sessionId, name) {
      try {
        const r = await postJson(ROUTE + '/mkdir', { sessionId, name });
        const ok = r.ok && r.data && r.data.ok !== false;
        return {
          ok,
          message: (r.data && r.data.error) || 'HTTP ' + r.status,
          path: r.data && r.data.path,
          existed: !!(r.data && r.data.existed),
        };
      } catch (e) {
        return { ok: false, message: (e && e.message) || String(e) };
      }
    }

    /** 从会话标题里抠一个候选目录名；纯中文标题抠不出来就返回空串，让人自己填 */
    function suggestName(title) {
      if (!title || typeof title !== 'string') return '';
      const words = title.toLowerCase().match(/[a-z][a-z0-9]{1,}/g) || [];
      const skip = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'dsh', 'plugin']);
      const picked = [];
      for (const w of words) {
        if (skip.has(w) || picked.includes(w)) continue;
        picked.push(w);
        if (picked.length >= 3) break;
      }
      return picked.join('-').slice(0, 48).replace(/-+$/, '');
    }

    /** 把 host 给的清单摊平成可选项 */
    function candidatesOf(data) {
      const out = [];
      for (const d of data.dirs || []) {
        out.push({ name: d.name, path: d.path, count: d.fileCount, note: '' });
      }
      if ((data.rootFiles || []).length > 0 && data.cwd) {
        out.push({ name: data.cwd, path: data.cwd, count: data.rootFiles.length, note: t('dialog.rootNote') });
      }
      for (const d of data.artifactRoots || []) {
        out.push({ name: d.name, path: d.path, count: d.fileCount, note: t('dialog.artifactNote') });
      }
      for (const d of data.outsideDirs || []) {
        out.push({ name: d.name, path: d.path, count: d.fileCount, note: t('dialog.outsideNote') });
      }
      return out;
    }

    /** 点菜单/按钮后的主流程 */
    async function openArtifacts(sessionId, title) {
      if (!sessionId) return;
      setActiveRequest({ kind: 'loading', sessionId, title: title || '' });

      let res;
      try {
        res = await getJson(ROUTE + '/scan?sessionId=' + encodeURIComponent(sessionId));
      } catch (e) {
        setActiveRequest({ kind: 'error', sessionId, message: (e && e.message) || String(e) });
        return;
      }
      if (!res.ok || !res.data || res.data.ok === false) {
        const msg = (res.data && res.data.error) || 'HTTP ' + res.status;
        setActiveRequest({ kind: 'error', sessionId, message: msg });
        return;
      }

      const data = res.data;
      const candidates = candidatesOf(data);
      if (candidates.length === 0) {
        setActiveRequest({ kind: 'empty', sessionId, title: title || '', data });
        return;
      }
      if (candidates.length === 1) {
        setActiveRequest(null);
        const r = await openPath(sessionId, candidates[0].path);
        if (!r.ok) setActiveRequest({ kind: 'error', sessionId, message: r.message });
        return;
      }
      setActiveRequest({ kind: 'choose', sessionId, title: title || '', data, candidates });
    }

    async function doOpen(sessionId, target) {
      setActiveRequest(null);
      const r = await openPath(sessionId, target);
      if (!r.ok) setActiveRequest({ kind: 'error', sessionId, message: r.message });
    }

    function closeMenu(setMenuOpen) {
      try {
        if (typeof setMenuOpen === 'function') setMenuOpen(false);
      } catch (e) {
        console.warn('[open-artifacts] closeMenu failed', e);
      }
    }

    // ────────────────────────────── 组件 ──────────────────────────────

    const FolderIcon = P.IconFolderOpenOutlineRegular || P.IconFolderOutlineRegular;

    function OpenArtifactsMenuItem(props) {
      const sessionId = props.sessionId;
      const title = props.displayTitle;
      const setMenuOpen = props.useMenuOpenState ? props.useMenuOpenState()[1] : () => {};

      const onSelect = () => {
        closeMenu(setMenuOpen);
        openArtifacts(sessionId, title);
      };

      return React.createElement(
        P.MenuItemButton,
        {
          icon: FolderIcon ? React.createElement(FolderIcon, { size: 14 }) : undefined,
          onSelect: onSelect,
        },
        t('menu.open')
      );
    }

    function OpenArtifactsHeaderAction(props) {
      const sessionId = props.sessionId;
      const onClick = () => openArtifacts(sessionId, null);

      return React.createElement(
        P.Button,
        { variant: 'outline', onClick: onClick, title: t('menu.open') },
        FolderIcon ? React.createElement(FolderIcon, { size: 14 }) : null,
        React.createElement('span', { style: { marginLeft: FolderIcon ? 6 : 0 } }, t('action.open'))
      );
    }

    function optionRow(key, label, sub, onClick) {
      return React.createElement(
        'button',
        {
          key: key,
          type: 'button',
          onClick: onClick,
          style: {
            display: 'block',
            width: '100%',
            textAlign: 'left',
            padding: '8px 10px',
            marginBottom: 6,
            background: 'transparent',
            border: '1px solid rgba(128,128,128,.35)',
            borderRadius: 6,
            cursor: 'pointer',
            color: 'inherit',
            font: 'inherit',
          },
        },
        React.createElement('div', { style: { fontWeight: 600 } }, label),
        sub
          ? React.createElement(
              'div',
              { style: { fontSize: 12, color: '#888', marginTop: 2, wordBreak: 'break-all' } },
              sub
            )
          : null
      );
    }

    function ArtifactsOverlay() {
      const request = useActiveRequest();
      const [name, setName] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [formErr, setFormErr] = React.useState('');
      const reqKind = request && request.kind;
      const reqTitle = request && request.title;

      // 每次进入「新建」都重置表单，并预填一个从标题里抠出来的候选名
      React.useEffect(() => {
        if (reqKind === 'create') {
          setName(suggestName(reqTitle) || '');
          setFormErr('');
          setBusy(false);
        }
      }, [reqKind, reqTitle]);

      if (!request) return null;

      const close = () => setActiveRequest(null);

      const submitCreate = async () => {
        const dirName = (name || '').trim();
        if (!dirName) {
          setFormErr(t('dialog.createEmpty'));
          return;
        }
        setBusy(true);
        const r = await createDir(request.sessionId, dirName);
        setBusy(false);
        if (!r.ok) {
          setFormErr(r.message || t('dialog.error'));
          return;
        }
        setActiveRequest(null);
        const o = await openPath(request.sessionId, r.path);
        if (!o.ok) setActiveRequest({ kind: 'error', sessionId: request.sessionId, message: o.message });
      };

      const body = [];
      let title = t('dialog.title');
      let description;

      if (request.kind === 'loading') {
        body.push(React.createElement('div', { key: 'loading', style: { color: '#888' } }, t('dialog.loading')));
      } else if (request.kind === 'error') {
        body.push(
          React.createElement(
            'div',
            { key: 'error', role: 'alert', style: { color: '#c00' } },
            t('dialog.error') + '：' + (request.message || '')
          )
        );
      } else if (request.kind === 'empty') {
        title = t('dialog.emptyTitle');
        body.push(React.createElement('div', { key: 'empty' }, t('dialog.empty')));
        const root = request.data && request.data.artifactRoot;
        if (root) {
          body.push(
            optionRow('artifactRoot', t('dialog.openArtifactRoot'), root, () => doOpen(request.sessionId, root))
          );
        }
        const cwd = request.data && request.data.cwd;
        if (cwd) {
          body.push(
            optionRow('workspace', t('dialog.openWorkspace'), cwd, () => doOpen(request.sessionId, cwd))
          );
        }
        if (request.data && request.data.error) {
          body.push(
            React.createElement('div', { key: 'err', style: { marginTop: 8, fontSize: 12, color: '#888' } }, request.data.error)
          );
        }
      } else if (request.kind === 'choose') {
        title = t('dialog.chooseTitle');
        description = t('dialog.chooseDesc');
        for (const c of request.candidates) {
          const sub = (c.note ? c.note + ' · ' : '') + t('dialog.files', { count: c.count }) + ' · ' + c.path;
          body.push(
            optionRow(c.path, c.name, sub, () => doOpen(request.sessionId, c.path))
          );
        }
      } else if (request.kind === 'create') {
        title = t('dialog.createTitle');
        description = t('dialog.createDesc');
        body.push(
          React.createElement('input', {
            key: 'name',
            value: name,
            autoFocus: true,
            spellCheck: false,
            placeholder: t('dialog.createPlaceholder'),
            disabled: busy,
            onChange: (e) => {
              setName(e.currentTarget.value);
              setFormErr('');
            },
            onKeyDown: (e) => {
              if (e.key === 'Enter' && !busy) submitCreate();
            },
            style: {
              width: '100%',
              boxSizing: 'border-box',
              padding: '7px 9px',
              background: 'transparent',
              border: '1px solid rgba(128,128,128,.45)',
              borderRadius: 6,
              color: 'inherit',
              font: 'inherit',
            },
          })
        );
        if (formErr) {
          body.push(
            React.createElement(
              'div',
              { key: 'ferr', role: 'alert', style: { color: '#c00', fontSize: 12, marginTop: 6 } },
              formErr
            )
          );
        }
        body.push(
          React.createElement(
            'div',
            { key: 'hint', style: { fontSize: 12, color: '#888', marginTop: 8 } },
            t('dialog.createHint')
          )
        );
      }

      return React.createElement(
        P.Modal,
        {
          open: true,
          onClose: close,
          closeLabel: t('dialog.close'),
          title: title,
          description: description,
          footer: React.createElement(
            React.Fragment,
            null,
            request.kind === 'empty' || request.kind === 'choose'
              ? React.createElement(
                  P.Button,
                  {
                    key: 'create',
                    variant: 'outline',
                    onClick: () => setActiveRequest(Object.assign({}, request, { kind: 'create' })),
                  },
                  t('dialog.create')
                )
              : null,
            request.kind === 'create'
              ? React.createElement(
                  P.Button,
                  { key: 'ok', onClick: submitCreate, disabled: busy },
                  busy ? t('dialog.creating') : t('dialog.createConfirm')
                )
              : null,
            React.createElement(P.Button, { key: 'close', variant: 'outline', onClick: close }, t('dialog.close'))
          ),
        },
        body
      );
    }

    // ────────────────────────────── 更新提示 ──────────────────────────────
    //
    // host 启动后会去 GitHub Releases 查一次最新版本（缓存 6 小时），
    // 这里挂载时问一次，有新版本就在右下角浮一张卡片。
    // 「忽略这个版本」记在 localStorage 里：同一个版本不再打扰，出了更新的版本还会再提示。

    const DISMISS_KEY = 'dsh-open-artifacts.update.dismissed';

    let updateState = null;
    const updateSubscribers = new Set();

    function setUpdateState(next) {
      updateState = next;
      for (const fn of updateSubscribers) {
        try {
          fn(next);
        } catch (e) {
          console.warn('[open-artifacts] update subscriber failed', e);
        }
      }
    }

    function useUpdateState() {
      const [value, setValue] = React.useState(updateState);
      React.useEffect(() => {
        const fn = (next) => setValue(next);
        updateSubscribers.add(fn);
        setValue(updateState);
        return () => {
          updateSubscribers.delete(fn);
        };
      }, []);
      return value;
    }

    /** 问一次 host 有没有新版本；查不到就什么都不做（查更新失败不该打扰人） */
    async function loadUpdate() {
      try {
        const r = await getJson(ROUTE + '/update');
        if (r.ok && r.data) setUpdateState(r.data);
      } catch (e) {
        console.warn('[open-artifacts] update check failed', e);
      }
    }

    function readDismissed() {
      try {
        return window.localStorage.getItem(DISMISS_KEY) || '';
      } catch (e) {
        return '';
      }
    }

    /** 该不该把卡片露出来（纯函数，单测直接打这个） */
    function shouldShowUpdate(state, dismissed) {
      if (!state || state.hasUpdate !== true) return false;
      const latest = state.latestVersion;
      if (!latest) return false;
      return String(dismissed || '') !== String(latest);
    }

    function rememberDismissed(version) {
      try {
        window.localStorage.setItem(DISMISS_KEY, String(version || ''));
      } catch (e) {
        console.warn('[open-artifacts] dismiss failed', e);
      }
    }

    const UPDATE_CARD_STYLE = {
      position: 'fixed',
      right: 16,
      bottom: 16,
      zIndex: 2147483000,
      width: 320,
      maxWidth: 'calc(100vw - 32px)',
      boxSizing: 'border-box',
      padding: '10px 12px',
      background: 'rgba(32,32,34,.96)',
      color: '#f2f2f2',
      border: '1px solid rgba(255,255,255,.16)',
      borderRadius: 10,
      boxShadow: '0 10px 28px rgba(0,0,0,.35)',
      font: '13px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif',
    };

    function UpdateNotice() {
      const state = useUpdateState();
      const [hidden, setHidden] = React.useState(false);
      const [expanded, setExpanded] = React.useState(false);

      React.useEffect(() => {
        loadUpdate();
      }, []);

      if (hidden || !shouldShowUpdate(state, readDismissed())) return null;

      const children = [
        React.createElement(
          'div',
          { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 8 } },
          React.createElement('div', { style: { fontWeight: 600, flex: 1 } }, t('update.title')),
          React.createElement(
            'button',
            {
              type: 'button',
              title: t('update.dismiss'),
              onClick: () => setHidden(true),
              style: {
                background: 'transparent',
                border: 0,
                color: '#bbb',
                cursor: 'pointer',
                fontSize: 16,
                lineHeight: 1,
                padding: 2,
              },
            },
            '×'
          )
        ),
        React.createElement(
          'div',
          { key: 'ver', style: { fontSize: 12, color: '#b9b9bd', marginTop: 2, wordBreak: 'break-all' } },
          t('update.version', { from: state.currentVersion || '?', to: state.latestVersion })
        ),
      ];

      if (expanded) {
        children.push(
          React.createElement(
            'pre',
            {
              key: 'notes',
              style: {
                margin: '8px 0 0',
                maxHeight: 200,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontSize: 12,
                color: '#dcdce0',
                background: 'rgba(0,0,0,.25)',
                borderRadius: 6,
                padding: '6px 8px',
                fontFamily: 'inherit',
              },
            },
            state.notes && String(state.notes).trim() ? String(state.notes).trim() : t('update.noNotes')
          )
        );
      }

      children.push(
        React.createElement(
          'div',
          { key: 'acts', style: { display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' } },
          React.createElement(
            P.Button,
            { variant: 'outline', onClick: () => setExpanded((v) => !v) },
            expanded ? t('update.hideNotes') : t('update.showNotes')
          ),
          state.releaseUrl
            ? React.createElement(
                P.Button,
                {
                  variant: 'outline',
                  onClick: () => {
                    try {
                      window.open(state.releaseUrl, '_blank', 'noopener');
                    } catch (e) {
                      console.warn('[open-artifacts] open release failed', e);
                    }
                  },
                },
                t('update.openRelease')
              )
            : null,
          React.createElement(
            P.Button,
            {
              variant: 'outline',
              onClick: () => {
                rememberDismissed(state.latestVersion);
                setHidden(true);
              },
            },
            t('update.ignore')
          )
        ),
        React.createElement('div', { key: 'how', style: { fontSize: 11, color: '#a9a9ae', marginTop: 8 } }, t('update.how'))
      );

      return React.createElement('div', { style: UPDATE_CARD_STYLE }, children);
    }

    // ────────────────────────────── 注册 ──────────────────────────────

    function apply(ctx) {
      // 语言跟随界面；locale 服务不在时用内置字典
      try {
        const locale = ctx.get ? ctx.get('locale') : null;
        if (typeof locale === 'function') {
          const svc = locale();
          if (svc && typeof svc.register === 'function') {
            ctx.effect(() => svc.register(NS, { zh: DICT_ZH, en: DICT_EN }));
          }
        } else if (locale && typeof locale.register === 'function') {
          ctx.effect(() => locale.register(NS, { zh: DICT_ZH, en: DICT_EN }));
        }
      } catch (e) {
        console.warn('[open-artifacts] locale registration skipped', e);
      }

      // 会话行「⋯」菜单：排在内置 archive(400) 之后
      ctx.slots.inject(MENU_SLOT, function* () {
        yield ctx.slots.register(
          { name: MENU_SLOT, id: 'open-artifacts:menu', order: 450, locale: NS },
          OpenArtifactsMenuItem
        );
      });

      // 会话标题旁的动作
      ctx.slots.inject(HEADER_SLOT, function* () {
        yield ctx.slots.register(
          { name: HEADER_SLOT, id: 'open-artifacts:header', order: 150, locale: NS },
          OpenArtifactsHeaderAction
        );
      });

      // 多目录时的选择弹窗 / 出错提示
      ctx.slots.inject(OVERLAY_SLOT, function* () {
        yield ctx.slots.register({ name: OVERLAY_SLOT, id: 'open-artifacts:overlay', locale: NS }, ArtifactsOverlay);
      });

      // 有新版本时的右下角提示
      ctx.slots.inject(OVERLAY_SLOT, function* () {
        yield ctx.slots.register(
          { name: OVERLAY_SLOT, id: 'open-artifacts:update-notice', locale: NS },
          UpdateNotice
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    // 给离线单测留的口子（客户端没有构建步骤，测试直接 stub 掉 window / require 加载本文件）
    exports.__internals = { shouldShowUpdate, readDismissed, rememberDismissed, UpdateNotice, setUpdateState };
    return module.exports;
  },
});
