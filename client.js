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
     * How close to the retention deadline counts as "expiring".
     *
     * Three days, and the page states the number it used: an entry within a
     * weekend of being purged is the one thing about a recycle bin a user cannot
     * see coming, while every entry inside that window is still restorable.
     */
    const EXPIRING_SOON_DAYS = 3;

    /**
     * A day in ms.
     *
     * The bin's whole arithmetic is "deleted at + N of these", and the page does
     * the same sum the Host purges on: the count of entries a new window would
     * delete on the spot has to be the count the Host is about to delete.
     */
    const DAY_MS = 24 * 60 * 60 * 1000;

    /**
     * How long a delete stays undoable from its own message.
     *
     * The confirmation guards against a mis-click; this guards against the click
     * that was meant. Ten seconds is long enough to notice what just happened and
     * short enough that the message is gone before it becomes furniture, and the
     * deadline travels with the message so a page that keeps publishing cannot
     * stretch the window out.
     */
    const UNDO_WINDOW_MS = 10 * 1000;

    /** How long a message without an action stays: long enough to read once. */
    const TOAST_MS = 4000;

    /**
     * The retention windows the page offers, in days.
     *
     * Three answers, because that is the size of question this is: a week, the
     * shipped fortnight, a month. The Host accepts any whole number in its own
     * range, so a profile set by hand to something else is shown as itself rather
     * than silently rounded to the nearest of these.
     */
    const RETENTION_CHOICES = [7, 15, 30];

    /**
     * The `confirming` value that arms the batch's permanent delete.
     *
     * A word rather than an id: the same state holds a row's session id when that
     * row's own button is armed, and no session id can ever spell this.
     */
    const PICKED_ARMED = 'picked-purge';

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
      'batch.button': '批量删除会话',
      'batch.title': '批量删除会话',
      'batch.desc': '勾选要删除的会话：它们会移入回收站，{days} 天后自动彻底删除，期间可在 设置 → 回收站 里还原。',
      'batch.selected': '已选 {selected} / {total}',
      'batch.all': '全选',
      'batch.none': '全不选',
      'batch.archivedTag': '已归档',
      'batch.action': '移入回收站（{count}）',
      'batch.busy': '正在删除 {done} / {total}…',
      'batch.ungrouped': '未分组',
      'batch.groupPick': '选中「{group}」里的全部会话',
      'toast.batchTrashed': '已把 {count} 个会话移入回收站（可在 设置 → 回收站 还原）',
      'toast.batchPartial': '已移入回收站 {done} 个，{failed} 个没能移动：日志仍被占用，关掉那些会话后可以再试一次',
      'toast.batchEmpty': '没有可删除的会话',
      'toast.batchEmptyArchived': '没有可删除的会话（有 {hidden} 个已归档会话不在当前筛选里）',
      'toast.batchRestored': '已还原 {count} 个会话',
      'toast.batchRestoredPending': '已还原 {count} 个会话，重启应用后会回到列表',
      'toast.batchRestoredPartial': '已还原 {done} 个；{failed} 个没能还原：日志仍被占用，关掉那些会话后再试',
      'toast.batchPurged': '已彻底删除 {count} 个会话',
      'toast.batchPurgedPartial': '已彻底删除 {done} 个；{failed} 个没能删除',
      'confirm.title': '删除会话',
      'confirm.desc': '「{title}」将移入回收站，{days} 天后自动彻底删除。期间可在 设置 → 回收站 里还原。',
      'confirm.descBatch': '选中的 {count} 个会话将移入回收站，{days} 天后自动彻底删除。期间可在 设置 → 回收站 里还原。',
      'confirm.action': '移入回收站',
      'confirm.busy': '处理中…',
      'confirm.skip': '下次不再提示',
      'cancel': '取消',
      'toast.undo': '撤销',
      'toast.undone': '已撤销，{count} 个会话已还原',
      'toast.undonePending': '已撤销，{count} 个会话会在重启应用后回到列表',
      'toast.undoExpired': '撤销时间已过，可以到 设置 → 回收站 里还原',
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
      'recycle.intro': '删除的会话会先放在这里，保留 {days} 天，到期后自动彻底删除。日志文件在此期间仍完整保存在本机。',
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
      'recycle.askPurge': '确认删除',
      'recycle.askEmpty': '确认清空',
      'recycle.reload': '重载页面',
      'recycle.reloadHint': '删除的会话会立刻从侧边栏隐藏；还原会把它挂回应用的工作区注册表，并让页面重新读取会话清单，所以通常不需要重启应用。只有日志里没有记下工作目录的会话例外：应用自己不会列它，重启也一样。',
      'recycle.total': '共 {count} 个会话 · 占用 {size}',
      'recycle.ask': '移入回收站前先确认',
      'recycle.pickAll': '选中这一页的所有会话',
      'recycle.pickOne': '选中「{title}」',
      'recycle.restorePicked': '还原({count})',
      'recycle.purgePicked': '彻底删除({count})',
      'recycle.askPurgePicked': '确认删除',
      'recycle.batchWorking': '处理中 {done} / {total}…',
      'recycle.expiring': '有 {count} 个会话将在 {days} 天内被彻底删除',
      'recycle.expiringPick': '选中它们',
      'recycle.keep': '保留期',
      'recycle.keepDays': '{days} 天',
      'recycle.keepHint': '回收站里的会话都按这个天数算，从删除那天起。改小之后已经超过新天数的，会立刻彻底删除。',
      'recycle.askWindow': '改成 {days} 天后，有 {count} 个会话已经超过这个天数，会立刻彻底删除。',
      'recycle.confirmWindow': '确认改成 {days} 天',
      'toast.retentionChanged': '保留期已改为 {days} 天',
      'toast.retentionPurged': '保留期已改为 {days} 天，{count} 个会话已到期并彻底删除',
      'recycle.errorLoad': '读取回收站失败',
      'empty': '（无标题）',
    };

    const en = {
      'menu.delete': 'Delete session',
      'menu.deleting': 'Deleting…',
      'menu.deleted': 'This session is already deleted',
      'batch.button': 'Delete sessions in bulk',
      'batch.title': 'Delete sessions',
      'batch.desc': 'Tick the sessions to delete: they move to the recycle bin and are permanently deleted after {days} days, restorable meanwhile from Settings → Recycle bin.',
      'batch.selected': '{selected} of {total} selected',
      'batch.all': 'Select all',
      'batch.none': 'Select none',
      'batch.archivedTag': 'archived',
      'batch.action': 'Move to recycle bin ({count})',
      'batch.busy': 'Deleting {done} of {total}…',
      'batch.ungrouped': 'Ungrouped',
      'batch.groupPick': 'Select every session in “{group}”',
      'toast.batchTrashed': 'Moved {count} sessions to the recycle bin (restore them in Settings → Recycle bin)',
      'toast.batchPartial': 'Moved {done}; {failed} could not be moved — their logs are still in use, so close those sessions and retry',
      'toast.batchEmpty': 'No sessions to delete',
      'toast.batchEmptyArchived': 'No sessions to delete ({hidden} archived sessions are outside the current filter)',
      'toast.batchRestored': 'Restored {count} sessions',
      'toast.batchRestoredPending': 'Restored {count} sessions; they return to the list when the app restarts',
      'toast.batchRestoredPartial': 'Restored {done}; {failed} could not be restored — their logs are still in use, so close those sessions and retry',
      'toast.batchPurged': 'Permanently deleted {count} sessions',
      'toast.batchPurgedPartial': 'Permanently deleted {done}; {failed} could not be deleted',
      'confirm.title': 'Delete session',
      'confirm.desc': '“{title}” moves to the recycle bin and is permanently deleted after {days} days. Restore it meanwhile from Settings → Recycle bin.',
      'confirm.descBatch': 'The {count} selected sessions move to the recycle bin and are permanently deleted after {days} days. Restore them meanwhile from Settings → Recycle bin.',
      'confirm.action': 'Move to recycle bin',
      'confirm.busy': 'Working…',
      'confirm.skip': "Don't ask again",
      'cancel': 'Cancel',
      'toast.undo': 'Undo',
      'toast.undone': 'Undone — {count} session(s) restored',
      'toast.undonePending': 'Undone — {count} session(s) return to the list after a restart',
      'toast.undoExpired': 'The undo window has passed; restore it in Settings → Recycle bin',
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
      'recycle.columnWorkspace': 'Folder',
      'recycle.columnTrashed': 'Deleted',
      'recycle.columnLeft': 'Left',
      'recycle.daysLeft': '{days} d',
      'recycle.expired': 'due now',
      'recycle.restore': 'Restore',
      /*
       * The row buttons have to fit one fixed 166px track (the table's grid
       * template), and English is the locale that has to be measured rather than
       * assumed: "Delete forever" beside "Restore" came to 190px, so every row
       * wrapped and the two buttons stacked on top of each other. So the pair is
       * "Restore" / "Delete" — ~138px together — and the armed second click says
       * "Confirm" (144px with both still on screen). "Delete" is unambiguous in a
       * recycle bin: there is nothing else in there to do to a row.
       */
      'recycle.purge': 'Delete',
      'recycle.emptyBin': 'Empty recycle bin',
      'recycle.refresh': 'Refresh',
      'recycle.working': 'Working…',
      'recycle.askPurge': 'Confirm',
      'recycle.askEmpty': 'Confirm empty',
      'recycle.reload': 'Reload page',
      'recycle.reloadHint': 'A deleted session leaves the sidebar at once. A restore re-attaches it to the app’s workspace registry and makes the page re-read its session list, so a restart is usually unnecessary. The exception is a session whose log recorded no working directory: the app itself will not list it, restart or not.',
      'recycle.total': '{count} session(s) · {size}',
      'recycle.ask': 'Confirm before moving to the recycle bin',
      'recycle.pickAll': 'Select every session on this page',
      'recycle.pickOne': 'Select “{title}”',
      'recycle.restorePicked': 'Restore ({count})',
      'recycle.purgePicked': 'Delete ({count})',
      'recycle.askPurgePicked': 'Confirm',
      'recycle.batchWorking': 'Working {done} of {total}…',
      'recycle.expiring': '{count} session(s) are permanently deleted within {days} days',
      'recycle.expiringPick': 'Select them',
      'recycle.keep': 'Keep for',
      'recycle.keepDays': '{days} days',
      'recycle.keepHint': 'Every session in the bin is kept this many days from the day it was deleted. Shortening it deletes whatever is already past the new window.',
      'recycle.askWindow': 'At {days} days, {count} session(s) in the bin are already past it and are permanently deleted now.',
      'recycle.confirmWindow': 'Use {days} days',
      'toast.retentionChanged': 'Retention is now {days} days',
      'toast.retentionPurged': 'Retention is now {days} days; {count} session(s) had expired and were deleted',
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
      // The sidebar's section header ("工作区" + search + view options + add):
      // this is the batch entry point, and it copies that row's own icon box —
      // 28px, `radius-sm`, secondary ink, hover fill — so a fourth control there
      // reads as one of the row's own rather than as something bolted on.
      '.dsds_headerButton{border-radius:var(--dsw-radius-sm);width:28px;height:28px;padding:0;border:none;',
      'background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none;',
      'justify-content:center;align-items:center;display:inline-flex}',
      '.dsds_headerButton:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsds_headerButton:focus-visible{outline:var(--dsw-focus-ring-width) solid ',
      'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}',
      '.dsds_headerButton:disabled{opacity:.4;cursor:default}',
      '.dsds_headerButton svg{width:16px;height:16px;display:block}',
      /*
       * The app's own tooltip, copied: dark bubble, 13px label, `radius-sm`, and
       * `position:fixed` so the host's `overflow:hidden` rows cannot clip it. The
       * geometry is the host's too (centred under the control, 8px below it) —
       * `dsds_tip` is what a native `title` attribute would have looked like if
       * the platform drew it the way this app does, which it does not: the native
       * one is a white OS box that matches nothing else on screen.
       *
       * `z-index:1100` is the host's own value for a PORTALED tooltip. It matters
       * here: the session row raises its hover card at `z-index:100` after 800ms,
       * and a bubble below that would end up behind the card it is annotating.
       */
      '.dsds_tip{display:inline-flex;align-items:center;gap:8px;position:fixed;z-index:1100;',
      'width:max-content;max-width:50vw;padding:3px 7px;border-radius:var(--dsw-radius-sm);',
      'background:var(--dsw-alias-tooltip-bg);color:var(--dsw-static-neutral-bluish-00);',
      'font-size:13px;line-height:20px;white-space:pre-line;overflow-wrap:break-word;',
      'pointer-events:none;transform:translateX(-50%);animation:dsds_tip_in 150ms var(--ds-ease-in-out)}',
      '.dsds_tip[hidden]{display:none}',
      '@keyframes dsds_tip_in{from{opacity:0}}',
      '@media (prefers-reduced-motion:reduce){.dsds_tip{animation:none}}',
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
      // A message that carries an action lays out as one row: the sentence, then
      // the way to take it back.
      '.dsds_toastRow{align-items:center;gap:12px;text-align:start;display:flex}',
      '.dsds_toastAction{background:0 0;border:none;color:var(--dsw-alias-brand-primary);cursor:pointer;',
      'font:inherit;font-size:13px;line-height:20px;padding:0;white-space:nowrap;flex:none}',
      '.dsds_toastAction:hover:not(:disabled){text-decoration:underline}',
      '.dsds_toastAction:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
      // Settings page: same shape and spacing as the shipped settings sections.
      '.dsds_section{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}',
      // The title shares its line with the one switch that governs the whole
      // page: the switch sits right beside the title, where the eye lands, not
      // pushed to the far edge of a row that is 720px wide. It wraps rather than
      // shrinks when a translation is long.
      '.dsds_sectionHead{align-items:center;gap:8px 12px;flex-wrap:wrap;display:flex}',
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
       *
       * The leading 16px track is the batch tick box — the exact box its own
       * rule asks for, so the header's tick and every row's tick land on one
       * column, and the whole table shifts by one track rather than by a
       * measured amount the next locale could invalidate.
       */
      '.dsds_row{box-sizing:border-box;display:grid;align-items:center;gap:12px;padding:10px 14px;',
      'font-size:13px;line-height:20px;',
      'grid-template-columns:16px minmax(0,2.2fr) minmax(0,1.2fr) 110px 56px 166px}',
      '.dsds_pickCell{display:flex;align-items:center}',
      '.dsds_pickCell input{width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}',
      '.dsds_pickCell input:disabled{cursor:default}',
      // The expiring notice wears the app's own warning colour, so "these go
      // away soon" reads as a warning rather than as another line of grey help.
      '.dsds_expiring{color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-secondary));',
      'font-size:12px;line-height:18px;margin:0;display:flex;align-items:center;gap:8px}',
      '.dsds_expiring .dsds_link{color:inherit}',
      /*
       * The retention picker. A native `<select>` on purpose: it is the one
       * control the shell's own settings pages use for a short fixed list, it
       * carries the platform's keyboard and screen-reader behaviour for free, and
       * there is no menu to position inside a settings page.
       */
      '.dsds_field{align-items:center;gap:8px;color:var(--dsw-alias-label-primary);',
      'font-size:13px;line-height:20px;display:flex;flex-wrap:wrap}',
      '.dsds_select{box-sizing:border-box;background:var(--dsw-alias-bg-layer-2,transparent);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));',
      'border-radius:var(--dsw-radius-md,8px);color:inherit;cursor:pointer;font:inherit;',
      'padding:4px 8px}',
      '.dsds_select:disabled{opacity:.6;cursor:default}',
      // A window that would delete something the moment it is applied: the field
      // row's own shape, with the count stated and the last word left to a click.
      '.dsds_windowAsk{align-items:center;gap:8px;flex-wrap:wrap;display:flex}',
      '.dsds_warn{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin:0}',
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
      /*
       * The batch controls ride in the header row's action cell, inside the very
       * same 166px track as the rows' own buttons — which is why they are the row
       * buttons one size down rather than a new control of their own. The header's
       * label rule clips its children (`overflow:hidden`, `white-space:nowrap`),
       * and clipping a button is worse than moving it: this cell is released from
       * both so an over-long locale wraps instead of losing a word.
       */
      '.dsds_rowHead>span.dsds_rowActions{overflow:visible;white-space:normal}',
      // 12px text on a 12px line plus 3px of padding and a 1px border is exactly
      // the 20px the header's own labels occupy, so ticking a row does not make
      // the header taller and shove the table down by two pixels.
      '.dsds_rowHead .dsds_button{padding:3px 8px;font-size:12px;line-height:12px}',
      '.dsds_rowHead .dsds_note{font-weight:400}',
      '.dsds_error{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-secondary));font-size:13px;margin:0}',
      '.dsds_note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:0}',
      // A checkbox label, copied from the host's own `.checkbox`: 16px box, the
      // brand accent, the label's own line box beside it.
      '.dsds_check{align-items:center;gap:8px;color:var(--dsw-alias-label-primary);cursor:pointer;',
      'font-size:13px;line-height:20px;display:flex}',
      '.dsds_check input{flex:0 0 auto;width:16px;height:16px;margin:0;',
      'accent-color:var(--dsw-alias-brand-primary);cursor:inherit}',
      '.dsds_check input:focus-visible{outline:2px solid var(--dsw-alias-border-l3,rgba(127,127,127,.4));outline-offset:1px}',
      /*
       * The one switch that sits beside a section title instead of on a row of
       * its own: drawn one size down (the app's caption size, which the hint
       * lines below it already use), so the heading still leads the line, and its
       * box goes down to the label's own size — a 16px box beside 12px text reads
       * as two controls rather than one.
       *
       * BOTH classes, deliberately. `.dsds_headCheck` alone has exactly the
       * specificity of `.dsds_check` above, so which one wins would come down to
       * the order of two lines in this array — and it lost: the box stayed 16px
       * and the text 13px while the sheet "contained" the smaller numbers. Naming
       * both classes makes the override win on specificity, wherever it sits.
       */
      '.dsds_check.dsds_headCheck{font-size:12px;line-height:18px}',
      '.dsds_check.dsds_headCheck input{flex:0 0 auto;width:12px;height:12px}',
      /*
       * The batch picker. Its list is the one surface whose height must not follow
       * its content — a workspace can hold a hundred sessions — so the box scrolls
       * and the card keeps the same shape whatever it holds. The ticked rows reuse
       * `.dsds_check`, which is already the host's own checkbox rule.
       */
      '.dsds_cardWide{width:min(480px,100%)}',
      '.dsds_pickBar{justify-content:space-between;align-items:center;gap:8px;display:flex;',
      'color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.dsds_link{background:0 0;border:none;color:var(--dsw-alias-brand-primary);cursor:pointer;',
      'font:inherit;font-size:12px;line-height:18px;padding:0}',
      '.dsds_link:hover:not(:disabled){text-decoration:underline}',
      '.dsds_link:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
      '.dsds_pickList{max-height:min(46vh,320px);overflow-y:auto;margin:0;padding:6px;list-style:none;',
      'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.24));',
      'border-radius:var(--dsw-radius-md,8px);display:flex;flex-direction:column;gap:2px}',
      '.dsds_pickRow{min-width:0}',
      '.dsds_pickRow .dsds_check{gap:8px;min-width:0}',
      // A session sits UNDER its group, at the app's own indent step (the
      // sidebar indents a session row by 28px past its group row), so the two
      // lists read as the same list.
      '.dsds_pickSession{padding-inline-start:28px}',
      // A group's own row inside the list: the same tick box, so one click takes
      // a whole workspace out of the run; the rest of the row is the fold.
      '.dsds_pickGroup{align-items:center;gap:8px;margin-top:4px;',
      'color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;display:flex}',
      '.dsds_pickGroup:first-child{margin-top:0}',
      '.dsds_pickGroup .dsds_check{gap:8px;min-width:0;flex:none}',
      '.dsds_pickFold{border:none;background:0 0;font:inherit;color:inherit;cursor:pointer;padding:0;',
      'text-align:start;gap:6px;align-items:center;min-width:0;flex:1;display:flex}',
      '.dsds_pickFold:hover{color:var(--dsw-alias-label-secondary)}',
      '.dsds_pickFold:focus-visible{outline:2px solid var(--dsw-alias-border-l3,rgba(127,127,127,.4));outline-offset:2px}',
      '.dsds_foldArrow{width:10px;height:10px;flex:none;transition:transform .15s var(--ds-ease-in-out)}',
      '.dsds_foldArrowOpen{transform:rotate(90deg)}',
      '.dsds_pickGroupLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;font-weight:500;overflow:hidden}',
      '.dsds_pickTitle{text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;overflow:hidden}',
      '.dsds_pickTag{color:var(--dsw-alias-label-tertiary);border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));',
      'border-radius:var(--dsw-radius-xs,4px);flex:none;font-size:11px;line-height:16px;padding:0 4px}',
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

    /**
     * How long a session deleted from now on stays restorable.
     *
     * The Host owns this number — it stamps every delete with it — so this is a
     * cache of what it last answered, not a second source of truth. It exists
     * because a confirmation has to quote a window BEFORE the delete happens, and
     * the plugin used to quote the literal 15, which stopped being true the day
     * the window became configurable. The default covers only the moment before
     * the Host has answered at all.
     *
     * It is declared here, above the store, because the snapshot carries it: a
     * `let` read during the store's own initialisation has to exist by then.
     */
    let retentionDays = 15;

    /** Take the Host's answer (or the page's own change) as the number to quote. */
    function setRetentionDays(value) {
      const days = Number(value);
      if (!Number.isFinite(days) || days <= 0 || retentionDays === days) return;
      retentionDays = days;
      publish();
    }

    /**
     * Ask the Host for the retention window once, at startup.
     *
     * `retention` with no `days` is a read, and a cheap one: it neither sweeps nor
     * repairs, so a page load that only wants a number for its dialog does not
     * drag a bin maintenance pass along with it. A refusal is not worth a message
     * — the plugin keeps quoting the default until something answers.
     *
     * @returns resolves once the answer (or the refusal) is settled.
     */
    function loadRetention() {
      return call('retention').then((payload) => {
        setRetentionDays(payload?.retentionDays);
      }, () => undefined);
    }

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

    /**
     * The open batch request, or null.
     *
    /*
     * Shape: `{ groups, items, folded, selected, phase, done, days }`, where
     * `groups` is `[{ key, label, items }]` in the sidebar's own order, `items` is
     * those groups flattened into `[{ sessionId, displayTitle, archived }]` (the
     * run order), `folded` is a Set of group keys the reader has closed (a view
     * state: closing a group never changes what is ticked), and `selected` is a
     * Set of ids. The whole object is replaced on every change rather than
     * mutated, because the components read it through a snapshot that is
     * compared by identity.
     */
    let batch = null;

    /** The message currently shown, or null. */
    let toast = null;

    /** Monotonic revision so every publish is observable as a new snapshot. */
    let revision = 0;

    const listeners = new Set();

    /** Publish a fresh snapshot so every subscribed component re-renders. */
    const publish = () => {
      revision += 1;
      snapshot = { removed: removed, inFlight: inFlight, pending: pending, batch: batch, toast: toast, ask: askBeforeDelete, days: retentionDays, revision: revision };
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
    let snapshot = { removed: removed, inFlight: inFlight, pending: pending, batch: batch, toast: toast, ask: askBeforeDelete, days: retentionDays, revision: revision };

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
     * Replace the batch request. Every field is written through this, so the
     * snapshot the components compare by identity always changes.
     */
    function setBatch(request) {
      batch = request;
      publish();
    }

    /** Close the batch dialog; a request in flight is left to finish. */
    function closeBatch() {
      if (batch === null) return;
      if (batch.phase === 'busy') return;
      setBatch(null);
    }

    /** Tick or untick one session in the open batch request. */
    function toggleBatchItem(sessionId) {
      if (batch === null || batch.phase !== 'pick') return;
      const selected = new Set(batch.selected);
      if (selected.has(sessionId)) selected.delete(sessionId);
      else selected.add(sessionId);
      setBatch({ ...batch, selected: selected });
    }

    /** Tick every session in the request, or none of them. */
    function setBatchChoice(all) {
      if (batch === null || batch.phase !== 'pick') return;
      const selected = all
        ? new Set(batch.items.map((item) => item.sessionId))
        : new Set();
      setBatch({ ...batch, selected: selected });
    }

    /**
     * Fold or unfold one group's sessions in the batch list.
     *
     * A view state, never a decision: the ticks stay where they were, so folding
     * a group away and deleting is the same as leaving it open and deleting.
     *
     * @param key - the group's key, as the request holds it.
     */
    function toggleBatchGroup(key) {
      if (batch === null || batch.phase !== 'pick') return;
      const folded = new Set(batch.folded);
      if (folded.has(key)) folded.delete(key);
      else folded.add(key);
      setBatch({ ...batch, folded: folded });
    }

    /**
     * Tick or untick one group's sessions, leaving every other group alone.
     *
     * The dialog lists the whole sidebar, so the thing a reader most often wants
     * is one workspace out of it — and doing that by un-ticking forty rows one at
     * a time is what makes a batch list useless.
     *
     * @param key - the group's key, as the request holds it.
     * @param all - true to tick that group, false to untick it.
     */
    function setBatchGroupChoice(key, all) {
      if (batch === null || batch.phase !== 'pick') return;
      const group = batch.groups.find((entry) => entry.key === key);
      if (group === undefined) return;
      const selected = new Set(batch.selected);
      for (const item of group.items) {
        if (all) selected.add(item.sessionId);
        else selected.delete(item.sessionId);
      }
      setBatch({ ...batch, selected: selected });
    }

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

    /**
     * Start deleting the ticked sessions, through the SAME confirmation a single
     * row goes through.
     *
     * A batch used to be the one destructive path with no second thought: the
     * dialog's own button was the last word, while one row asked first and one
     * dialog offered "don't ask again" that the batch then ignored. Both now go
     * through one question, one switch, and one card — the tick list is what the
     * card names, and the ids are frozen into the request so the run deletes
     * exactly what was confirmed even if the dialog is closed underneath it.
     */
    function requestBatchDelete() {
      const request = batch;
      if (request === null || request.phase !== 'pick') return;
      const ids = request.items.filter((item) => request.selected.has(item.sessionId)).map((item) => item.sessionId);
      if (ids.length === 0) return;
      if (askBeforeDelete) {
        setPending({ sessionIds: ids, displayTitle: '', count: ids.length });
        return;
      }
      void runBatch(ids);
    }

    /**
     * Show one message, optionally with an action attached.
     *
     * @param kind - the message's dictionary key suffix, under `toast.`.
     * @param params - the placeholders the message takes.
     * @param undo - `{ sessionIds }` to offer "undo" on this message; the caller
     *   that has something to undo passes it, everything else just speaks.
     */
    const showToast = (kind, params, undo) => {
      toast = {
        kind: kind,
        params: params ?? null,
        undo: undo === undefined
          ? null
          : { sessionIds: undo.sessionIds, expiresAt: Date.now() + UNDO_WINDOW_MS, phase: 'ready' },
      };
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
        // Host forgets it at the next restart. That case carries no undo — there
        // is no entry in the bin to bring back.
        if (report.moved === false) showToast('discarded');
        else showToast('trashed', undefined, { sessionIds: [sessionId] });
      } catch (error) {
        showToast(failureToast(error));
      } finally {
        const settled = new Set(inFlight);
        settled.delete(sessionId);
        inFlight = settled;
        publish();
      }
    }

    /*
     * --- the batch request -------------------------------------------------
     *
     * A whole group in one action. The two halves are deliberately split: what a
     * group HOLDS comes from the app's own state and never from the rows on
     * screen — a collapsed group renders none of its sessions and a long one
     * renders only the first few, so a list read off the DOM would quietly miss
     * sessions the user meant to delete — and the tick list is this plugin's own
     * dialog, because a Workspace row is the app's own markup and offers a
     * client plugin no seat to contribute to.
     */

    /** The client-side Workspace controller, or undefined outside a shell. */
    function workspaceController() {
      try {
        return clientContext?.get?.('uiWorkspace') ?? undefined;
      } catch (error) {
        return undefined;
      }
    }

    /** The key the Workspace browser persists its own view state under. */
    const VIEW_KEY_PREFIX = 'dsh.workspace.view.';

    /**
     * The archived filter the sidebar is drawing with right now.
     *
     * `default` hides archived sessions, `only` shows nothing but them, `show`
     * lists everything. The value belongs to the browser's own view store, which
     * persists itself to local storage under a versioned key, so the key is
     * discovered rather than hard-coded: a Harness that moves `…view.v5` on to
     * `v6` must not silently make this plugin list the wrong sessions. Anything
     * unreadable means `default`, which is the shipped default too.
     *
     * @returns 'default' | 'show' | 'only'.
     */
    function readArchivedFilter() {
      try {
        const storage = window.localStorage;
        let newest = '';
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          if (typeof key === 'string' && key.startsWith(VIEW_KEY_PREFIX) && key > newest) newest = key;
        }
        if (newest === '') return 'default';
        const parsed = JSON.parse(storage.getItem(newest) ?? 'null');
        const state = parsed?.state ?? parsed?.data ?? parsed ?? {};
        const value = state['archivedFilter'];
        return value === 'show' || value === 'only' ? value : 'default';
      } catch (error) {
        return 'default';
      }
    }

    /** A directory's last segment, for a Workspace that carries no title. */
    function baseName(path) {
      const parts = String(path ?? '').split(/[\\/]/).filter((part) => part !== '');
      return parts.length === 0 ? '' : parts[parts.length - 1];
    }

    /**
     * Everything one group's batch request needs, read from the app.
     *
     * The membership rule is the sidebar's own (`sessionVisible` in
     * `@deepseek-ai/dsh-client-ui-workspace`): subagent children are listed under
     * their parent instead of in the tree, the New Session placeholder is not a
     * session yet, and archived rows follow the filter the user picked. The
     * difference is where the list stops — at what the group ACCOUNTS, not at
     * what happens to be rendered.
     *
     * @param workspaceKey - the group's key: a workspace id, or '' for the
     *   ungrouped bucket.
     * @returns `{ label, items, hidden }`, or null when the app cannot answer or
     *   the group cannot be found.
     */
    function groupBatchTargets(workspaceKey) {
      const controller = workspaceController();
      let workspaces;
      let sessions;
      try {
        workspaces = controller?.workspaces?.list?.getSnapshot?.();
        sessions = controller?.sessions?.list?.getSnapshot?.();
      } catch (error) {
        return null;
      }
      const groups = Array.isArray(workspaces?.items) ? workspaces.items : null;
      const byId = sessions?.byId;
      if (groups === null || typeof byId !== 'object' || byId === null) return null;
      const workspace = workspaceKey === ''
        ? undefined
        : groups.find((item) => item?.workspaceId === workspaceKey);
      if (workspaceKey !== '' && workspace === undefined) return null;
      const archived = new Set(Array.isArray(workspaces.archivedSessionIds) ? workspaces.archivedSessionIds : []);
      const filter = readArchivedFilter();
      const accounted = new Set();
      for (const group of groups) {
        for (const id of Array.isArray(group?.sessionIds) ? group.sessionIds : []) accounted.add(id);
      }
      const ids = workspace === undefined
        ? (Array.isArray(sessions.ids) ? sessions.ids.filter((id) => !accounted.has(id)) : [])
        : (Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []);
      const items = [];
      let hidden = 0;
      for (const id of ids) {
        const summary = byId[id];
        if (summary === undefined || summary === null) continue;
        if (summary.origin === 'subagent' || summary.blank === true) continue;
        // A session already moved to the bin is hidden from the sidebar but still
        // in the app's registry until it restarts: listing it again would offer a
        // row nobody can see, and deleting it again has nothing left to move.
        if (removed.has(id)) continue;
        const isArchived = archived.has(id);
        if ((filter === 'default' && isArchived) || (filter === 'only' && !isArchived)) {
          hidden += 1;
          continue;
        }
        items.push({
          sessionId: id,
          displayTitle: typeof summary.title === 'string' ? summary.title : '',
          archived: isArchived,
        });
      }
      const label = workspace === undefined
        ? ''
        : (typeof workspace.title === 'string' && workspace.title !== '' ? workspace.title : baseName(workspace.path));
      return { label: label === '' ? text('batch.ungrouped') : label, items: items, hidden: hidden };
    }

    /**
     * The groups the sidebar is drawing, in its own order, and whether each one
     * is showing its sessions.
     *
     * Read off the rows rather than derived from the Workspace ledger: the page
     * sorts groups by the order the user picked in its view options, and a list
     * of what to delete has to open in the order — and in the shape — the reader
     * is looking at. `aria-expanded` is the app's own answer to "is this group
     * open", so nothing here has to guess.
     *
     * @returns `[{ key, folded }]`, top to bottom, including '' for ungrouped.
     */
    function renderedGroups() {
      if (typeof document === 'undefined') return [];
      const rows = [];
      for (const row of document.querySelectorAll(GROUP_ROW_SELECTOR)) {
        const key = String(row.getAttribute('data-row-key') ?? '').slice(GROUP_KEY_PREFIX.length);
        if (rows.some((entry) => entry.key === key)) continue;
        rows.push({ key: key, folded: row.getAttribute('aria-expanded') === 'false' });
      }
      return rows;
    }

    /**
     * Everything the sidebar can delete, in one request.
     *
     * Every group the page draws, in its own order, plus any group the page is
     * not drawing right now (a search is on, or the group is folded away): those
     * still hold sessions, and a list that silently dropped them would be a list
     * that lies about what "all" means. Groups with nothing to delete are left
     * out, so the dialog shows only sections that carry a decision.
     *
     * @returns `{ groups, items, hidden, folded }`; `items` is the flat run
     *   order and `folded` the groups the sidebar is showing closed.
     */
    function sidebarBatchTargets() {
      const groups = [];
      const items = [];
      const folded = new Set();
      let hidden = 0;
      const seen = new Set();
      const append = (key) => {
        if (seen.has(key)) return;
        seen.add(key);
        const targets = groupBatchTargets(key);
        if (targets === null) return;
        hidden += targets.hidden;
        if (targets.items.length === 0) return;
        groups.push({ key: key, label: targets.label, items: targets.items });
        for (const item of targets.items) items.push(item);
      };
      for (const row of renderedGroups()) {
        if (row.folded) folded.add(row.key);
        append(row.key);
      }
      const controller = workspaceController();
      let workspaces = null;
      try {
        workspaces = controller?.workspaces?.list?.getSnapshot?.();
      } catch (error) {
        workspaces = null;
      }
      for (const group of Array.isArray(workspaces?.items) ? workspaces.items : []) {
        if (typeof group?.workspaceId === 'string') append(group.workspaceId);
      }
      // The ungrouped bucket is a group too (the sidebar draws it as one), and
      // the ledger never lists it: it is whatever no workspace accounts for.
      append('');
      return { groups: groups, items: items, hidden: hidden, folded: folded };
    }

    /**
     * Open the batch dialog over everything the sidebar holds.
     */
    function openBatch() {
      const targets = sidebarBatchTargets();
      if (targets.items.length === 0) {
        showToast(targets.hidden > 0 ? 'batchEmptyArchived' : 'batchEmpty', { hidden: targets.hidden });
        return;
      }
      setBatch({
        groups: targets.groups,
        items: targets.items,
        // Nothing is ticked on open. The button is on the sidebar's title row now,
        // one click away from every session the app holds: a dialog that opened
        // fully armed would put "delete everything" behind a single click, and
        // the list is there to be chosen from anyway.
        selected: new Set(),
        // Nothing ticked, and the folds the sidebar is already showing: the list
        // opens in the shape the reader is looking at, and a group they folded
        // away on the sidebar stays folded here. A tick is a decision and a fold
        // is not, which is why one starts empty and the other does not.
        folded: new Set(targets.folded),
        phase: 'pick',
        done: 0,
        // The Host's own number when it has answered, so the sentence is right
        // before the `list` call below can correct it.
        days: retentionDays,
      });
      // The retention window is the Host's number, not this file's: read it the
      // way the settings page does and correct the sentence when it answers. A
      // refusal is not worth a message — the dialog opened with the default, and
      // the delete itself reports anything that is really wrong.
      call('list').then((payload) => {
        const days = typeof payload?.retentionDays === 'number' && payload.retentionDays > 0 ? payload.retentionDays : 0;
        if (days === 0) return;
        setRetentionDays(days);
        if (batch === null) return;
        setBatch({ ...batch, days: days });
      }, () => {});
    }

    /**
     * Move a list of sessions to the bin, in order, reporting each one.
     *
     * One request per session rather than one request for all of them. The Host's
     * delete is a file-by-file move whose per-session answer (moved, deferred,
     * no log left at all) is what the page reconciles against; a batch endpoint
     * would have to restate all of it, and a failure halfway through would leave
     * the page guessing which of its rows are gone.
     *
     * @param targets - `[{ sessionId, displayTitle }]`, in the order to work.
     * @param onProgress - called with the number finished after each attempt.
     * @returns `{ done, failed }`; each failure carries the error's `reason`.
     */
    async function performBatchDelete(targets, onProgress) {
      const failed = [];
      const deletedIds = [];
      let done = 0;
      for (const target of targets) {
        if (!inFlight.has(target.sessionId)) {
          inFlight = new Set(inFlight).add(target.sessionId);
          publish();
        }
        try {
          const hinted = typeof target.displayTitle === 'string' && target.displayTitle.trim() !== ''
            ? { title: target.displayTitle.trim() }
            : undefined;
          await call('delete', target.sessionId, hinted);
          tombstone(target.sessionId);
          handBackMainView(target.sessionId);
          deletedIds.push(target.sessionId);
          done += 1;
        } catch (error) {
          failed.push({ sessionId: target.sessionId, reason: error?.reason ?? 'failed' });
          console.warn('[delete-session] batch delete refused ' + target.sessionId, error);
        } finally {
          const settled = new Set(inFlight);
          settled.delete(target.sessionId);
          inFlight = settled;
          publish();
        }
        if (typeof onProgress === 'function') onProgress(done);
      }
      return { done: done, failed: failed, deletedIds: deletedIds };
    }

    /**
     * Delete the ticked sessions in the open request, then say what happened.
     * @param only - the exact sessions to delete, for a run confirmed elsewhere
     *   (the card carries its own frozen list); omitted means "whatever is ticked".
     */
    async function runBatch(only) {
      const request = batch;
      if (request === null || request.phase !== 'pick') return;
      const wanted = only === undefined ? request.selected : new Set(only);
      const targets = request.items.filter((item) => wanted.has(item.sessionId));
      if (targets.length === 0) return;
      setBatch({ ...request, phase: 'busy', done: 0 });
      const report = await performBatchDelete(targets, (done) => {
        // The dialog stays open for the whole run and keeps counting, so moving
        // forty sessions reads as progress instead of a frozen window.
        if (batch !== null && batch.phase === 'busy') setBatch({ ...batch, done: done });
      });
      setBatch(null);
      if (report.failed.length === 0) {
        // The whole run can be taken back from the same message, as long as the
        // window holds: one restore per session, in the order they were deleted.
        showToast('batchTrashed', { count: report.done }, { sessionIds: report.deletedIds });
        return;
      }
      const unauthorized = report.failed.every((entry) => entry.reason === 'unauthorized');
      showToast(unauthorized ? 'unauthorized' : 'batchPartial', {
        done: report.done,
        failed: report.failed.length,
      });
    }

    /**
     * Put back what the message on screen just deleted.
     *
     * The undo is a restore, not a second kind of delete: it goes through the
     * same one-request-per-session runner the recycle-bin page uses, so a session
     * comes back with its log in place, its account restored and its row
     * un-hidden — and a refusal reads exactly as it would from that page. The
     * window is checked here rather than trusted from the render: a message that
     * a later publish kept on screen must not still be able to act.
     *
     * @returns resolves once the restore finished and was reported.
     */
    async function undoTrash() {
      const current = toast;
      const request = current === null ? null : current.undo;
      if (request === null || request === undefined || request.phase === 'busy') return;
      if (Date.now() > request.expiresAt) {
        showToast('undoExpired');
        return;
      }
      toast = { ...current, undo: { ...request, phase: 'busy' } };
      publish();
      const report = await performBinBatch(
        'restore',
        request.sessionIds.map((sessionId) => ({ sessionId: sessionId })),
      );
      if (report.done === 0) {
        // Nothing came back: the first refusal names the case, through the same
        // mapping every other refusal on this page goes through.
        showToast(failureToast(report.failed[0]?.error));
        return;
      }
      if (report.failed.length > 0) {
        showToast('batchRestoredPartial', { done: report.done, failed: report.failed.length });
        return;
      }
      const listed = await relistRestoredSessions(report.restoredIds);
      showToast(listed === report.done ? 'undone' : 'undonePending', { count: report.done });
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
     * The page's own row for a session, or undefined when its list has none.
     *
     * The sidebar draws rows from this list, so this is the only place that can
     * answer "is the restored row really back, and does it carry its title".
     *
     * @param sessionId - the session to look up.
     * @returns the summary the sidebar reads, when there is one.
     */
    function sessionRow(sessionId) {
      const sessions = sessionsService();
      if (sessions === undefined || sessions === null) return undefined;
      try {
        return sessions.list?.getSnapshot?.()?.byId?.[sessionId];
      } catch (error) {
        return undefined;
      }
    }

    /**
     * Whether a restored row came back without the title the bin knew it by.
     *
     * The summary the Host holds for a session whose log sat in the bin was built
     * while it was away, so it carries no stored title — and the sidebar draws
     * 未命名 for a session with none, which is what a restore looked like until
     * the row was opened. Only a title the bin really recorded is asked back: an
     * entry that never had one has nothing to restore, and a row the Host titles
     * differently is the Host's business, not this plugin's.
     *
     * @param entry - the bin entry that was restored.
     * @param row - the page's row for it, when the list has one.
     * @returns whether the row is missing a title the bin knows.
     */
    function wantsTitleBack(entry, row) {
      const known = typeof entry?.title === 'string' ? entry.title.trim() : '';
      if (known === '' || known === entry?.sessionId) return false;
      const shown = typeof row?.title === 'string' ? row.title.trim() : '';
      return shown === '';
    }

    /**
     * Put restored sessions back on the page, titles and all, before they show.
     *
     * A restore makes three separate things true in three places: the log is back
     * on disk (the bin's business), the session is a member of its workspace again
     * (the Host's registry), and the sidebar row is whatever the page's own
     * Session list says. The last two belong to the window, and this settles them
     * BEFORE any tombstone is lifted: showing the row first and repairing it
     * afterwards is what a restore used to look like — 未命名, and once in the
     * wrong group, until something else happened to refresh the page.
     *
     * A row that comes back without its title gets one more step: the session is
     * resumed through the app's own idempotent adopt call (`session.create` with
     * an id it already knows), which makes the Host fold the log again — the same
     * thing opening the row does — and the list is re-read once more.
     *
     * @param pairs - `{ entry, report }` for every restore that succeeded.
     * @returns how many of them the page can draw.
     */
    async function settleRestoredRows(pairs) {
      const ids = pairs.map((pair) => pair.entry.sessionId);
      for (const pair of pairs) {
        // Membership first (the Host), then the row itself: `attached` says the
        // Host already handed the session to its workspace, and the page draws
        // rows from its own Session list.
        if (pair.report?.attached !== true) await adoptRestoredSession(pair.report, pair.entry.sessionId);
      }
      await relistRestoredSessions(ids);
      const titleless = pairs.filter((pair) => wantsTitleBack(pair.entry, sessionRow(pair.entry.sessionId)));
      if (titleless.length > 0) {
        for (const pair of titleless) await adoptRestoredSession(pair.report, pair.entry.sessionId);
        await relistRestoredSessions(titleless.map((pair) => pair.entry.sessionId));
      }
      // Only now may the rows appear: everything they are drawn from is in place.
      for (const pair of pairs) unTombstone(pair.entry.sessionId);
      return pairs.filter((pair) => pair.report?.attached === true || sessionRow(pair.entry.sessionId) !== undefined).length;
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
     * Whether the page's own Session list carries these sessions, after one refresh.
     *
     * The batch form of `relistRestoredSession`. One refresh serves the whole
     * batch, because a refresh re-reads the Host's Session list rather than one
     * session: what it puts back is every summary the app had dropped while the
     * log sat in the bin.
     *
     * @param sessionIds - the sessions a restore just put back on disk.
     * @returns how many of them the page's list now holds.
     */
    async function relistRestoredSessions(sessionIds) {
      const sessions = sessionsService();
      if (sessions === undefined || sessions === null || typeof sessions.refresh !== 'function') return 0;
      try {
        await sessions.refresh();
      } catch (error) {
        console.warn('[delete-session] the window would not refresh its Session list', error);
        return 0;
      }
      let byId;
      try {
        byId = sessions.list?.getSnapshot?.()?.byId;
      } catch (error) {
        return 0;
      }
      if (byId === undefined || byId === null) return 0;
      return sessionIds.filter((id) => byId[id] !== undefined).length;
    }

    /**
     * Run one recycle-bin action over a list of entries, in order.
     *
     * The same one-request-per-entry shape as the sidebar batch, for the same
     * reason: each entry's own answer is what the page reconciles against, and a
     * failure in the middle must leave the finished ones finished and the rest
     * untouched. A restore carries its follow-up here too — the window is settled
     * and only then are the tombstones lifted — because splitting that into the
     * component would keep one restore's rules in two places.
     *
     * @param action - 'restore' or 'purge'.
     * @param entries - the bin entries to work on, in the order to work.
     * @param onProgress - called with the number finished after each attempt.
     * @returns `{ done, failed, restoredIds, listed }`.
     */
    async function performBinBatch(action, entries, onProgress) {
      const failed = [];
      const restoredIds = [];
      const restored = [];
      let done = 0;
      for (const entry of entries) {
        try {
          const report = await call(action, entry.sessionId);
          if (action === 'restore') {
            // The tombstones are lifted by `settleRestoredRows`, once the window
            // really has the rows: see there for why the order matters.
            restored.push({ entry: entry, report: report });
            restoredIds.push(entry.sessionId);
          }
          done += 1;
        } catch (error) {
          // The refusal travels with the entry: whoever reports it decides the
          // sentence through `failureToast`, never from the status alone.
          failed.push({ sessionId: entry.sessionId, reason: error?.reason ?? 'failed', error: error });
          console.warn('[delete-session] ' + action + ' refused ' + entry.sessionId, error);
        }
        if (typeof onProgress === 'function') onProgress(done);
      }
      const listed = restored.length === 0 ? 0 : await settleRestoredRows(restored);
      return { done: done, failed: failed, restoredIds: restoredIds, listed: listed };
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
     * How many listed entries a retention window would delete the moment it is
     * applied.
     *
     * The same sum the Host purges on — the deletion time the listing carries plus
     * the window — so the number the reader is asked to accept is the number of
     * rows that will really go. An entry whose deletion time the listing does not
     * state is NOT counted: this side must never promise a deletion it cannot see
     * the arithmetic for.
     *
     * @param entries - the listing.
     * @param days - the window to test.
     * @param now - the moment to measure against.
     * @returns how many entries are already past it.
     */
    function dueAtOnce(entries, days, now) {
      const at = Number.isFinite(now) ? now : Date.now();
      return (Array.isArray(entries) ? entries : []).filter((entry) => {
        const trashed = Date.parse(typeof entry.trashedAt === 'string' ? entry.trashedAt : '');
        return Number.isFinite(trashed) && trashed + days * DAY_MS <= at;
      }).length;
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
    /**
     * The trash artwork's five paths, shared by everything that draws it: the
     * React button on a session row and the plain-DOM button this plugin injects
     * into a Workspace row. One source, so the two glyphs cannot drift apart.
     */
    const TRASH_PATHS = [
      'M1.28149 3.88831H14.7187',
      'M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833',
      'M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831',
      'M6.44946 6.98926V11.1238',
      'M9.55054 6.98926V11.1238',
    ];

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
        TRASH_PATHS.map((d) => React.createElement('path', { key: d, d: d, stroke: 'currentColor' })),
      );
    }

    /**
     * The disclosure arrow beside a group's name in the batch list: a filled
     * triangle, pointing right while the group is folded and rotating down when
     * it opens — the same shape and the same quarter turn the sidebar's own group
     * rows use, so the two lists read as the same list.
     */
    const FOLD_PATH = 'M3.2 1.4 9.6 6 3.2 10.6Z';

    /**
     * The disclosure arrow as a React element.
     * @param open - whether the group it belongs to is unfolded.
     * @returns the `<svg>` element.
     */
    function FoldIcon(open) {
      return React.createElement(
        'svg',
        {
          className: open ? 'dsds_foldArrow dsds_foldArrowOpen' : 'dsds_foldArrow',
          viewBox: '0 0 12 12',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        React.createElement('path', { d: FOLD_PATH, fill: 'currentColor' }),
      );
    }

    /**
     * The same glyph as a DOM node, for the button injected into a Workspace row.
     *
     * That row is the app's own markup and is not rendered by this plugin, so the
     * button inside it is built with DOM calls rather than React elements — and a
     * React element cannot be inserted into a tree React owns without it being
     * reconciled away.
     *
     * @returns the `<svg>` element.
     */
    function trashGlyph() {
      const create = (name) => (typeof document.createElementNS === 'function'
        ? document.createElementNS('http://www.w3.org/2000/svg', name)
        : document.createElement(name));
      const svg = create('svg');
      svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      svg.setAttribute('width', '14');
      svg.setAttribute('height', '14');
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke-width', '1');
      svg.setAttribute('aria-hidden', 'true');
      for (const d of TRASH_PATHS) {
        const path = create('path');
        path.setAttribute('d', d);
        path.setAttribute('stroke', 'currentColor');
        svg.appendChild(path);
      }
      return svg;
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
      const buttonRef = React.useRef(null);
      const isBusy = sessionId !== '' && state.inFlight.has(sessionId);
      const label = isBusy ? text('menu.deleting') : text('menu.delete');
      const spoken = label + ': ' + (displayTitle === '' ? text('empty') : displayTitle);
      /*
       * The label is read at hover time, so a locale switch or a run that starts
       * while the pointer rests here shows what is true then. Bound to the button
       * the ref points at, which is the one the row is really drawing.
       */
      React.useEffect(() => {
        const node = buttonRef.current;
        if (node === null || node === undefined || typeof node.addEventListener !== 'function') return undefined;
        return attachTip(node, () => (store.getSnapshot().inFlight.has(sessionId) ? text('menu.deleting') : text('menu.delete'))
          + ': ' + (displayTitle === '' ? text('empty') : displayTitle));
      }, [sessionId, displayTitle]);
      if (sessionId === '' || state.removed.has(sessionId)) return null;
      return React.createElement(
        'button',
        {
          type: 'button',
          ref: buttonRef,
          className: 'dsds_iconButton',
          disabled: isBusy,
          // `aria-label`, never `title`: the label is drawn by `attachTip` in the
          // app's own style, and a `title` would put the platform's white box on
          // top of it.
          'aria-label': spoken,
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
      /*
       * One card, two shapes. A single row arrives as `{ sessionId, displayTitle }`
       * and a tick list as `{ sessionIds, count }`; everything below that reads the
       * request only asks for the list, so the question, the switch and the button
       * are literally the same ones a single delete has always asked.
       */
      const ids = request === null
        ? []
        : Array.isArray(request.sessionIds) && request.sessionIds.length > 1
          ? request.sessionIds
          : [request.sessionId];
      const many = ids.length > 1;
      const key = ids.join(',');
      React.useEffect(() => {
        if (key === '') return undefined;
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
      }, [key, busy]);
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
          { className: 'dsds_card', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': many ? text('batch.title') : text('confirm.title') },
          React.createElement('h2', { className: 'dsds_cardTitle' }, many ? text('batch.title') : text('confirm.title')),
          React.createElement(
            'p',
            { className: 'dsds_cardDesc' },
            many
              ? text('confirm.descBatch', { count: ids.length, days: state.days })
              : text('confirm.desc', { title: title, days: state.days }),
          ),
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
                  // The confirmed list is what runs, not "whatever is ticked now":
                  // the question named these sessions and the answer is about them.
                  const done = many
                    ? runBatch(ids)
                    : performDelete(request.sessionId, request.displayTitle);
                  void done.then(() => {
                    setBusy(false);
                    setPending(null);
                  });
                },
              },
              busy ? text('confirm.busy') : many ? text('batch.action', { count: ids.length }) : text('confirm.action'),
            ),
          ),
        ),
      );
    }
    /**
     * The `shell.overlay` batch entry: one group's sessions, ticked, then moved.
     *
     * The list is the plugin's own, not the sidebar's. That is what makes the
     * whole group reachable — a collapsed workspace shows no rows at all and a
     * long one is truncated — and it is also the only shape available: the app
     * keeps its session rows to itself, and a client plugin has no seat on a
     * Workspace row to put a tick box in.
     */
    function DeleteSessionBatch() {
      const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
      const request = state.batch;
      const phase = request === null ? '' : request.phase;
      const busy = phase === 'busy';
      const confirmRef = React.useRef(null);      React.useEffect(() => {
        if (phase === '') return undefined;
        if (!busy && confirmRef.current !== null && typeof confirmRef.current.focus === 'function') {
          confirmRef.current.focus();
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape' && !busy) {
            event.stopPropagation();
            closeBatch();
          }
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => {
          window.removeEventListener('keydown', onKeyDown, true);
        };
      }, [phase, busy]);
      if (request === null) return null;
      /*
       * A batch that reached the confirmation is the card's question now, so the
       * dialog steps aside: this plugin asks ONE way, and two stacked layers would
       * make which one is on top an accident of registration order. The tick list
       * is untouched underneath, so cancelling brings the dialog straight back.
       */
      if (state.pending !== null) return null;
      const total = request.items.length;
      const selected = request.selected.size;
      // What the run will actually attempt: the busy line counts the ticked
      // sessions, not every row the list is showing.
      const picked = request.items.filter((item) => request.selected.has(item.sessionId)).length;
      return React.createElement(
        'div',
        {
          className: 'dsds_layer',
          onClick: (event) => {
            if (event.target === event.currentTarget && !busy) closeBatch();
          },
        },
        React.createElement(
          'div',
          {
            className: 'dsds_card dsds_cardWide',
            role: 'alertdialog',
            'aria-modal': 'true',
            'aria-label': text('batch.title'),
          },
          React.createElement('h2', { className: 'dsds_cardTitle' }, text('batch.title')),
          React.createElement('p', { className: 'dsds_cardDesc' }, text('batch.desc', {
            days: request.days,
          })),
          React.createElement(
            'div',
            { className: 'dsds_pickBar' },
            React.createElement('span', null, text('batch.selected', { selected: selected, total: total })),
            /*
             * One control that flips between the two answers rather than a pair
             * of them: the state it would otherwise have to show twice is already
             * printed beside it, and a disabled half would just be dead weight in
             * a dialog that is narrow on purpose.
             */
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'dsds_link',
                disabled: busy,
                onClick: () => {
                  setBatchChoice(selected < total);
                },
              },
              selected < total ? text('batch.all') : text('batch.none'),
            ),
          ),
          React.createElement(
            'ul',
            { className: 'dsds_pickList' },
            /*
             * The list is the sidebar, one section per group, in the sidebar's
             * own order: a group's row folds its sessions away and its own tick
             * box takes the whole workspace in or out. Folding is a view state —
             * the ticks underneath survive it, so closing a group never quietly
             * changes the run.
             *
             * A single group is drawn as a bare list: its section header would be
             * a heading over its own heading, and the group's name is already on
             * the sidebar row that opened this.
             */
            request.groups.flatMap((group) => {
              const sectioned = request.groups.length > 1;
              const open = sectioned && !request.folded.has(group.key);
              const rowClass = sectioned ? 'dsds_pickRow dsds_pickSession' : 'dsds_pickRow';
              const rows = group.items.map((item) => React.createElement(
                'li',
                { key: item.sessionId, className: rowClass },
                React.createElement(
                  'label',
                  { className: 'dsds_check' },
                  React.createElement('input', {
                    type: 'checkbox',
                    checked: request.selected.has(item.sessionId),
                    disabled: busy,
                    onChange: () => {
                      toggleBatchItem(item.sessionId);
                    },
                  }),
                  React.createElement(
                    'span',
                    { className: 'dsds_pickTitle' },
                    item.displayTitle === '' ? text('empty') : item.displayTitle,
                  ),
                  item.archived ? React.createElement('span', { className: 'dsds_pickTag' }, text('batch.archivedTag')) : null,
                ),
              ));
              if (!sectioned) return rows;
              const pickedHere = group.items.every((item) => request.selected.has(item.sessionId));
              return [
                React.createElement(
                  'li',
                  { key: 'group:' + group.key, className: 'dsds_pickGroup' },
                  React.createElement(
                    'label',
                    { className: 'dsds_check' },
                    React.createElement('input', {
                      type: 'checkbox',
                      checked: pickedHere,
                      disabled: busy,
                      'aria-label': text('batch.groupPick', { group: group.label }),
                      onChange: () => {
                        setBatchGroupChoice(group.key, !pickedHere);
                      },
                    }),
                  ),
                  React.createElement(
                    'button',
                    {
                      type: 'button',
                      className: 'dsds_pickFold',
                      'aria-expanded': open,
                      onClick: () => {
                        toggleBatchGroup(group.key);
                      },
                    },
                    FoldIcon(open),
                    React.createElement('span', { className: 'dsds_pickGroupLabel' }, group.label),
                  ),
                ),
                ...(open ? rows : []),
              ];
            }),
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
                  closeBatch();
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
                disabled: busy || selected === 0,
                onClick: () => {
                  requestBatchDelete();
                },
              },
              busy ? text('batch.busy', { done: request.done, total: picked }) : text('batch.action', { count: selected }),
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
        // A message that offers an action stays for as long as the action is
        // good for; one that only speaks gets out of the way sooner.
        const lifetime = current.undo === null || current.undo === undefined ? TOAST_MS : UNDO_WINDOW_MS;
        const timer = window.setTimeout(() => {
          dismissToast();
        }, lifetime);
        return () => {
          window.clearTimeout(timer);
        };
      }, [current, revision]);
      if (current === null) return null;
      const undo = current.undo === null || current.undo === undefined ? null : current.undo;
      return React.createElement(
        'div',
        {
          className: undo === null ? 'dsds_toast' : 'dsds_toast dsds_toastRow',
          role: 'status',
          'aria-live': 'polite',
        },
        React.createElement('span', null, text('toast.' + current.kind, current.params ?? undefined)),
        undo === null
          ? null
          : React.createElement(
            'button',
            {
              type: 'button',
              className: 'dsds_toastAction',
              disabled: undo.phase === 'busy',
              onClick: () => {
                void undoTrash();
              },
            },
            text('toast.undo'),
          ),
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
      /**
       * A retention window picked but not applied yet, because applying it would
       * delete entries that are already in the bin. `0` means nothing is waiting:
       * the select shows the window really in force until this is confirmed.
       */
      const [pendingWindow, setPendingWindow] = React.useState(0);
      /** The entries ticked for a batch action. */
      const [picked, setPicked] = React.useState(() => new Set());
      /** The batch in flight, or null: `{ action, done, total }`. */
      const [running, setRunning] = React.useState(null);
      /** One disabled state for every control that must not race a run. */
      const busy = busyId !== '' || running !== null;
      // This page is where the confirmation is switched back on: the dialog's
      // "don't ask again" would otherwise be a one-way door.
      const shared = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
      const load = React.useCallback(() => {
        return call('list').then((payload) => {
          const entries = Array.isArray(payload.entries) ? payload.entries : [];
          setState({
            phase: 'ready',
            entries: entries,
            retentionDays: typeof payload.retentionDays === 'number' ? payload.retentionDays : 15,
            purged: Array.isArray(payload.purged) ? payload.purged : [],
          });
          setError('');
          // A listing that just changed invalidates the tick list: every batch
          // action is driven from what is on screen, and an id the new listing no
          // longer holds would make the buttons count entries that are not there.
          setPicked(new Set());
          // Hiding is settled against the logs on disk, not against this
          // listing: a row stays hidden while its session has no log, so one
          // restored from another window comes back and one purged out of the
          // bin here (or swept while the page was closed) stays gone.
          void verifyTombstones();
          // The listing is handed back so a caller that changed something else
          // first can report what the re-read found.
          return payload;
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
            // The window is settled FIRST and the tombstone lifted after it: the
            // row is drawn from the page's own Session list, and showing it before
            // that list had the session back is what made a restored row appear as
            // 未命名 — or once in the wrong group — until something else refreshed
            // the page. Membership, the row, and its title all belong to the
            // window; the log on disk is the only part the bin owns.
            const listed = (await settleRestoredRows([{ entry: entry, report: report }])) > 0;
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
      /** The entries inside the retention window's last days. */
      const expiring = state.entries.filter((entry) => entry.daysLeft !== null && entry.daysLeft !== undefined && Number(entry.daysLeft) <= EXPIRING_SOON_DAYS);
      /** How many rows the waiting window would take with it. */
      const pendingDue = pendingWindow === 0 ? 0 : dueAtOnce(state.entries, pendingWindow);
      /*
       * A window stops waiting when the rows it was about to take are gone —
       * restored here or in another window, so a fresh listing no longer holds
       * them. What the warning was about does not exist any more, so the window is
       * applied instead of sitting armed behind a line that is no longer drawn.
       */
      React.useEffect(() => {
        if (pendingWindow > 0 && pendingDue === 0) changeRetention(pendingWindow);
      }, [pendingWindow, pendingDue]);
      /** The windows to offer: the shipped three, plus whatever the Host really holds. */
      const retentionChoices = RETENTION_CHOICES.includes(state.retentionDays)
        ? RETENTION_CHOICES
        : [...RETENTION_CHOICES, state.retentionDays].sort((left, right) => left - right);
      /** Whether every listed entry is ticked, which is what the header box shows. */
      const allPicked = state.entries.length > 0 && state.entries.every((entry) => picked.has(entry.sessionId));
      /*
       * The batch actions run from the tick list, in the order the table shows.
       * Every one of them lands through `performBinBatch`, so a refusal on one
       * entry is a count in the summary rather than an end to the run — which is
       * the whole point of doing this from a list instead of one row at a time.
       */
      const togglePick = (sessionId) => {
        // An armed "delete forever" belongs to the selection it was armed on.
        setConfirming('');
        setPicked((previous) => {
          const next = new Set(previous);
          if (next.has(sessionId)) next.delete(sessionId);
          else next.add(sessionId);
          return next;
        });
      };
      /**
       * Change the retention window. The Host is the writer; the page quotes what
       * it answers, and re-reads the listing so the table and the intro sentence
       * follow. The Host also removes whatever the new window has already passed
       * and says how many, which is what the message repeats back.
       */
      const changeRetention = (days) => {
        setPendingWindow(0);
        setBusyId('retention');
        call('retention', undefined, { days: days }).then((report) => {
          const settled = typeof report?.retentionDays === 'number' && report.retentionDays > 0 ? report.retentionDays : days;
          setRetentionDays(settled);
          const removed = Array.isArray(report?.purged) ? report.purged.length : 0;
          return load().then(() => {
            if (removed > 0) showToast('retentionPurged', { days: settled, count: removed });
            else showToast('retentionChanged', { days: settled });
          });
        }, (failure) => {
          showToast(failureToast(failure));
        }).then(() => {
          setBusyId('');
        });
      };
      /**
       * Apply a picked window, or arm it when it would destroy something at once.
       *
       * A window that takes nothing is applied straight away: there is nothing to
       * warn about, and the warning is only worth a click when rows will go.
       */
      const pickRetention = (days) => {
        if (days === state.retentionDays) {
          setPendingWindow(0);
          return;
        }
        if (dueAtOnce(state.entries, days) > 0 && pendingWindow !== days) {
          setPendingWindow(days);
          return;
        }
        changeRetention(days);
      };
      const runPicked = (action) => {
        const entries = state.entries.filter((entry) => picked.has(entry.sessionId));
        if (entries.length === 0) return;
        setConfirming('');
        setRunning({ action: action, done: 0, total: entries.length });
        performBinBatch(action, entries, (done) => {
          setRunning((previous) => (previous === null ? previous : { ...previous, done: done }));
        }).then(async (report) => {
          if (action === 'restore') {
            // The batch counts itself as back only for the rows the page really
            // carries — the same read-back the single row does, already done by
            // `performBinBatch` once for the whole batch, titles included.
            const listed = report.restoredIds.length === 0 ? 0 : report.listed;
            if (report.failed.length > 0) showToast('batchRestoredPartial', { done: report.done, failed: report.failed.length });
            else if (listed === report.done) showToast('batchRestored', { count: report.done });
            else showToast('batchRestoredPending', { count: report.done });
          } else if (report.failed.length > 0) {
            showToast('batchPurgedPartial', { done: report.done, failed: report.failed.length });
          } else {
            showToast('batchPurged', { count: report.done });
          }
          setRunning(null);
          load();
        }, (failure) => {
          // Every entry's own refusal is already counted above, so reaching here
          // means something unexpected: drop the run and say so, rather than
          // leaving the page disabled with no way forward.
          setRunning(null);
          showToast(failureToast(failure));
        });
      };
      return React.createElement(
        'section',
        { className: 'dsds_section' },
        React.createElement(
          'div',
          { className: 'dsds_sectionHead' },
          React.createElement('h2', { className: 'dsds_sectionTitle' }, text('recycle.title')),
          // The label names the MOVE, in the wording the dialog's own button
          // uses: a bare "删除前先确认" reads as if it governed this page's own
          // 彻底删除 buttons, and "「删除会话」前" still leans on the reader
          // knowing which 删除会话 is meant.
          React.createElement(
            'label',
            { className: 'dsds_check dsds_headCheck' },
            React.createElement('input', {
              type: 'checkbox',
              checked: shared.ask,
              onChange: (event) => {
                setAskBeforeDelete(event.target.checked);
              },
            }),
            text('recycle.ask'),
          ),
        ),
        React.createElement('p', { className: 'dsds_sectionIntro' }, text('recycle.intro', { days: state.retentionDays })),
        React.createElement('p', { className: 'dsds_note' }, text('recycle.reloadHint')),
        // The one thing about a bin a user cannot see coming: which entries are
        // about to be swept. The count is stated with the page's own threshold,
        // and the same line offers the batch action that deals with them.
        expiring.length > 0
          ? React.createElement(
            'p',
            { className: 'dsds_expiring' },
            text('recycle.expiring', { count: expiring.length, days: EXPIRING_SOON_DAYS }),
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'dsds_link',
                disabled: busy,
                onClick: () => {
                  setConfirming('');
                  setPicked(new Set(expiring.map((entry) => entry.sessionId)));
                },
              },
              text('recycle.expiringPick'),
            ),
          )
          : null,
        React.createElement(
          'div',
          { className: 'dsds_toolbar' },
          React.createElement(
            'button',
            { type: 'button', className: 'dsds_button', disabled: busy, onClick: load },
            text('recycle.refresh'),
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dsds_button',
              disabled: busy,
              onClick: () => {
                window.location.reload();
              },
            },
            text('recycle.reload'),
          ),
          /*
           * The batch controls are NOT here: they live in the table's own header
           * row, above the rows they act on and beside the tick boxes that pick
           * them (see the table below). This row keeps only what belongs to the
           * whole page — read it again, reload it, empty it.
           */
          React.createElement(
            'button',
            {
              type: 'button',
              className: confirming === 'empty' ? 'dsds_button dsds_buttonDanger' : 'dsds_button',
              disabled: busy || state.entries.length === 0,
              onClick: emptyBin,
            },
            confirming === 'empty' ? text('recycle.askEmpty', { count: state.entries.length }) : text('recycle.emptyBin'),
          ),
        ),
        // No hint line under the toolbar: an armed action states itself on its
        // own button ("确认彻底删除"), and a line that appeared only while one was
        // armed pushed the whole table down and back for nothing.
        /*
         * The retention window. It sits here, beside the other bin-wide setting,
         * and it is one number for the whole bin: everything listed is measured
         * from the day it was deleted, so this control moves the 剩余 column too.
         * A window that would delete something the moment it is applied waits for
         * a second, explicit click, and the warning states the real count.
         */
        React.createElement(
          'label',
          { className: 'dsds_field' },
          text('recycle.keep'),
          React.createElement(
            'select',
            {
              className: 'dsds_select',
              value: String(state.retentionDays),
              disabled: busy,
              onChange: (event) => {
                pickRetention(Number(event.target.value));
              },
            },
            retentionChoices.map((days) => React.createElement(
              'option',
              { key: days, value: String(days) },
              text('recycle.keepDays', { days: days }),
            )),
          ),
          React.createElement('span', { className: 'dsds_note' }, text('recycle.keepHint')),
        ),
        pendingWindow > 0
          ? React.createElement(
            'div',
            { className: 'dsds_windowAsk' },
            React.createElement(
              'span',
              { className: 'dsds_warn' },
              text('recycle.askWindow', { days: pendingWindow, count: pendingDue }),
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'dsds_button',
                disabled: busy,
                onClick: () => {
                  setPendingWindow(0);
                },
              },
              text('cancel'),
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'dsds_button dsds_buttonDanger',
                disabled: busy,
                onClick: () => {
                  changeRetention(pendingWindow);
                },
              },
              text('recycle.confirmWindow', { days: pendingWindow }),
            ),
          )
          : null,
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
                React.createElement(
                  'span',
                  { className: 'dsds_pickCell' },
                  React.createElement('input', {
                    type: 'checkbox',
                    checked: allPicked,
                    disabled: busy,
                    'aria-label': text('recycle.pickAll'),
                    onChange: () => {
                      // An armed "delete forever" belongs to the selection it was
                      // armed on, so changing the selection disarms it.
                      setConfirming('');
                      setPicked(allPicked ? new Set() : new Set(state.entries.map((entry) => entry.sessionId)));
                    },
                  }),
                ),
                React.createElement('span', null, text('recycle.columnSession')),
                React.createElement('span', null, text('recycle.columnWorkspace')),
                React.createElement('span', null, text('recycle.columnTrashed')),
                React.createElement('span', null, text('recycle.columnLeft')),
                /*
                 * The batch controls sit in the header row's action cell — the
                 * column the rows' own buttons occupy — and appear only while
                 * something is ticked. That cell is a fixed track (166px, see the
                 * template above), so its labels are the row buttons' words one
                 * size down and without "选中": the ticked boxes behind them say
                 * which rows they mean, and the number says how many. Clearing the
                 * selection is the header's own tick box, so there is no third
                 * control here. The destructive one arms itself exactly like the
                 * per-row button does — the same two-step confirmation, on the
                 * control that acts — and a run in flight replaces both with one
                 * line of progress, so there is never a second click to make while
                 * the first is still going.
                 */
                React.createElement(
                  'span',
                  { className: 'dsds_rowActions' },
                  running !== null
                    ? React.createElement(
                      'span',
                      { className: 'dsds_note' },
                      text('recycle.batchWorking', { done: running.done, total: running.total }),
                    )
                    : picked.size === 0
                      ? null
                      : [
                        React.createElement(
                          'button',
                          {
                            key: 'restore',
                            type: 'button',
                            className: 'dsds_button',
                            disabled: busy,
                            onClick: () => {
                              runPicked('restore');
                            },
                          },
                          text('recycle.restorePicked', { count: picked.size }),
                        ),
                        React.createElement(
                          'button',
                          {
                            key: 'purge',
                            type: 'button',
                            className: confirming === PICKED_ARMED ? 'dsds_button dsds_buttonDanger' : 'dsds_button',
                            disabled: busy,
                            onClick: () => {
                              if (confirming !== PICKED_ARMED) {
                                setConfirming(PICKED_ARMED);
                                return;
                              }
                              runPicked('purge');
                            },
                          },
                          confirming === PICKED_ARMED
                            ? text('recycle.askPurgePicked')
                            : text('recycle.purgePicked', { count: picked.size }),
                        ),
                      ],
                ),
              ),
              state.entries.map((entry) => React.createElement(
                'div',
                { className: 'dsds_row', key: entry.sessionId },
                React.createElement(
                  'span',
                  { className: 'dsds_pickCell' },
                  React.createElement('input', {
                    type: 'checkbox',
                    checked: picked.has(entry.sessionId),
                    disabled: busy,
                    'aria-label': text('recycle.pickOne', { title: entry.title === '' ? text('empty') : entry.title }),
                    onChange: () => {
                      togglePick(entry.sessionId);
                    },
                  }),
                ),
                React.createElement('span', { className: 'dsds_cellTitle', title: entry.sessionId }, entry.title === '' ? text('empty') : entry.title),
                React.createElement('span', { className: 'dsds_cellMuted', title: String(entry.cwd ?? '') }, String(entry.cwd ?? '—')),
                React.createElement('span', { className: 'dsds_cellNumber' }, formatWhen(entry.trashedAt)),
                // A row with no deletion time of its own has no deadline to count
                // down (the Host reports none rather than guessing), and "due now"
                // would be the one thing it is not.
                React.createElement(
                  'span',
                  { className: 'dsds_cellNumber' },
                  entry.daysLeft === null || entry.daysLeft === undefined
                    ? '—'
                    : entry.daysLeft > 0
                      ? text('recycle.daysLeft', { days: entry.daysLeft })
                      : text('recycle.expired'),
                ),
                React.createElement(
                  'span',
                  { className: 'dsds_rowActions' },
                  React.createElement(
                    'button',
                    {
                      type: 'button',
                      className: 'dsds_button',
                      disabled: busy,
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
                      disabled: busy,
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

    /*
     * The batch entry point in the sidebar's section header.
     *
     * That row — "工作区" with search, view options and add-workspace on it — is
     * the app's own element and a client plugin gets no slot on it, so this
     * appends its own icon button as the row's last child.
     *
     * Why the header and not the Workspace rows: a button on a Workspace row can
     * only ever speak for that one group, and the row's own action area is
     * `display:none` until the row is hovered — the plugin's button there is
     * missing in exactly the state someone looks at the sidebar. One button on
     * the header is always on screen, and its dialog lists every group, so one
     * workspace can still be taken out in a single click (the per-group tick).
     *
     * The class it hangs off is a CSS-module hash whose prefix changes between
     * builds, so only the tail (`_sectionHeader`) is read, and it is read through
     * a substring selector first: the page holds thousands of elements and this
     * runs on every mutation burst.
     *
     * The header belongs to React and this button does not, so the claim is
     * re-run on every mutation: React may drop a node it did not create when it
     * redraws the row. Nothing is captured when the button is built — the dialog
     * reads the sidebar's groups at CLICK time.
     */

    /** The attribute marking the header this plugin put its button on. */
    const HEADER_ROW_TAG = 'data-dsh-delete-session-batch';
    /** The attribute on the injected button, so the row gets exactly one. */
    const HEADER_BUTTON_TAG = 'data-dsh-delete-session-batch-button';
    /** A Workspace row, as the browser renders it (read for the group order). */
    const GROUP_ROW_SELECTOR = '[data-row-key^="workspace:"]';
    /** What those keys start with; the rest is the group's own key. */
    const GROUP_KEY_PREFIX = 'workspace:';
    /** How long the pointer rests on a control here before its label appears. */
    const TIP_DELAY_MS = 500;
    /** The gap the app leaves between a control and its bubble. */
    const TIP_GAP_PX = 8;

    /** The one bubble, once something has been hovered; null before that. */
    let tipBubble = null;
    /** The pending reveal, so leaving before it fires cancels it. */
    let tipTimer = 0;
    /** The control the bubble currently belongs to, or null. */
    let tipAnchor = null;

    /** Take the bubble down, if it is up. */
    function closeTip() {
      window.clearTimeout(tipTimer);
      tipTimer = 0;
      tipAnchor = null;
      if (tipBubble !== null) tipBubble.hidden = true;
    }

    /**
     * Draw the bubble under a control.
     *
     * One bubble for the whole plugin, moved rather than multiplied: two of them
     * can never be on screen at once, which is what a hover can produce anyway.
     *
     * @param anchor - the control the label belongs to.
     * @param label - the text to show.
     */
    function openTip(anchor, label) {
      if (typeof document === 'undefined' || document.body === undefined || document.body === null) return;
      if (tipBubble === null) {
        tipBubble = document.createElement('span');
        tipBubble.className = 'dsds_tip';
        tipBubble.setAttribute('role', 'tooltip');
        tipBubble.hidden = true;
        document.body.appendChild(tipBubble);
      }
      tipBubble.textContent = label;
      const rect = anchor.getBoundingClientRect();
      // The app's placement: `left` carries the control's centre and the CSS
      // pulls the bubble half its own width back, so it centres under any width.
      tipBubble.style.left = `${rect.left + rect.width / 2}px`;
      tipBubble.style.top = `${rect.bottom + TIP_GAP_PX}px`;
      tipBubble.hidden = false;
      tipAnchor = anchor;
    }

    /**
     * Give one control the app's hover tooltip.
     *
     * `title` is deliberately NOT set anywhere: the platform draws that one as a
     * white OS box with a hard border, which is exactly the mismatch this exists
     * to remove. The control keeps its `aria-label`, which is what a screen reader
     * reads, so nothing is lost when the bubble is not shown.
     *
     * @param anchor - the control the label belongs to.
     * @param label - the text, or a function read AT HOVER TIME (a locale switch
     *   or a busy state must show what is true then, not what was true at bind).
     * @returns a disposer that drops the listeners.
     */
    function attachTip(anchor, label) {
      const resolve = () => (typeof label === 'function' ? label() : label);
      const enter = () => {
        window.clearTimeout(tipTimer);
        tipTimer = window.setTimeout(() => {
          openTip(anchor, resolve());
        }, TIP_DELAY_MS);
      };
      const leave = () => {
        if (tipAnchor === anchor) closeTip();
        else window.clearTimeout(tipTimer);
      };
      // A control that scrolls or resizes under the pointer takes its bubble with
      // it — the bubble is `fixed`, so nothing moves it on its own.
      const still = () => {
        if (tipAnchor === anchor) openTip(anchor, resolve());
      };
      const onKeyDown = (event) => {
        if (event.key === 'Escape') closeTip();
      };
      anchor.addEventListener('mouseenter', enter);
      anchor.addEventListener('mouseleave', leave);
      anchor.addEventListener('focus', enter);
      anchor.addEventListener('blur', leave);
      document.addEventListener('pointerdown', leave, true);
      document.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('scroll', still, true);
      window.addEventListener('resize', still);
      return () => {
        anchor.removeEventListener('mouseenter', enter);
        anchor.removeEventListener('mouseleave', leave);
        anchor.removeEventListener('focus', enter);
        anchor.removeEventListener('blur', leave);
        document.removeEventListener('pointerdown', leave, true);
        document.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('scroll', still, true);
        window.removeEventListener('resize', still);
        if (tipAnchor === anchor) closeTip();
      };
    }

    /**
     * Whether an element carries a class ending in `suffix`.
     *
     * The app's class names are CSS-module hashes whose prefix changes between
     * builds, so only the suffix is stable.
     *
     * @param element - the element to inspect.
     * @param suffix - the stable tail of the class name.
     * @returns whether one of its classes ends with it.
     */
    function hasClassEndingWith(element, suffix) {
      const classes = element?.classList;
      const list = classes !== undefined && classes !== null && typeof classes[Symbol.iterator] === 'function'
        ? Array.from(classes)
        : String(element?.className ?? '').split(/\s+/);
      return list.some((name) => typeof name === 'string' && name.endsWith(suffix));
    }

    /**
     * The first child of `scope` carrying a class ending in `suffix`.
     *
     * Children only, never the subtree: every caller here is asking "is this the
     * element I think it is", and the answer has to come from its own shape.
     *
     * @param scope - the element whose children are inspected.
     * @param suffix - the stable tail of the class name.
     * @returns the child, when one carries it.
     */
    function childWithClassEnding(scope, suffix) {
      for (const child of scope?.children ?? []) {
        if (hasClassEndingWith(child, suffix)) return child;
      }
      return undefined;
    }

    /**
     * The sidebar's section header, or undefined while it is not on screen.
     *
     * `_sectionHeader` alone is not enough to identify it: the app's job-list
     * menu has a `sectionHeader` of its own, in another module with another hash.
     * The sidebar's is the one carrying a `headerActions` child, which is where
     * the app keeps its own icons on this row.
     *
     * A collapsed sidebar (the app's "rail": a column of 36px controls with no
     * room for a fourth one, and not where anyone looks for this) is skipped, so
     * the button is not drawn there.
     *
     * @returns the header element, when the full sidebar is showing.
     */
    function sidebarHeader() {
      if (typeof document === 'undefined') return undefined;
      for (const element of document.querySelectorAll('[class*="sectionHeader"]')) {
        if (!hasClassEndingWith(element, '_sectionHeader')) continue;
        if (childWithClassEnding(element, '_headerActions') === undefined) continue;
        if (hasClassEndingWith(element.parentElement, '_rail')) continue;
        return element;
      }
      return undefined;
    }

    /**
     * The batch button already on the header, or undefined while it has none.
     * @param header - the header element.
     * @returns the button, when this header already carries one.
     */
    function headerBatchButtonOf(header) {
      for (const child of header.children ?? []) {
        if (typeof child?.hasAttribute === 'function' && child.hasAttribute(HEADER_BUTTON_TAG)) return child;
      }
      return undefined;
    }

    /**
     * The button itself: the session row's trash glyph in the header's icon box.
     * @returns the button element.
     */
    function headerBatchButton() {
      const label = text('batch.button');
      const button = document.createElement('button');
      // `type` as an attribute, not a property: this button is plain DOM, and
      // the attribute is what a reader of the markup (and the page's own
      // button-type default) sees either way.
      button.setAttribute('type', 'button');
      button.className = 'dsds_headerButton';
      button.setAttribute(HEADER_BUTTON_TAG, '');
      // No `title`: the label is drawn by `attachTip` in the app's own style, and
      // a `title` would put the platform's white box next to it.
      button.setAttribute('aria-label', label);
      button.appendChild(trashGlyph());
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openBatch();
      });
      return button;
    }

    /**
     * Put the batch button on the sidebar's section header.
     * @param host - the client plugin context, for effect ownership.
     * @returns the effect's disposer, when there is a document to work on.
     */
    function drawSidebarBatchButton(host) {
      if (typeof document === 'undefined') return undefined;
      return host.effect(() => {
        let stopped = false;
        let queued = false;
        /** The tooltip on the button that is on the page right now. */
        let unbindTip = null;
        const claim = () => {
          queued = false;
          if (stopped) return;
          const header = sidebarHeader();
          // A button lands on the header the app is drawing right now: one left
          // behind by a redraw (or by the sidebar collapsing into its rail) goes,
          // and its tooltip goes with it.
          for (const button of document.querySelectorAll(`[${HEADER_BUTTON_TAG}]`)) {
            if (header !== undefined && button.parentNode === header) continue;
            if (unbindTip !== null) {
              unbindTip();
              unbindTip = null;
            }
            button.remove();
          }
          if (header === undefined) return;
          if (headerBatchButtonOf(header) !== undefined) return;
          header.setAttribute(HEADER_ROW_TAG, '');
          const button = headerBatchButton();
          header.appendChild(button);
          unbindTip = attachTip(button, () => text('batch.button'));
        };
        // Mutations arrive in bursts — the sidebar mounting, a group folding, a
        // row redrawing its own buttons — so one pass per burst, before paint.
        const later = () => {
          if (queued || stopped) return;
          queued = true;
          queueMicrotask(claim);
        };
        claim();
        const watched = typeof MutationObserver === 'function' ? new MutationObserver(later) : undefined;
        watched?.observe(document.body, { childList: true, subtree: true });
        return () => {
          stopped = true;
          watched?.disconnect();
          if (unbindTip !== null) {
            unbindTip();
            unbindTip = null;
          }
          for (const row of document.querySelectorAll(`[${HEADER_ROW_TAG}]`)) row.removeAttribute(HEADER_ROW_TAG);
          for (const button of document.querySelectorAll(`[${HEADER_BUTTON_TAG}]`)) button.remove();
        };
      }, 'delete-session: sidebar batch button');
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
        // The window the confirmations quote is the Host's number, not this
        // file's: one cheap read at startup, so a page that deletes something
        // before ever opening the settings page still quotes the truth.
        void loadRetention();
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
            id: 'delete-session-batch',
            locale: NS,
          }, DeleteSessionBatch);
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
        // A sidebar header has no slot to contribute to either, so the batch
        // entry point is put on that row itself (see `drawSidebarBatchButton`).
        drawSidebarBatchButton(ctx);
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
        drawSidebarBatchButton: drawSidebarBatchButton,
        sidebarBatchTargets: sidebarBatchTargets,
        groupBatchTargets: groupBatchTargets,
        renderedGroups: renderedGroups,
        sidebarHeader: sidebarHeader,
        headerBatchButton: headerBatchButton,
        openTip: openTip,
        closeTip: closeTip,
        attachTip: attachTip,
        openBatch: openBatch,
        toggleBatchItem: toggleBatchItem,
        setBatchChoice: setBatchChoice,
        setBatchGroupChoice: setBatchGroupChoice,
        toggleBatchGroup: toggleBatchGroup,
        runBatch: runBatch,
        requestBatchDelete: requestBatchDelete,
        closeBatch: closeBatch,
        performBatchDelete: performBatchDelete,
        undoTrash: undoTrash,
        performBinBatch: performBinBatch,
        relistRestoredSessions: relistRestoredSessions,
        sessionRow: sessionRow,
        wantsTitleBack: wantsTitleBack,
        setBatch: setBatch,
        loadRetention: loadRetention,
        setRetentionDays: setRetentionDays,
        retentionNow: () => retentionDays,
        // The page's own arithmetic for "how many rows a window would take", the
        // half of the retention change that a test cannot see from the outside.
        dueAtOnce: dueAtOnce,
        store: store,
        setPending: setPending,
      },
    };
  },
});
