/**
 * Browser half of the "delete session" bundle.
 *
 * Two surfaces, one recycle bin:
 *
 * - one row in `sidebar.workspaces.session.menu.item` — the same list the
 *   shipped Pin / Rename / Fork / Archive rows occupy — whose confirmation
 *   MOVES the session into the Host's recycle bin;
 * - one section in `settings.section` listing what the bin holds, with
 *   restore, permanent delete and empty actions, and the retention window.
 *
 * The page loads this file as a CLASSIC SCRIPT, never as an ES module: ESM
 * syntax here is a parse error that fails the whole web boot. It must stay a
 * plain script that only calls `window.__ModuleLoader__.load`.
 *
 * API surface is also deliberately limited to what a local Client plugin is
 * proven to support — `ctx.effect`, `ctx.locale.register` and
 * `ctx.slots.inject` / `ctx.slots.register` — and both services it reads are
 * declared in the returned `inject` list, because a Cordis context THROWS on
 * any undeclared service access (see the returned object's comment). React
 * comes from the browser module table, no Harness Client package is imported,
 * styles use theme tokens and live inside the components, and every
 * user-visible string goes through the locale seat.
 */
window.__ModuleLoader__.load({
  id: '@cckbc/dsh-session-recycle-bin',
  factory(require) {
    const React = require('react');
    /*
     * The host's own UI primitives, the same module its shipped session-menu
     * rows use. `RenameSessionMenuItem` and `ForkSessionMenuItem` are written as
     * `MenuItemButton` with an icon and a label, and `MenuItemButton` brings the
     * row's metrics, its icon seat, its label ellipsis AND its `danger` styling
     * with it — so rendering this row through it is what makes the row match by
     * construction instead of by imitation.
     *
     * Resolved LAZILY, on first render: requiring eagerly in the factory would
     * freeze a `null` result if the module were not in the table yet, silently
     * pinning the plugin to its fallback for the whole session. A failed lookup
     * is not cached either, so a later render retries.
     */
    let primitives = null;
    let primitivesResolved = false;
    function loadPrimitives() {
      if (primitivesResolved) return primitives;
      try {
        primitives = require('@deepseek-ai/dsh-client-ui-primitives');
        primitivesResolved = true;
      } catch (error) {
        console.warn('[delete-session] UI primitives unavailable, using the local row', error);
      }
      return primitives;
    }

    /** Locale namespace owned by this plugin. */
    const NS = 'plugin.dshDeleteSession';

    /** Host route implemented by this bundle's Host half. */
    const ENDPOINT = '/plugins/dsh-delete-session/session';

    /** Menu position: after the shipped archive row (order 400). */
    const MENU_ORDER = 450;

    /** Settings position: after the shipped Agent presets row (order 20). */
    const SETTINGS_ORDER = 25;

    /** Row-action position: after the shipped Pin hover button (order 200). */
    const ROW_ACTION_ORDER = 250;

    /**
     * The plugin's own translator, bound in `apply` from
     * `ctx.locale.bind(NS)`. Components must NOT read a `t` prop: the host
     * builds that seat only for slots whose owner passes one down (the
     * settings shell does; the sidebar session menu does not), and a component
     * that calls an absent `t` throws during render, where the slot error
     * boundary silently abdicates the entry — the row just never appears.
     * An own-bound translator is what every shipped client plugin does.
     */
    let translate = null;

    /**
     * The client context, kept only to reach the browser's own Session
     * controller when a delete takes the Session the main view is showing.
     * Optional services are read with `ctx.get(name)`, never `ctx.<name>`:
     * Cordis throws on a property the plugin did not declare in `inject`.
     */
    let clientContext = null;

    /** Translate one key; before `apply` binds the seat, the key is the text. */
    function text(key, params) {
      if (translate === null) return key;
      return translate(key, params);
    }

    const zh = {
      'menu.delete': '删除会话',
      'menu.deleting': '删除中…',
      'menu.deleted': '该会话已删除',
      'confirm.title': '删除会话',
      'confirm.desc': '「{title}」将移入回收站，{days} 天后自动彻底删除。期间可在 设置 → 回收站 里还原。',
      'confirm.action': '移入回收站',
      'confirm.busy': '处理中…',
      'confirm.skip': '下次不再提示',
      'cancel': '取消',
      'toast.trashed': '已移入回收站，该行已从侧边栏隐藏（可在 设置 → 回收站 还原）',
      'toast.discarded': '这个会话已经没有本地日志了，已从侧边栏移除（重启应用后彻底消失）',
      'toast.restored': '已还原会话「{title}」，已重新出现在列表中',
      'toast.restoredPending': '已还原会话「{title}」，重启应用后会回到列表',
      'toast.purged': '已彻底删除',
      'toast.emptied': '回收站已清空',
      'toast.failed': '操作失败',
      'toast.missing': '这个会话没有本地日志可删除',
      'toast.notTrashed': '这个会话已经不在回收站里了',
      'toast.noWorkspace': '这条记录没记住它原来在哪个工作区，无法还原',
      'toast.busy': '会话日志仍在使用中，请先停止或关闭该会话',
      'toast.unauthorized': '没有权限执行该操作，请重新加载页面后重试',
      'recycle.nav': '回收站',
      'recycle.title': '回收站',
      'recycle.intro': '删除的会话会先放在这里，默认保留 {days} 天，到期后自动彻底删除。日志文件在此期间仍完整保存在本机。',
      'recycle.loading': '正在读取回收站…',
      'recycle.empty': '回收站是空的。',
      'recycle.columnSession': '会话',
      'recycle.columnWorkspace': '工作区',
      'recycle.columnTrashed': '删除时间',
      'recycle.columnLeft': '剩余',
      'recycle.daysLeft': '{days} 天',
      'recycle.expired': '即将清理',
      'recycle.restore': '还原',
      'recycle.purge': '彻底删除',
      'recycle.emptyBin': '清空回收站',
      'recycle.refresh': '刷新',
      'recycle.working': '处理中…',
      'recycle.askPurge': '确认彻底删除',
      'recycle.askEmpty': '确认清空',
      'recycle.reload': '重载页面',
      'recycle.reloadHint': '删除的会话会立刻从侧边栏隐藏；还原会把它挂回应用的工作区注册表，并让页面重新读取会话清单，所以通常不需要重启应用。只有日志里没有记下工作目录的会话例外：应用自己不会列它，重启也一样。',
      'recycle.total': '共 {count} 个会话 · 占用 {size}',
      'recycle.ask': '移入回收站前先确认',
      'recycle.errorLoad': '读取回收站失败',
      'empty': '（无标题）',
    };

    const en = {
      'menu.delete': 'Delete session',
      'menu.deleting': 'Deleting…',
      'menu.deleted': 'This session is already deleted',
      'confirm.title': 'Delete session',
      'confirm.desc': '“{title}” moves to the recycle bin and is permanently deleted after {days} days. Restore it meanwhile from Settings → Recycle bin.',
      'confirm.action': 'Move to recycle bin',
      'confirm.busy': 'Working…',
      'confirm.skip': "Don't ask again",
      'cancel': 'Cancel',
      'toast.trashed': 'Moved to the recycle bin — its row is hidden from the sidebar (restore it in Settings → Recycle bin)',
      'toast.discarded': 'That session has no log left; its row was removed (the app forgets it after a restart)',
      'toast.restored': 'Restored “{title}” — it is back in the list',
      'toast.restoredPending': 'Restored “{title}”; it returns to the list when the app restarts',
      'toast.purged': 'Permanently deleted',
      'toast.emptied': 'Recycle bin emptied',
      'toast.failed': 'The operation failed',
      'toast.missing': 'This session has no stored log to delete',
      'toast.notTrashed': 'That session is no longer in the recycle bin',
      'toast.noWorkspace': 'This entry does not remember its workspace, so it cannot be restored',
      'toast.busy': 'The session log is still in use; stop or close that session first',
      'toast.unauthorized': 'Not allowed; reload the page and retry',
      'recycle.nav': 'Recycle bin',
      'recycle.title': 'Recycle bin',
      'recycle.intro': 'Deleted sessions wait here and are permanently removed after {days} days. Their log files stay on this machine until then.',
      'recycle.loading': 'Reading the recycle bin…',
      'recycle.empty': 'The recycle bin is empty.',
      'recycle.columnSession': 'Session',
      'recycle.columnWorkspace': 'Workspace',
      'recycle.columnTrashed': 'Deleted',
      'recycle.columnLeft': 'Left',
      'recycle.daysLeft': '{days} d',
      'recycle.expired': 'due now',
      'recycle.restore': 'Restore',
      'recycle.purge': 'Delete forever',
      'recycle.emptyBin': 'Empty recycle bin',
      'recycle.refresh': 'Refresh',
      'recycle.working': 'Working…',
      'recycle.askPurge': 'Confirm permanent delete',
      'recycle.askEmpty': 'Confirm empty',
      'recycle.reload': 'Reload page',
      'recycle.reloadHint': 'A deleted session leaves the sidebar at once. A restore re-attaches it to the app’s workspace registry and makes the page re-read its session list, so a restart is usually unnecessary. The exception is a session whose log recorded no working directory: the app itself will not list it, restart or not.',
      'recycle.total': '{count} session(s) · {size}',
      'recycle.ask': 'Confirm before moving to the recycle bin',
      'recycle.errorLoad': 'Could not read the recycle bin',
      'empty': '(untitled)',
    };

    /**
     * Destructive RESTYLING of the host's own menu row, expressed through the
     * host's class names.
     *
     * The row wears the host's real `item` / `itemIcon` / `itemLabel` classes,
     * so every metric that makes it sit correctly in the shipped Pin / Rename /
     * Fork / Archive list comes from the host's stylesheet — this plugin adds
     * only the danger colour, and cannot drift from a hand-copied duplicate.
     * `HOST_ITEM` / `HOST_ICON` are substituted with the hashed class names read
     * off a live host row, because those names change between builds.
     */
    const HOST_OVERRIDES = [
      // Destructive rows in the host are red through and through. Its own
      // workspace menu marks its delete entry `danger: true`, and the cell's
      // rule colours the row AND its glyph:
      //   `.danger, .danger .itemIcon{color:var(--dsw-alias-state-error-primary)}`
      //   `.danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}`
      // This row is a destructive session action, so it follows the same rule
      // rather than inventing a "red label, grey glyph" variant.
      '.HOST_ITEM{color:var(--dsw-alias-state-error-primary)}',
      '.HOST_ITEM .HOST_ICON{color:var(--dsw-alias-state-error-primary)}',
      '.HOST_ITEM:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}',
      '.HOST_ITEM:focus-visible:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);outline:none}',
      // A row whose session is already gone is not actionable, so it drops the
      // danger tone exactly as the host drops a disabled row's emphasis.
      '.HOST_ITEM:disabled{color:var(--dsw-alias-label-tertiary)}',
      '.HOST_ITEM:disabled .HOST_ICON{color:var(--dsw-alias-label-tertiary)}',
    ].join('');

    /*
     * This plugin's own surfaces: the row-action hover button, the confirmation
     * card, the toast and the settings page. The menu row deliberately has no
     * metric rules of its own — it borrows the host's.
     */
    const CSS = [
      '.dsds_itemWrap{position:relative}',
      // Fallback metrics only. As soon as a host-rendered row has been seen,
      // the row wears the host's own item / itemIcon / itemLabel classes and
      // these rules no longer decide anything — they exist so the row can never
      // be rendered bare if it appears before that first sighting.
      '.dsds_item{box-sizing:border-box;width:100%;color:var(--dsw-alias-label-primary);',
      'background:0 0;border:none;border-radius:var(--dsw-radius-md,8px);cursor:pointer;',
      'font:inherit;font-size:13px;line-height:20px;text-align:start;align-items:center;gap:6px;',
      'min-height:34px;padding:6px 8px;display:flex}',
      '.dsds_item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsds_item:focus-visible:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);outline:none}',
      '.dsds_item:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
      '.dsds_itemIcon{width:14px;height:14px;color:var(--dsw-alias-label-tertiary);flex:none;',
      'justify-content:center;align-items:center;display:inline-flex}',
      '.dsds_itemIcon svg{width:14px;height:14px;display:block}',
      '.dsds_itemLabel{text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;overflow:hidden}',
      // The hover button is the host's row action, copied from its own rule so
      // it occupies exactly the same box as the shipped Archive and Pin buttons
      // beside it:
      //   `.iconButton{width:16px;height:16px;padding:0;flex:none;
      //     justify-content:center;align-items:center;display:inline-flex}`
      // Their container spaces them with `gap:10px`, so any other width — this
      // was 22px — makes the run of buttons look unevenly spaced.
      '.dsds_iconButton{box-sizing:border-box;width:16px;height:16px;padding:0;border:none;',
      'background:0 0;border-radius:var(--dsw-radius-xs,4px);color:var(--dsw-alias-label-tertiary);',
      'cursor:pointer;flex:none;justify-content:center;align-items:center;display:inline-flex}',
      // A destructive action states itself on hover, matching the danger tone
      // the row menu uses for the same action.
      '.dsds_iconButton:hover:not(:disabled){color:var(--dsw-alias-state-error-primary)}',
      '.dsds_iconButton:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l2,rgba(127,127,127,.4))}',
      '.dsds_iconButton:disabled{opacity:.4;cursor:default}',
      '.dsds_iconButton svg{width:14px;height:14px;display:block}',
      '.dsds_layer{position:fixed;inset:0;z-index:60;background:var(--dsw-alias-bg-mask,rgba(0,0,0,.45));',
      'justify-content:center;align-items:center;padding:24px;display:flex}',
      '.dsds_card{box-sizing:border-box;width:min(420px,100%);max-width:100%;',
      'background:var(--dsw-alias-bg-elevated,var(--dsw-alias-bg-base));',
      'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.24));',
      'border-radius:var(--dsw-radius-lg,12px);box-shadow:0 16px 48px rgba(0,0,0,.28);',
      'padding:20px;display:flex;flex-direction:column;gap:10px;color:var(--dsw-alias-label-primary)}',
      '.dsds_cardTitle{font-size:16px;font-weight:600;line-height:24px;margin:0}',
      '.dsds_cardDesc{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;margin:0}',
      '.dsds_footer{justify-content:flex-end;gap:8px;margin-top:4px;display:flex}',
      '.dsds_button{border-radius:var(--dsw-radius-md,8px);cursor:pointer;font:inherit;font-size:13px;',
      'line-height:20px;padding:5px 12px;background:0 0;',
      'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));color:var(--dsw-alias-label-primary)}',
      '.dsds_button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsds_button:disabled{opacity:.6;cursor:default}',
      // Armed state for the two-step confirmations: the same error colour the
      // host uses for destructive controls, so "click again" reads as final.
      '.dsds_buttonDanger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.dsds_buttonDanger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}',
      '.dsds_toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:70;',
      'max-width:min(520px,calc(100vw - 48px));background:var(--dsw-alias-bg-elevated,var(--dsw-alias-bg-base));',
      'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.24));border-radius:var(--dsw-radius-md,8px);',
      'box-shadow:0 8px 28px rgba(0,0,0,.24);color:var(--dsw-alias-label-primary);font-size:13px;',
      'line-height:20px;padding:8px 14px;text-align:center}',
      // Settings page: same shape and spacing as the shipped settings sections.
      '.dsds_section{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}',
      '.dsds_sectionTitle{margin:0;font-size:18px;font-weight:600;line-height:26px}',
      '.dsds_sectionIntro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:20px}',
      '.dsds_toolbar{justify-content:flex-end;align-items:center;gap:8px;display:flex}',
      '.dsds_table{border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));',
      'border-radius:var(--dsw-radius-xl,12px);background:var(--dsw-alias-settings-card-fill,transparent);',
      'overflow:hidden}',
      /*
       * Every row is its own grid, so the ONLY thing keeping the header in step
       * with the data is a template whose tracks never depend on what a row
       * contains. The trailing `auto` track did exactly that: the header's
       * action cell is empty while a data row's holds two buttons, so each row
       * split a different amount of free space between the fr tracks. Measured
       * in the running app (1282px-wide window, 150% display scaling), the
       * header's first column resolved to 179px and a data row's to 117px — the
       * header's 工作区 sat 62px to the right of the 工作区 values underneath it.
       * Fixed lengths and minmax(0,Nfr) tracks resolve from the table's width
       * alone, so every row lands on the same columns.
       *
       * The lengths come from the strings they hold, measured at these exact
       * sizes: 110px for a full "2026-10-04 17:11" stamp (101px), 56px for the
       * widest 剩余 value ("即将清理", 52px), 166px for the two row buttons in
       * their widest state ("确认彻底删除" beside "还原", 162px).
       */
      '.dsds_row{box-sizing:border-box;display:grid;align-items:center;gap:12px;padding:10px 14px;',
      'font-size:13px;line-height:20px;',
      'grid-template-columns:minmax(0,2.2fr) minmax(0,1.2fr) 110px 56px 166px}',
      '.dsds_row+.dsds_row{border-top:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2))}',
      '.dsds_rowHead{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:600}',
      '.dsds_rowHead>span{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}',
      '.dsds_cellTitle{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}',
      '.dsds_cellMuted{color:var(--dsw-alias-label-secondary);text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}',
      // A timestamp that wrapped to a second line made the whole row taller and
      // dragged every other column of that row out of step with the header.
      '.dsds_cellNumber{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;',
      'text-overflow:ellipsis;white-space:nowrap;overflow:hidden}',
      // Wrapping is the fallback for a locale whose labels outgrow the 166px
      // track (english needs 186px): two stacked right-aligned buttons instead
      // of a button painted over the column beside it.
      '.dsds_rowActions{justify-content:flex-end;flex-wrap:wrap;gap:6px;display:flex}',
      '.dsds_error{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-secondary));font-size:13px;margin:0}',
      '.dsds_note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:0}',
      // A checkbox label, copied from the host's own `.checkbox`: 16px box, the
      // brand accent, the label's own line box beside it.
      '.dsds_check{align-items:center;gap:8px;color:var(--dsw-alias-label-primary);cursor:pointer;',
      'font-size:13px;line-height:20px;display:flex}',
      '.dsds_check input{flex:0 0 auto;width:16px;height:16px;margin:0;',
      'accent-color:var(--dsw-alias-brand-primary);cursor:inherit}',
      '.dsds_check input:focus-visible{outline:2px solid var(--dsw-alias-border-l3,rgba(127,127,127,.4));outline-offset:1px}',
    ].join('');

    /**
     * Ids whose sidebar row is hidden because their log sits in the bin.
     *
     * The Host builds its session registry at boot and exposes no way to drop
     * one entry, so a deleted row has to be hidden from the page instead. That
     * hiding MUST survive a reload: the host's registry still lists the session
     * until the app restarts, so an in-memory tombstone would let a deleted row
     * reappear after every refresh. The ledger is therefore persisted, and the
     * recycle-bin listing reconciles it on every load.
     */
    const TOMBSTONE_KEY = 'dsh-delete-session:tombstones';

    /** Read the persisted tombstone ledger, tolerating junk and no storage. */
    function readTombstones() {
      try {
        const raw = window.localStorage.getItem(TOMBSTONE_KEY);
        if (raw === null) return new Set();
        const parsed = JSON.parse(raw);
        return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []);
      } catch (error) {
        return new Set();
      }
    }

    /** Persist the tombstone ledger; storage may be unavailable or full. */
    function writeTombstones(ids) {
      try {
        window.localStorage.setItem(TOMBSTONE_KEY, JSON.stringify([...ids]));
      } catch (error) {
        console.warn('[delete-session] could not persist the deleted-row ledger', error);
      }
    }

    let removed = readTombstones();

    /**
     * Key holding "stop asking me before a delete".
     *
     * Deleting only moves a session into the bin, and the row menu is the user's
     * own click, so the confirmation is a courtesy rather than a safety net —
     * worth offering once, not on every row forever. Absent key means ask; the
     * key is removed again when the user turns the question back on, so a reset
     * of storage restores the cautious default.
     */
    const ASK_KEY = 'dsh-delete-session:ask';

    /** Whether the confirmation dialog still stands between a click and the bin. */
    function readAsk() {
      try {
        return window.localStorage.getItem(ASK_KEY) !== 'skip';
      } catch (error) {
        return true;
      }
    }

    /** Persist the preference; storage may be unavailable. */
    function writeAsk(ask) {
      try {
        if (ask) window.localStorage.removeItem(ASK_KEY);
        else window.localStorage.setItem(ASK_KEY, 'skip');
      } catch (error) {
        console.warn('[delete-session] could not persist the confirmation preference', error);
      }
    }

    let askBeforeDelete = readAsk();

    /** Add one id to the tombstone ledger and publish. */
    function tombstone(sessionId) {
      if (removed.has(sessionId)) return;
      removed = new Set(removed).add(sessionId);
      writeTombstones(removed);
      publish();
    }

    /** Members currently being acted on. */
    let inFlight = new Set();

    /** The row awaiting confirmation, or null. */
    let pending = null;

    /** The message currently shown, or null. */
    let toast = null;

    /** Monotonic revision so every publish is observable as a new snapshot. */
    let revision = 0;

    const listeners = new Set();

    /** Publish a fresh snapshot so every subscribed component re-renders. */
    const publish = () => {
      revision += 1;
      snapshot = { removed: removed, inFlight: inFlight, pending: pending, toast: toast, ask: askBeforeDelete, revision: revision };
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch (error) {
          console.warn('[delete-session] a subscriber threw', error);
        }
      }
    };

    /**
     * The store's snapshot. `useSyncExternalStore` compares this by identity on
     * every render and re-renders when it differs, so a freshly built object
     * literal would starve the renderer in a loop — the snapshot is cached and
     * only replaced when `publish` bumps the revision.
     */
    let snapshot = { removed: removed, inFlight: inFlight, pending: pending, toast: toast, ask: askBeforeDelete, revision: revision };

    const getSnapshot = () => snapshot;

    const subscribe = (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    };

    /** The store every component reads through its hook seat. */
    const store = { getSnapshot: getSnapshot, subscribe: subscribe };

    const setPending = (request) => {
      if (pending === request) return;
      pending = request;
      publish();
    };

    /** Turn the confirmation dialog on or off, and persist the answer. */
    const setAskBeforeDelete = (ask) => {
      const next = ask !== false;
      if (askBeforeDelete === next) return;
      askBeforeDelete = next;
      writeAsk(next);
      publish();
    };

    /**
     * Start deleting one session: through the confirmation, or straight to the
     * bin when the user has already said not to ask again.
     * @param sessionId - the session to move to the recycle bin.
     * @param displayTitle - the row's title, for the confirmation and the toast.
     */
    function requestDelete(sessionId, displayTitle) {
      if (askBeforeDelete) {
        setPending({ sessionId: sessionId, displayTitle: displayTitle });
        return;
      }
      void performDelete(sessionId, displayTitle);
    }

    const showToast = (kind, params) => {
      toast = { kind: kind, params: params ?? null };
      publish();
    };

    const dismissToast = () => {
      if (toast === null) return;
      toast = null;
      publish();
    };

    /**
     * Post one recycle-bin action to the Host.
     * @param action - delete / restore / purge / empty / list / verify.
     * @param sessionId - the target session, where the action needs one.
     * @param extra - further body fields, for the batch actions.
     * @returns the Host's answer.
     * @throws when the Host refused, with a `reason` code for the UI.
     */
    async function call(action, sessionId, extra) {
      const body = { action: action };
      if (sessionId !== undefined) body.sessionId = sessionId;
      if (extra !== undefined) Object.assign(body, extra);
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const reason = response.status === 404
          ? 'missing'
          : response.status === 409
            ? 'busy'
            : response.status === 401 || response.status === 403
              ? 'unauthorized'
              : 'failed';
        console.warn('[delete-session] ' + action + ' refused (' + String(response.status) + '): ' + String(payload?.error ?? ''));
        const error = new Error(String(payload?.error ?? 'request refused'));
        error.reason = reason;
        // The Host names the case: `locked`, `no-workspace`, `not-trashed`, …
        error.code = typeof payload?.code === 'string' ? payload.code : '';
        throw error;
      }
      return payload ?? {};
    }

    /**
     * Hand the main view off a Session that has just been deleted.
     *
     * The shell keeps showing whatever Session is open, but a deleted one is
     * gone from disk, so the page would sit on a dead Session until the user
     * picked another one. The browser's own controller already answers this
     * question — `uiWorkspace`, the service the sidebar package publishes on the
     * client root, ends its `archiveSession` with exactly this check:
     *
     *   if (this.mainReference?.sessionId === sessionId) this.clearMain();
     *
     * Deleting has to do the same. `startSession()` is that controller's own
     * new-Session action (what Ctrl+N runs), so the page lands on a fresh
     * Session — the hero view with the composer — instead of an empty stage.
     * It reuses an existing blank Session in that workspace when there is one,
     * so this never piles up sessions.
     *
     * The workspace travels with the call. `startSession` picks, in order: the
     * workspace id it was handed, the workspace that accounts the Session in the
     * main view, then the most recently used one. Rely only on the middle term
     * and a delete can land the composer somewhere the user is not — deleting an
     * open Session in `test` while `2` had the newest row opened the new Session
     * in `2` — so the row's own workspace is looked up and named here.
     *
     * @param sessionId - the Session that was just moved to the recycle bin.
     * @returns whether the main view was handed back.
     */
    function handBackMainView(sessionId) {
      let controller;
      try {
        controller = clientContext?.get?.('uiWorkspace');
      } catch (error) {
        // A shell without that service is not an error: nothing to hand back.
        return false;
      }
      if (controller === undefined || controller === null) return false;
      if (controller.mainReference?.sessionId !== sessionId) return false;
      try {
        controller.startSession(workspaceOfSession(sessionId));
        return true;
      } catch (error) {
        console.warn('[delete-session] could not open a new session after the delete', error);
        return false;
      }
    }

    /**
     * The Workspace that accounts a Session, as the sidebar is drawing it.
     *
     * A row is grouped by the Workspace whose `sessionIds` list it — that is the
     * app's own grouping rule (`owningGroupKey`), and the same list the row was
     * read from. A Session no workspace accounts for sits in the ungrouped
     * bucket, which has no workspace id and no directory to open a Session in,
     * so that case answers undefined and lets the controller fall back.
     *
     * @param sessionId - the Session whose Workspace is wanted.
     * @returns the workspace id, or undefined when no open row accounts it.
     */
    function workspaceOfSession(sessionId) {
      let items;
      try {
        items = clientContext?.get?.('uiWorkspace')?.workspaces?.list?.getSnapshot?.()?.items;
      } catch (error) {
        return undefined;
      }
      if (!Array.isArray(items)) return undefined;
      const hit = items.find((item) => Array.isArray(item?.sessionIds) && item.sessionIds.includes(sessionId));
      // An empty id is not an answer: `startSession('')` would take it as the
      // workspace to open, because `??` only falls through on null and undefined.
      return typeof hit?.workspaceId === 'string' && hit.workspaceId !== '' ? hit.workspaceId : undefined;
    }

    /**
     * Move one session to the Host's recycle bin and reconcile the page.
     *
     * The row's own name travels with the request. The Host prefers the caches
     * on this machine — that is where DSH keeps the name it shows — but a
     * session created moments ago has no cache record yet, and the row is
     * already on screen with whatever name the sidebar gave it. Without this the
     * bin would list such a session by its raw id, which is exactly the "which
     * one is which" the page exists to answer.
     *
     * @param sessionId - the session to move.
     * @param displayTitle - the name the row shows, when the page knows one.
     * @returns resolves once the Host answered and the page was reconciled.
     */
    async function performDelete(sessionId, displayTitle) {
      if (inFlight.has(sessionId)) return;
      inFlight = new Set(inFlight).add(sessionId);
      publish();
      try {
        const hinted = typeof displayTitle === 'string' && displayTitle.trim() !== ''
          ? { title: displayTitle.trim() }
          : undefined;
        const report = await call('delete', sessionId, hinted);
        tombstone(sessionId);
        handBackMainView(sessionId);
        // Nothing to move means the session had no log left (it was purged out
        // of the bin, or never had one): the row is gone from the page and the
        // Host forgets it at the next restart.
        showToast(report.moved === false ? 'discarded' : 'trashed');
      } catch (error) {
        showToast(failureToast(error));
      } finally {
        const settled = new Set(inFlight);
        settled.delete(sessionId);
        inFlight = settled;
        publish();
      }
    }

    /**
     * The Workspace a restored session belongs to, matched by its directory.
     *
     * The Host answers a restore with the session's working directory; the
     * browser's own Workspace controller holds the rows the sidebar is drawing
     * (`uiWorkspace.workspaces.list`), and a workspace id is what the session
     * adoption below has to name. Comparison is case- and separator-insensitive,
     * because Windows spells the same directory both ways.
     *
     * @param report - the Host's answer to the restore.
     * @returns the workspace id, or undefined when no open row matches.
     */
    function workspaceIdFor(report) {
      const path = typeof report?.workspacePath === 'string' ? report.workspacePath : '';
      if (path === '') return undefined;
      const wanted = path.replaceAll('/', '\\').toLowerCase();
      let items;
      try {
        items = clientContext?.get?.('uiWorkspace')?.workspaces?.list?.getSnapshot?.()?.items;
      } catch (error) {
        return undefined;
      }
      if (!Array.isArray(items)) return undefined;
      const hit = items.find((item) => typeof item?.path === 'string'
        && item.path.replaceAll('/', '\\').toLowerCase() === wanted);
      return typeof hit?.workspaceId === 'string' ? hit.workspaceId : undefined;
    }

    /**
     * Hand a restored session to the running window the way its sidebar does.
     *
     * This is the app's own adoption path, not an invention: `session.create`
     * with an existing id means "idempotently adopt this session", the Host
     * resumes it from its log and attaches it to the workspace, and the browser
     * controller merges the row into the summaries the sidebar renders. The
     * sidebar itself calls exactly this to reuse a row whose session the running
     * Host has forgotten. It runs only when the Host half did not already report
     * the attach, so the common case stays cheap; a refusal is not an error, it
     * only means the row returns at the next start.
     *
     * @param report - the Host's answer to the restore.
     * @param sessionId - the session that was restored.
     * @returns whether the window took the session back.
     */
    async function adoptRestoredSession(report, sessionId) {
      const workspaceId = workspaceIdFor(report);
      if (workspaceId === undefined) return false;
      let sessions;
      try {
        sessions = clientContext?.get?.('uiWorkspace')?.sessions;
      } catch (error) {
        return false;
      }
      if (sessions === undefined || sessions === null || typeof sessions.create !== 'function') return false;
      try {
        const result = await sessions.create({ workspaceId: workspaceId, sessionId: sessionId });
        return result === undefined || result === null || result.ok !== false;
      } catch (error) {
        console.warn('[delete-session] the window would not take the restored session back', error);
        return false;
      }
    }

    /**
     * The page's own Session controller, wherever this application publishes it.
     *
     * Two services can reach it: the Session controller itself (`sessions`, which
     * owns `list` and the reconnecting control stream) and the Workspace facade
     * (`uiWorkspace.sessions`), which holds the same instance. Either is enough,
     * and neither is guaranteed — an older build, or a page that has not finished
     * mounting, must leave a restore working rather than throwing.
     *
     * @returns the controller, or undefined when the page exposes neither.
     */
    function sessionsService() {
      try {
        const direct = clientContext?.get?.('sessions');
        if (direct !== undefined && direct !== null) return direct;
      } catch (error) {
        /* fall through to the facade */
      }
      try {
        return clientContext?.get?.('uiWorkspace')?.sessions;
      } catch (error) {
        return undefined;
      }
    }

    /**
     * Ask the page to re-read the Host's Session list, and report whether the row is back.
     *
     * Attaching a session to its workspace restores MEMBERSHIP; the sidebar draws
     * rows from the Session list, so a session whose summary left that list while
     * its log sat in the bin had the membership and no row — the user restored a
     * session, the bin emptied, and nothing appeared until the next start. The
     * Host answers `session.list` from its persisted Sessions — cold headers
     * included — so one refresh is what puts the summary back, and asking the
     * page to do it through its own controller is the same pull the app runs when
     * it reconnects. That pull is also why the case was not stable: whether the
     * row was still in the page's list depended on whether anything had refreshed
     * the list while the log was in the bin.
     *
     * The answer is read back from the page instead of assumed: only a row that is
     * really in the list may be announced as back.
     *
     * @param sessionId - the session that was restored.
     * @returns whether the page's list now carries the session.
     */
    async function relistRestoredSession(sessionId) {
      const sessions = sessionsService();
      if (sessions === undefined || sessions === null || typeof sessions.refresh !== 'function') return false;
      try {
        await sessions.refresh();
      } catch (error) {
        console.warn('[delete-session] the window would not refresh its Session list', error);
        return false;
      }
      let byId;
      try {
        byId = sessions.list?.getSnapshot?.()?.byId;
      } catch (error) {
        return false;
      }
      return byId !== undefined && byId !== null && byId[sessionId] !== undefined;
    }

    /**
     * The toast that fits a refused request.
     *
     * The Host's status alone is not enough to say what happened: a 409 covers
     * "a file is still open", "this entry does not know its workspace" and the
     * directory a restore would land in, and every one of them used to be told as
     * "the session log is still in use" — a message about a locked file for a
     * request that never touched one. The Host's own code names the case.
     *
     * @param error - the rejection `call()` built.
     * @returns the toast kind to show.
     */
    function failureToast(error) {
      const code = error?.code;
      if (code === 'no-workspace') return 'noWorkspace';
      if (code === 'not-trashed') return 'notTrashed';
      if (code === 'locked') return 'busy';
      return error?.reason ?? 'failed';
    }

    /**
     * Drop a session's tombstone so its sidebar row comes back.
     *
     * Deleting a session hides its row with a page-local stylesheet, because
     * the Host's session registry cannot be touched from here. Restoring the
     * log on disk is therefore not enough on its own: unless the tombstone is
     * lifted too, the restored row stays hidden until the next page load.
     * @param sessionId - the session whose log returned to its workspace.
     */
    function unTombstone(sessionId) {
      if (!removed.has(sessionId)) return;
      const next = new Set(removed);
      next.delete(sessionId);
      removed = next;
      writeTombstones(removed);
      publish();
    }

    /**
     * Ask the Host which of the rows this page hides still have no log.
     *
     * A row must stay hidden exactly while its session has no log on disk. That
     * one rule covers every way a session leaves: moved into the bin (no log),
     * purged or emptied out of it (no log), swept after 15 days (no log), and
     * restored (the log is back, so the row returns).
     *
     * Reading the answer out of the bin's own listing instead — which is what
     * this did — was wrong twice over. Purging and emptying remove the entry AND
     * the payload, so the reconcile saw "not in the bin" and treated it as
     * "restored", and every row the user had emptied came back to life: listed,
     * openable out of the running Host's memory, and undeletable because there
     * was nothing left to move.
     *
     * Only a definite answer may lift a tombstone: a failed or unknown request
     * keeps hiding, because the log may well be gone.
     *
     * @returns whether the ledger changed.
     */
    async function verifyTombstones() {
      if (removed.size === 0) return false;
      const ids = [...removed];
      let answer;
      try {
        answer = await call('verify', undefined, { sessionIds: ids });
      } catch (error) {
        return false;
      }
      if (!Array.isArray(answer.missing)) return false;
      const gone = new Set(answer.missing.map((id) => String(id)));
      const kept = ids.filter((id) => gone.has(id));
      if (kept.length === removed.size) return false;
      removed = new Set(kept);
      writeTombstones(removed);
      publish();
      return true;
    }

    /** Format a byte count for the settings row. */
    function formatBytes(bytes) {
      const value = Number(bytes);
      if (!Number.isFinite(value) || value <= 0) return '0 B';
      if (value < 1024) return value + ' B';
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
      if (value < 1024 * 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + ' MB';
      return (value / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
    }

    /** Format an ISO timestamp as a short local date-time. */
    function formatWhen(iso) {
      const time = Date.parse(String(iso));
      if (!Number.isFinite(time)) return '';
      const date = new Date(time);
      const pad = (part) => String(part).padStart(2, '0');
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
    }

    /**
     * The trash glyph, copied stroke-for-stroke from the host's own
     * `IconTrashOutlineRegular` (16x16 artwork, `strokeWidth` 1, square caps,
     * rendered at size 14 — exactly what the shipped rows put in a menu).
     *
     * The stroke carries an explicit colour rather than inheriting
     * `currentColor`. The row's TEXT is deliberately the danger red, and an
     * inheriting glyph would turn red with it; and the colour cannot be left to
     * the host's `.itemIcon{color:…}` either, because the row only wears that
     * class once the host's hashed class names have been discovered. Stating it
     * here means the glyph is correct no matter what the surrounding CSS does.
     *
     * `label-tertiary` is not a guess: the host's own row-button rule uses it
     * verbatim — `.iconButton{… color:var(--dsw-alias-label-tertiary) …}`, with
     * `label-primary` on hover — so the glyph matches the shipped Pin and
     * Archive marks (#81858c light, #adb2b8 dark).
     */
    /**
     * The trash glyph: the host's own `IconTrashOutlineRegular` artwork, drawn
     * exactly as the four shipped menu rows draw theirs.
     *
     * Every one of those artworks is declared with `stroke:"currentColor"` and
     * `strokeWidth: 1` — none of them carries a colour of its own, and the menu
     * rows all pass an empty props object (`IconArchiveOutlineRegular, {}`). The
     * tint therefore comes from the icon's container, which `MenuItemButton`
     * renders as `.itemIcon`. A normal row's container is
     * `color:var(--dsw-alias-label-tertiary)`; this row is destructive, so its
     * container carries the error colour exactly like the host's own
     * `danger: true` rows (see `HOST_OVERRIDES`). Inheriting keeps this glyph on
     * the same chain as the shipped ones instead of hard-coding a shade.
     */
    function TrashIcon() {
      return React.createElement(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 16 16',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
          strokeWidth: 1,
        },
        React.createElement('path', { d: 'M1.28149 3.88831H14.7187', stroke: 'currentColor' }),
        React.createElement('path', {
          d: 'M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833',
          stroke: 'currentColor',
        }),
        React.createElement('path', {
          d: 'M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831',
          stroke: 'currentColor',
        }),
        React.createElement('path', { d: 'M6.44946 6.98926V11.1238', stroke: 'currentColor' }),
        React.createElement('path', { d: 'M9.55054 6.98926V11.1238', stroke: 'currentColor' }),
      );
    }

    /**
     * The hover button at the end of a session row
     * (`sidebar.workspaces.session.row.action`).
     *
     * This slot declares no injected hooks, so the contract is simpler than the
     * menu row's, and the button is reachable without opening the "..." menu.
     * The app's own Pin button is the reference: a bare
     * `button.iconButton` with a 14px icon.
     * @param props - the row identity, supplied by the row owner.
     */
    function DeleteSessionRowButton(props) {
      const sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : '';
      const displayTitle = props && typeof props.displayTitle === 'string' ? props.displayTitle : '';
      const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
      if (sessionId === '' || state.removed.has(sessionId)) return null;
      const isBusy = state.inFlight.has(sessionId);
      const label = isBusy ? text('menu.deleting') : text('menu.delete');
      return React.createElement(
        'button',
        {
          type: 'button',
          className: 'dsds_iconButton',
          disabled: isBusy,
          title: label + ': ' + (displayTitle === '' ? text('empty') : displayTitle),
          'aria-label': label + ': ' + (displayTitle === '' ? text('empty') : displayTitle),
          onClick: (event) => {
            event.stopPropagation();
            if (!isBusy) requestDelete(sessionId, displayTitle);
          },
        },
        React.createElement(TrashIcon, null),
      );
    }

    /**
     * The `sidebar.workspaces.session.menu.item` row.
     * @param props - the row identity plus the menu-open hook.
     */
    function DeleteSessionMenuItem(props) {
      try {
        return renderDeleteSessionMenuItem(props);
      } catch (error) {
        lastRowError = String(error && error.message ? error.message : error);
        throw error;
      }
    }

    /**
     * The row body. Kept separate so the wrapper can record a thrown render.
     * @param props - the row identity plus the menu-open hook.
     */
    function renderDeleteSessionMenuItem(props) {
      // A slot entry that throws is abdicated by the boundary and never comes
      // back, so an unexpected call must degrade instead of crashing.
      if (props === null || typeof props !== 'object' || typeof props.sessionId !== 'string') {
        return null;
      }
      const sessionId = props.sessionId;
      const displayTitle = typeof props.displayTitle === 'string' ? props.displayTitle : '';
      const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
      const isRemoved = state.removed.has(sessionId);
      const isBusy = state.inFlight.has(sessionId);
      const closeMenu = typeof props.useMenuOpenState === 'function' ? props.useMenuOpenState()[1] : undefined;
      const label = isRemoved ? text('menu.deleted') : isBusy ? text('menu.deleting') : text('menu.delete');
      const title = displayTitle === '' ? text('empty') : displayTitle;
      const onSelect = () => {
        if (typeof closeMenu === 'function') closeMenu();
        if (!isRemoved && !isBusy) requestDelete(sessionId, displayTitle);
      };
      const module = loadPrimitives();
      const MenuItemButton = module === null ? null : module.MenuItemButton;
      const IconTrashOutlineRegular = module === null ? null : module.IconTrashOutlineRegular;
      /*
       * Preferred path, and the one the host's own rows take: hand the row to
       * `MenuItemButton`, which owns the metrics, the icon seat, the label
       * ellipsis and the `danger` treatment. Nothing here has to imitate the
       * menu cell, so nothing here can drift from it.
       */
      if (MenuItemButton !== null) {
        return React.createElement(MenuItemButton, {
          icon: IconTrashOutlineRegular === null ? React.createElement(TrashIcon, null) : React.createElement(IconTrashOutlineRegular, {}),
          danger: true,
          disabled: isRemoved || isBusy,
          onSelect: onSelect,
        }, isRemoved ? text('menu.deleted') : isBusy ? text('menu.deleting') : label);
      }      /*
       * Fallback: the same markup `MenuItemButton` produces, kept for the case
       * where the primitives module could not be required. The host's own menu
       * classes are adopted when they can be discovered, so even this path uses
       * the cell's real declarations rather than a copy of them.
       */
      const host = discoverHostMenuClasses();
      return React.createElement(
        'div',
        { className: 'dsds_itemWrap' },
        React.createElement(
          'button',
          {
            type: 'button',
            role: 'menuitem',
            className: ['dsds_item', host === null ? '' : host.item].filter(Boolean).join(' '),
            disabled: isRemoved || isBusy,
            title: title,
            'aria-label': label + ': ' + title,
            onClick: (event) => {
              event.stopPropagation();
              onSelect();
            },
          },
          React.createElement('span', { className: host === null ? 'dsds_itemIcon' : host.icon }, React.createElement(TrashIcon, null)),
          React.createElement('span', { className: host === null ? 'dsds_itemLabel' : host.label }, label),
        ),
      );
    }

    /**
     * The `shell.overlay` confirmation entry.
     * @param props - the locale seat.
     */
    function DeleteSessionConfirm(props) {
      const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
      const request = state.pending;
      const [busy, setBusy] = React.useState(false);
      const confirmRef = React.useRef(null);
      const sessionId = request === null ? '' : request.sessionId;
      React.useEffect(() => {
        if (sessionId === '') return undefined;
        if (confirmRef.current !== null && typeof confirmRef.current.focus === 'function') {
          confirmRef.current.focus();
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape' && !busy) {
            event.stopPropagation();
            setPending(null);
          }
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => {
          window.removeEventListener('keydown', onKeyDown, true);
        };
      }, [sessionId, busy]);
      if (request === null) return null;
      const rawTitle = request.displayTitle;
      const title = rawTitle === '' ? text('empty') : rawTitle;
      return React.createElement(
        'div',
        {
          className: 'dsds_layer',
          onClick: (event) => {
            if (event.target === event.currentTarget && !busy) setPending(null);
          },
        },
        React.createElement(
          'div',
          { className: 'dsds_card', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': text('confirm.title') },
          React.createElement('h2', { className: 'dsds_cardTitle' }, text('confirm.title')),
          React.createElement('p', { className: 'dsds_cardDesc' }, text('confirm.desc', { title: title, days: 15 })),
          /*
           * The opt-out lives in the dialog itself: this is where the user
           * decides the question is not worth answering every time. It takes
           * effect immediately, so cancelling afterwards still keeps the answer.
           * The switch back on is in Settings → 回收站.
           */
          React.createElement(
            'label',
            { className: 'dsds_check' },
            React.createElement('input', {
              type: 'checkbox',
              checked: state.ask === false,
              disabled: busy,
              onChange: (event) => {
                setAskBeforeDelete(event.target.checked === false);
              },
            }),
            text('confirm.skip'),
          ),
          React.createElement(
            'div',
            { className: 'dsds_footer' },
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'dsds_button',
                disabled: busy,
                onClick: () => {
                  if (!busy) setPending(null);
                },
              },
              text('cancel'),
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                ref: confirmRef,
                className: 'dsds_button',
                disabled: busy,
                onClick: () => {
                  setBusy(true);
                  void performDelete(request.sessionId, request.displayTitle).then(() => {
                    setBusy(false);
                    setPending(null);
                  });
                },
              },
              busy ? text('confirm.busy') : text('confirm.action'),
            ),
          ),
        ),
      );
    }
    /**
     * The `shell.overlay` toast entry.
     * @param props - the locale seat.
     */
    function DeleteSessionToast() {
      const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
      const current = state.toast;
      const revision = state.revision;
      React.useEffect(() => {
        if (current === null) return undefined;
        const timer = window.setTimeout(() => {
          dismissToast();
        }, 4000);
        return () => {
          window.clearTimeout(timer);
        };
      }, [current, revision]);
      if (current === null) return null;
      return React.createElement(
        'div',
        { className: 'dsds_toast', role: 'status', 'aria-live': 'polite' },
        text('toast.' + current.kind, current.params ?? undefined),
      );
    }

    /**
     * The host's own menu class names, discovered from a live row.
     *
     * The menu styles are CSS modules with hashed names that change between
     * builds, so they cannot be hard-coded. They are read from a row the host
     * rendered itself, and the menu's own sheet then styles this plugin's row
     * through them — the shipped rows and this one end up sharing one set of
     * declarations rather than two hand-kept copies.
     */
    let hostMenuClasses = null;

    /**
     * Read the menu cell's class names.
     *
     * The menu styles are CSS modules whose hashed prefix changes between
     * builds, so they cannot be hard-coded. The prefix is recovered from any
     * rendered element of that cell — the row wrapper the host itself puts
     * around every entry is the easiest one to find, because this plugin's own
     * row always sits inside one and its icon seat may not carry the host's
     * class yet. A concrete host row is preferred when one is on screen, so the
     * names come from real markup rather than from a naming convention.
     */
    function discoverHostMenuClasses() {
      if (hostMenuClasses !== null) return hostMenuClasses;
      if (typeof document === 'undefined') return null;
      const fromPrefix = (element) => {
        const own = Array.from(element.classList).find((name) => name.endsWith('_itemWrap'));
        if (own === undefined) return null;
        return { item: own.replace(/_itemWrap$/, '_item'), icon: own.replace(/_itemWrap$/, '_itemIcon'), label: own.replace(/_itemWrap$/, '_itemLabel') };
      };
      // Prefer a row the host rendered itself.
      for (const row of document.querySelectorAll('button[role="menuitem"]')) {
        if (row.classList.contains('dsds_item')) continue;
        const icon = row.querySelector('span[class*="itemIcon"]');
        const label = row.querySelector('span[class*="itemLabel"]');
        const itemClass = Array.from(row.classList).find((name) => name.endsWith('_item'));
        if (icon === null || label === null || itemClass === undefined) continue;
        const iconClass = Array.from(icon.classList).find((name) => name.endsWith('_itemIcon'));
        const labelClass = Array.from(label.classList).find((name) => name.endsWith('_itemLabel'));
        if (iconClass === undefined || labelClass === undefined) continue;
        hostMenuClasses = { item: itemClass, icon: iconClass, label: labelClass };
        return hostMenuClasses;
      }
      // Otherwise derive them from the wrapper the host wraps every entry in.
      for (const wrap of document.querySelectorAll('div[class*="_itemWrap"]')) {
        const found = fromPrefix(wrap);
        if (found === null) continue;
        // Only trust a wrapper that is NOT this plugin's own row.
        if (wrap.classList.contains('dsds_itemWrap')) continue;
        hostMenuClasses = found;
        return hostMenuClasses;
      }
      return null;
    }

    /**
     * The plugin's single stylesheet owner, mounted once for the whole session.
     *
     * It must render UNCONDITIONALLY. The menu row lives in the sidebar, far
     * from the settings section, so a stylesheet emitted only by the settings
     * page (or only once a session had been deleted) left the menu row styled
     * by nothing at all — it collapsed to unstyled text and an oversized glyph.
     * The tombstone rules ride along in the same sheet, appended only when
     * something is actually in the bin.
     */
    function DeleteSessionStyles() {
      const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
      // Start from whatever is on the page right now; a stylesheet owner that
      // mounts while a menu is open can read the classes immediately.
      const [classes, setClasses] = React.useState(() => discoverHostMenuClasses());
      React.useEffect(() => {
        if (classes !== null) return undefined;
        if (typeof MutationObserver === 'undefined') return undefined;
        // The first menu of the session may not exist yet. Watch the document
        // until a host row shows up, then disconnect — this is a one-shot, so
        // no long-lived observer is ever left running over a busy page.
        const observer = new MutationObserver(() => {
          const found = discoverHostMenuClasses();
          if (found !== null) setClasses(found);
        });
        observer.observe(document.body, { childList: true, subtree: true });
        return () => {
          observer.disconnect();
        };
      }, [classes]);
      const tombstones = state.removed.size === 0
        ? ''
        : [...state.removed].map((id) => '[data-row-key="session:' + id + '"]').join(',') + '{display:none!important}';
      // The destructive overrides cannot be scoped until a host row has been
      // seen; the effect above re-renders the sheet the moment one appears.
      const overrides = classes === null
        ? ''
        : HOST_OVERRIDES.replace(/HOST_ITEM/g, classes.item).replace(/HOST_ICON/g, classes.icon);
      return React.createElement('style', null, CSS + overrides + tombstones);
    }

    /**
     * The `settings.section` entry: the recycle bin page.
     * @param props - the locale seat (the settings host owns the chrome).
     */
    function RecycleBinSection() {
      const [state, setState] = React.useState({ phase: 'loading', entries: [], retentionDays: 15, purged: [] });
      const [busyId, setBusyId] = React.useState('');
      const [error, setError] = React.useState('');
      /** Which destructive action is armed for its second, confirming click. */
      const [confirming, setConfirming] = React.useState('');
      // This page is where the confirmation is switched back on: the dialog's
      // "don't ask again" would otherwise be a one-way door.
      const shared = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
      const load = React.useCallback(() => {
        call('list').then((payload) => {
          const entries = Array.isArray(payload.entries) ? payload.entries : [];
          setState({
            phase: 'ready',
            entries: entries,
            retentionDays: typeof payload.retentionDays === 'number' ? payload.retentionDays : 15,
            purged: Array.isArray(payload.purged) ? payload.purged : [],
          });
          setError('');
          // Hiding is settled against the logs on disk, not against this
          // listing: a row stays hidden while its session has no log, so one
          // restored from another window comes back and one purged out of the
          // bin here (or swept while the page was closed) stays gone.
          void verifyTombstones();
        }, (failure) => {
          setState((previous) => ({ ...previous, phase: 'ready' }));
          setError(failure?.reason === 'unauthorized' ? text('toast.unauthorized') : text('recycle.errorLoad'));
        });
      }, []);
      React.useEffect(() => {
        load();
      }, []);
      const act = (action, entry) => {
        setBusyId(entry.sessionId);
        call(action, entry.sessionId).then(async (report) => {
          if (action === 'restore') {
            // The log is back in its workspace, so lift the tombstone: a row the
            // app lists again reappears at once instead of waiting for a page load.
            unTombstone(entry.sessionId);
            // Membership first (the Host), then the row itself. Attaching says which
            // workspace owns the session; the sidebar draws rows from the page's own
            // Session list, and a summary that left that list while the log sat in the
            // bin comes back from one re-read — not from a restart.
            if (report?.attached !== true) await adoptRestoredSession(report, entry.sessionId);
            const listed = (await relistRestoredSession(entry.sessionId)) || report?.attached === true;
            showToast(listed ? 'restored' : 'restoredPending', {
              title: entry.title === '' ? text('empty') : entry.title,
            });
          } else {
            showToast('purged');
          }
          load();
        }, (failure) => {
          showToast(failureToast(failure));
        }).then(() => {
          setBusyId('');
        });
      };
      const emptyBin = () => {
        const count = state.entries.length;
        if (count === 0) return;
        // Two-step inline confirmation replaces `window.confirm`, whose OS-level
        // box is titled with the app id and cannot be styled to match.
        if (confirming !== 'empty') {
          setConfirming('empty');
          return;
        }
        setConfirming('');
        setBusyId('*');
        call('empty').then(() => {
          showToast('emptied');
          load();
        }, (failure) => {
          showToast(failureToast(failure));
        }).then(() => {
          setBusyId('');
        });
      };
      const totalBytes = state.entries.reduce((sum, entry) => sum + (Number(entry.bytes) || 0), 0);
      return React.createElement(
        'section',
        { className: 'dsds_section' },
        React.createElement('h2', { className: 'dsds_sectionTitle' }, text('recycle.title')),
        React.createElement('p', { className: 'dsds_sectionIntro' }, text('recycle.intro', { days: state.retentionDays })),
        React.createElement('p', { className: 'dsds_note' }, text('recycle.reloadHint')),
        React.createElement(
          'div',
          { className: 'dsds_toolbar' },
          React.createElement(
            'button',
            { type: 'button', className: 'dsds_button', disabled: busyId !== '', onClick: load },
            text('recycle.refresh'),
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dsds_button',
              disabled: busyId !== '',
              onClick: () => {
                window.location.reload();
              },
            },
            text('recycle.reload'),
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              className: confirming === 'empty' ? 'dsds_button dsds_buttonDanger' : 'dsds_button',
              disabled: busyId !== '' || state.entries.length === 0,
              onClick: emptyBin,
            },
            confirming === 'empty' ? text('recycle.askEmpty', { count: state.entries.length }) : text('recycle.emptyBin'),
          ),
        ),
        // No hint line under the toolbar: an armed action states itself on its
        // own button ("确认彻底删除"), and a line that appeared only while one was
        // armed pushed the whole table down and back for nothing.
        // The label names the MOVE, in the wording the dialog's own button uses:
        // a bare "删除前先确认" reads as if it governed this page's own 彻底删除
        // buttons, and "「删除会话」前" still leans on the reader knowing which
        // 删除会话 is meant.
        React.createElement(
          'label',
          { className: 'dsds_check' },
          React.createElement('input', {
            type: 'checkbox',
            checked: shared.ask,
            onChange: (event) => {
              setAskBeforeDelete(event.target.checked);
            },
          }),
          text('recycle.ask'),
        ),
        error !== '' ? React.createElement('p', { className: 'dsds_error' }, error) : null,
        state.phase === 'loading'
          ? React.createElement('p', { className: 'dsds_note' }, text('recycle.loading'))
          : state.entries.length === 0
            ? React.createElement('p', { className: 'dsds_note' }, text('recycle.empty'))
            : React.createElement(
              'div',
              { className: 'dsds_table' },
              React.createElement(
                'div',
                { className: 'dsds_row dsds_rowHead' },
                React.createElement('span', null, text('recycle.columnSession')),
                React.createElement('span', null, text('recycle.columnWorkspace')),
                React.createElement('span', null, text('recycle.columnTrashed')),
                React.createElement('span', null, text('recycle.columnLeft')),
                React.createElement('span', null, ''),
              ),
              state.entries.map((entry) => React.createElement(
                'div',
                { className: 'dsds_row', key: entry.sessionId },
                React.createElement('span', { className: 'dsds_cellTitle', title: entry.sessionId }, entry.title === '' ? text('empty') : entry.title),
                React.createElement('span', { className: 'dsds_cellMuted', title: String(entry.cwd ?? '') }, String(entry.cwd ?? '—')),
                React.createElement('span', { className: 'dsds_cellNumber' }, formatWhen(entry.trashedAt)),
                React.createElement('span', { className: 'dsds_cellNumber' }, entry.daysLeft > 0 ? text('recycle.daysLeft', { days: entry.daysLeft }) : text('recycle.expired')),
                React.createElement(
                  'span',
                  { className: 'dsds_rowActions' },
                  React.createElement(
                    'button',
                    {
                      type: 'button',
                      className: 'dsds_button',
                      disabled: busyId !== '',
                      onClick: () => {
                        act('restore', entry);
                      },
                    },
                    busyId === entry.sessionId ? text('recycle.working') : text('recycle.restore'),
                  ),
                  React.createElement(
                    'button',
                    {
                      type: 'button',
                      className: confirming === entry.sessionId ? 'dsds_button dsds_buttonDanger' : 'dsds_button',
                      disabled: busyId !== '',
                      onClick: () => {
                        // Same two-step confirmation as the toolbar, so no
                        // OS-level dialog is raised for a row action.
                        if (confirming !== entry.sessionId) {
                          setConfirming(entry.sessionId);
                          return;
                        }
                        setConfirming('');
                        act('purge', entry);
                      },
                    },
                    busyId === entry.sessionId
                      ? text('recycle.working')
                      : confirming === entry.sessionId
                        ? text('recycle.askPurge')
                        : text('recycle.purge'),
                  ),
                ),
              )),
            ),
        state.entries.length > 0
          ? React.createElement('p', { className: 'dsds_note' }, text('recycle.total', { count: state.entries.length, size: formatBytes(totalBytes) }))
          : null,
      );
    }

    /*
     * The settings navigation glyph.
     *
     * The shell draws a nav glyph from a closed table of section ids — see
     * `navIcon(id)` in `dsh-client-ui-settings-general`: `account`, `models`,
     * `agent-presets`, `plugins`, `archived-sessions`. Every other id gets the
     * gear, ours included, because a `settings.section` registration projects
     * `id` / `order` / `label` and nothing to draw with. Which leaves restyling
     * the row after the fact. dshmarket's `settings-nav-icon.ts` documents the
     * same dead end (and notes that dsh-better-sidebar and dsh-skill-mcp-panel
     * walk out of it the same way); the code below is this plugin's own take on
     * that route — the technique is shared, nothing here is lifted: no shell
     * structure is touched, only the row's own appearance.
     *
     * The row is recognised by its visible text alone: the label this section
     * registered, in the language currently loaded. The worst case is a gear
     * that stays a gear — an empty label, from a locale that has not resolved
     * yet, matches nothing at all.
     *
     * One `ctx.effect` owns all three moving parts — the attribute on the row,
     * the stylesheet in `document.head`, the observer that re-runs the claim
     * when the shell redraws the dialog or the language changes — so unloading
     * the fiber takes them away together.
     *
     * Delete this the day `settings.section` grows an `icon` field.
     */
    /** Attribute this plugin puts on the one settings row it redraws. */
    const SETTINGS_ROW_TAG = 'data-dsh-delete-session-nav-icon';
    /** The settings dialog's nav rows, as the shell renders them. */
    const SETTINGS_NAV_ROWS = '[role="dialog"] nav button';
    /** The box the shell draws every nav glyph in. */
    const NAV_GLYPH_PX = 16;
    /**
     * The bin, exactly the artwork the user handed over.
     *
     * One substitution and nothing else: `stroke="currentColor"` became
     * `stroke="#000"`. A mask reads alpha only, so the colour is invisible
     * either way, and naming it keeps the glyph from depending on what
     * `currentColor` happens to resolve to inside a data-URL image. The file's
     * own 24-unit box and 2-unit stroke are kept: the mask paints it at the
     * shell's 16px, so the stroke lands on ~1.33px, the weight the shell's own
     * nav glyphs use. Stroked and never filled, for the same reason the shell
     * strokes its own: an open path that kept a fill would paint a solid blob
     * into the mask.
     */
    const NAV_MARK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"'
      + ' fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
      // lid
      + '<path d="M3 6h18"/>'
      + '<path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/>'
      // body
      + '<path d="M19 6l-1.5 13.2A2 2 0 0 1 15.5 21h-7a2 2 0 0 1-2-1.8L5 6"/>'
      // the two ribs on the body
      + '<line x1="10" y1="10" x2="10" y2="17"/>'
      + '<line x1="14" y1="10" x2="14" y2="17"/>'
      + '</svg>';

    /**
     * The mask a stylesheet paints the claimed row with.
     *
     * `encodeURIComponent`, never hand-escaping: the SVG carries `<`, `>`, `#`
     * and quotes, and a `data:` URL is decoded before the browser parses it.
     *
     * @param svg - the mark's SVG source.
     * @returns the `data:` URL to point `mask-image` at.
     */
    function markMask(svg) {
      return 'data:image/svg+xml,' + encodeURIComponent(svg);
    }

    /**
     * Whether a settings row is the one this plugin registered.
     *
     * Judged on visible text only, and an empty label never matches: a language
     * that has not resolved yet must not put our markup on the whole nav.
     *
     * @param rowText - the row's visible text.
     * @param label - this section's label in the loaded language.
     * @returns whether this row is ours.
     */
    function isOurRow(rowText, label) {
      const wanted = String(label ?? '').trim();
      return wanted !== '' && String(rowText ?? '').trim() === wanted;
    }

    /**
     * The stylesheet for the claimed row: the shell's gear out, the bin in.
     *
     * The visible half is a `::before` box the size of a nav glyph, filled with
     * `currentColor` — so it inherits the row's colour and hover state — and
     * masked with the mark. The shell's own `<svg>` inside that row is hidden
     * rather than removed, which keeps the shell's layout untouched.
     *
     * @param url - the mark as a `data:` URL.
     * @returns the CSS text.
     */
    function rowCss(url) {
      const mask = `-webkit-mask-image:url("${url}");mask-image:url("${url}");`
        + '-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;'
        + '-webkit-mask-position:center;mask-position:center;'
        + `-webkit-mask-size:${NAV_GLYPH_PX}px ${NAV_GLYPH_PX}px;mask-size:${NAV_GLYPH_PX}px ${NAV_GLYPH_PX}px;`;
      const box = `content:'';flex:none;width:${NAV_GLYPH_PX}px;height:${NAV_GLYPH_PX}px;`
        + 'background-color:currentColor;';
      return `[${SETTINGS_ROW_TAG}]>svg{display:none}`
        + `[${SETTINGS_ROW_TAG}]::before{${mask}${box}}`;
    }

    /**
     * Draw the recycle bin on this plugin's row in the settings navigation.
     *
     * @param host - the client plugin context, for effect ownership.
     * @param resolveLabel - this section's label right now, re-read on every
     *   pass so a language switch is picked up without re-registering.
     * @returns the effect's disposer, when there is a document to work on.
     */
    function drawSettingsNavIcon(host, resolveLabel) {
      if (typeof document === 'undefined') return undefined;
      return host.effect(() => {
        const sheet = document.createElement('style');
        sheet.dataset.plugin = 'delete-session';
        sheet.dataset.pluginCss = 'delete-session/settings-nav-icon';
        sheet.textContent = rowCss(markMask(NAV_MARK_SVG));
        document.head.appendChild(sheet);

        let stopped = false;
        let queued = false;
        // One pass: tag our row, untag any row the shell reused for another
        // section. Cheap enough to redo whenever the dialog changes.
        const claim = () => {
          queued = false;
          if (stopped) return;
          const label = resolveLabel();
          for (const row of document.querySelectorAll(SETTINGS_NAV_ROWS)) {
            if (isOurRow(row.textContent, label)) row.setAttribute(SETTINGS_ROW_TAG, '');
            else row.removeAttribute(SETTINGS_ROW_TAG);
          }
        };
        // Mutations arrive in bursts — the dialog mounting, a language switch
        // re-rendering it — so one microtask per burst, landing before paint.
        const later = () => {
          if (queued || stopped) return;
          queued = true;
          queueMicrotask(claim);
        };

        claim();
        const watched = typeof MutationObserver === 'function' ? new MutationObserver(later) : undefined;
        watched?.observe(document.body, { childList: true, subtree: true, characterData: true });

        return () => {
          stopped = true;
          watched?.disconnect();
          for (const row of document.querySelectorAll(`[${SETTINGS_ROW_TAG}]`)) row.removeAttribute(SETTINGS_ROW_TAG);
          sheet.remove();
        };
      }, 'delete-session: settings nav icon');
    }

    return {
      /**
       * Services this plugin reads. Cordis hands a plugin a Proxy whose `get`
       * trap THROWS for every service the plugin did not declare here —
       * `cannot get property "locale" without inject` — so every access below
       * (`ctx.locale`, `ctx.slots`) must be listed. The list waits for the
       * provider too, which is what makes the plugin order-independent.
       */
      inject: ['slots', 'locale'],
      /**
       * Register the menu row, the confirmation, the toast and the settings page.
       * @param ctx - Client plugin context.
       */
      apply(ctx) {
        // Bind this plugin's own translator first: every component below reads
        // it instead of a `t` prop the host does not always provide.
        translate = ctx.locale.bind(NS);
        clientContext = ctx;
        // Settle the rows this page hid while its session has no log: a restore
        // in another window brings one back, a purge or the 15-day sweep keeps
        // it hidden. Only a definite answer from the Host lifts a tombstone.
        void verifyTombstones();
        ctx.effect(() => ctx.locale.register(NS, { zh: zh, en: en }), 'delete-session: dictionaries');
        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'delete-session',
          order: MENU_ORDER,
          locale: NS,
        }, DeleteSessionMenuItem));
        ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.row.action',
          id: 'delete-session-row',
          order: ROW_ACTION_ORDER,
          locale: NS,
        }, DeleteSessionRowButton));
        ctx.slots.inject('shell.overlay', function* () {
          yield ctx.slots.register({
            name: 'shell.overlay',
            id: 'delete-session-confirm',
            locale: NS,
          }, DeleteSessionConfirm);
          yield ctx.slots.register({
            name: 'shell.overlay',
            id: 'delete-session-toast',
            locale: NS,
          }, DeleteSessionToast);
          yield ctx.slots.register({
            name: 'shell.overlay',
            id: 'delete-session-styles',
          }, DeleteSessionStyles);
        });
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'delete-session-recycle-bin',
          order: SETTINGS_ORDER,
          label: () => ctx.locale.bind(NS)('recycle.nav'),
          locale: NS,
        }, RecycleBinSection));
        // The shell draws a gear for every third-party section; this swaps in
        // the recycle mark for the row carrying this section's own label.
        drawSettingsNavIcon(ctx, () => ctx.locale.bind(NS)('recycle.nav'));
      },
      /*
       * Seam for the test harness and a console session: these drive the same
       * store the components read, so exercising them is the product path.
       */
      __diag: {
        performDelete: performDelete,
        requestDelete: requestDelete,
        setAskBeforeDelete: setAskBeforeDelete,
        verifyTombstones: verifyTombstones,
        sessionsService: sessionsService,
        relistRestoredSession: relistRestoredSession,
        adoptRestoredSession: adoptRestoredSession,
        workspaceIdFor: workspaceIdFor,
        workspaceOfSession: workspaceOfSession,
        settingsMark: () => NAV_MARK_SVG,
        markMask: markMask,
        rowCss: rowCss,
        isOurRow: isOurRow,
        drawSettingsNavIcon: drawSettingsNavIcon,
        store: store,
        setPending: setPending,
      },
    };
  },
});
