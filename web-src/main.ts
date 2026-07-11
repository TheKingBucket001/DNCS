import { BridgeTimeoutError, bridgeToast, enableEdgeToEdgeCompat, exec } from './bridge';
import { parseConfigText, resolveConfig } from './config';
import {
  AppInfo,
  AppType,
  CATEGORIES,
  SearchMode,
  badgeKind,
  filterApps,
  groupSharedApps,
  isEffectivelyBlocked,
  mergeBlocked,
  parseAppsText,
  setPendingChange
} from './state';
import { resolveApplyExecution, runCore } from './shell';
import type { ApplyResult } from './shell';

let allApps: AppInfo[] = [];
let currentBlocked = new Set<string>();
let pendingChanges: Record<string, boolean> = {};
let currentCategory: AppType = 'user';
let searchMode: SearchMode = 'pkg';
let searchQuery = '';
let isBusy = false;
let ruleStateKnown = false;
let currentPage: 'main' | 'about' = 'main';
let isTransitioning = false;
let searchTimer = 0;
let toastTimer = 0;
let menuCloseTimer = 0;
let stableViewportHeight = 0;
let queuedPage: 'main' | 'about' | null = null;
let logRequestSequence = 0;
let pendingMenuAction: (() => void) | null = null;

const groupMotionMs = 300;
const groupAnimations = new WeakMap<HTMLElement, Animation>();

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: ${id}`);
  return el as T;
};

const listEl = $('app-list');
const aboutPage = $('about-page');
const pageStage = $('page-stage');
const saveBar = $('save-bar');
const titleEl = $('top-title');
const toastEl = $('toast');
const searchPanel = $('search-panel');
const searchInput = $('search-input') as HTMLInputElement;
const logModal = $('log-modal');
const logContent = $('log-content');
const confirmModal = $('confirm-modal');
const confirmMessage = $('confirm-message');
const confirmCancelButton = $('confirm-cancel-button') as HTMLButtonElement;
const confirmOkButton = $('confirm-ok-button') as HTMLButtonElement;
const menuButton = $('menu-button');
const dropdownMenu = $('dropdown-menu');
const menuScrim = $('menu-scrim');
const backButton = $('back-button') as HTMLButtonElement;
const backupConfigButton = $('backup-config-button') as HTMLButtonElement;
const restoreConfigButton = $('restore-config-button') as HTMLButtonElement;
const restoreConfigInput = $('restore-config-input') as HTMLInputElement;
const saveButton = $('save-button') as HTMLButtonElement;
const refreshButton = $('refresh-button') as HTMLButtonElement;
const debugButton = $('debug-button') as HTMLButtonElement;
const rescueButton = $('rescue-button') as HTMLButtonElement;
const clearLogButton = $('clear-log-button') as HTMLButtonElement;
const scrollRoot = pageStage;
let confirmResolver: ((confirmed: boolean) => void) | null = null;
type HistoryState = { page?: 'main' | 'about'; overlay?: 'confirm' | 'log' | 'menu' };

function pushOverlayHistory(overlay: 'confirm' | 'log' | 'menu'): void {
  const state = (history.state as HistoryState | null) || {};
  if (state.overlay === overlay) return;
  history.pushState({ page: currentPage, overlay }, '', location.href);
}

function showToast(message: string): void {
  try {
    bridgeToast(message);
    return;
  } catch {
    window.clearTimeout(toastTimer);
    toastEl.textContent = message;
    toastEl.classList.add('show');
    toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 2200);
  }
}

function closeConfirmModal(confirmed: boolean, fromHistory = false): void {
  if (confirmModal.hidden && !confirmResolver) return;
  confirmModal.hidden = true;
  const resolver = confirmResolver;
  confirmResolver = null;
  resolver?.(confirmed);
  if (!fromHistory && (history.state as HistoryState | null)?.overlay === 'confirm') history.back();
}

function requestConfirm(message: string): Promise<boolean> {
  const alreadyInHistory = (history.state as HistoryState | null)?.overlay === 'confirm';
  if (confirmResolver) closeConfirmModal(false, true);
  confirmMessage.textContent = message;
  confirmModal.hidden = false;
  if (!alreadyInHistory) pushOverlayHistory('confirm');
  window.requestAnimationFrame(() => confirmOkButton.focus({ preventScroll: true }));
  return new Promise((resolve) => {
    confirmResolver = resolve;
  });
}

function closeLogModal(fromHistory = false): void {
  if (logModal.hidden) return;
  logRequestSequence += 1;
  logModal.hidden = true;
  if (!fromHistory && (history.state as HistoryState | null)?.overlay === 'log') history.back();
}

function createStatusElement(message: string): HTMLElement {
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  empty.textContent = message;
  return empty;
}

function setStatus(message: string): void {
  const empty = createStatusElement(message);
  listEl.replaceChildren(empty);
}

function scrollTopAfterRender(): void {
  window.requestAnimationFrame(() => {
    if (scrollRoot.scrollTop > 0) scrollRoot.scrollTo({ top: 0, left: 0 });
  });
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, prefersReducedMotion() ? 0 : ms));
}

function yieldForPaint(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
  });
}

function syncCategoryTabs(): void {
  document.querySelectorAll('[data-category]').forEach((item) => {
    item.classList.toggle('active', (item as HTMLElement).dataset.category === currentCategory);
  });
}

function closeSearch(resetList: boolean): void {
  const hadQuery = searchQuery.length > 0 || searchInput.value.length > 0;
  const wasOpen = !searchPanel.hidden;
  searchPanel.hidden = true;
  searchInput.blur();
  searchInput.value = '';
  searchQuery = '';
  document.body.classList.remove('search-active');
  if (resetList && currentPage === 'main' && (hadQuery || wasOpen)) renderList(false);
}

function updateUIState(): void {
  const hasChanges = Object.keys(pendingChanges).length > 0;
  saveBar.hidden = !hasChanges;
  titleEl.classList.toggle('has-pending', hasChanges && currentPage === 'main');
}

function syncControlState(): void {
  [saveButton, refreshButton, backupConfigButton, restoreConfigButton, debugButton, rescueButton, clearLogButton]
    .forEach((button) => { button.disabled = isBusy; });
  [saveButton, restoreConfigButton, rescueButton]
    .forEach((button) => { button.disabled = isBusy || !ruleStateKnown; });
  document.querySelectorAll<HTMLInputElement>('input[data-role="uid-toggle"]').forEach((input) => {
    input.disabled = isBusy || !ruleStateKnown;
  });
}

function setBusyState(busy: boolean): void {
  isBusy = busy;
  pageStage.setAttribute('aria-busy', String(busy));
  syncControlState();
}

function setRuleStateKnown(known: boolean): void {
  ruleStateKnown = known;
  syncControlState();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUnknownResult(error: unknown): error is BridgeTimeoutError {
  return error instanceof BridgeTimeoutError;
}

function createBadge(uid: string): HTMLElement {
  const badge = document.createElement('span');
  badge.className = 'tag-slot';
  badge.dataset.uid = uid;
  const kind = badgeKind(uid, currentBlocked, pendingChanges);
  if (kind === 'none') return badge;
  const tag = document.createElement('span');
  tag.className = `tag ${kind}`;
  tag.textContent = kind === 'blocked' ? '已断网' : kind === 'pending-block' ? '待断网' : '待恢复';
  badge.append(tag);
  return badge;
}

function applyToggleChange(input: HTMLInputElement): void {
  const { uid } = input.dataset;
  if (!uid) return;
  if (isBusy || !ruleStateKnown) {
    input.checked = isEffectivelyBlocked(uid, currentBlocked, pendingChanges);
    return;
  }
  pendingChanges = setPendingChange(pendingChanges, currentBlocked, uid, input.checked);
  updateUIState();
  syncUIDDOM(uid);
}

function createSwitch(uid: string, checked: boolean): HTMLLabelElement {
  const label = document.createElement('label');
  label.className = 'switch';
  label.addEventListener('click', (event) => event.stopPropagation());
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.disabled = isBusy || !ruleStateKnown;
  input.dataset.role = 'uid-toggle';
  input.dataset.uid = uid;
  input.setAttribute('aria-label', `UID ${uid} 断网`);
  input.addEventListener('change', () => applyToggleChange(input));
  const slider = document.createElement('span');
  slider.className = 'slider';
  label.append(input, slider);
  return label;
}

function createCloneTag(): HTMLElement {
  const tag = document.createElement('span');
  tag.className = 'tag clone';
  tag.textContent = '分身';
  return tag;
}

function createChevronIcon(uid: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('group-chevron');
  svg.dataset.role = 'group-icon';
  svg.dataset.uid = uid;
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41Z');
  svg.append(path);
  return svg;
}

function syncUIDDOM(uid: string): void {
  const checked = isEffectivelyBlocked(uid, currentBlocked, pendingChanges);
  document.querySelectorAll<HTMLInputElement>(`input[data-role="uid-toggle"][data-uid="${uid}"]`).forEach((input) => {
    input.checked = checked;
  });
  document.querySelectorAll<HTMLElement>(`[data-role="uid-title"][data-uid="${uid}"]`).forEach((el) => {
    el.classList.toggle('blocked-title', checked);
  });
  document.querySelectorAll<HTMLElement>(`.tag-slot[data-uid="${uid}"]`).forEach((slot) => {
    slot.replaceChildren(...createBadge(uid).childNodes);
  });
}

function animateGroupLayoutShift(card: HTMLElement, mutate: () => void): void {
  const cards = Array.from(listEl.querySelectorAll<HTMLElement>('.group-card'));
  const cardIndex = cards.indexOf(card);
  const followingCards = cardIndex >= 0 ? cards.slice(cardIndex + 1) : [];
  if (prefersReducedMotion()) {
    followingCards.forEach((item) => {
      groupAnimations.get(item)?.cancel();
      groupAnimations.delete(item);
      item.style.removeProperty('will-change');
    });
    mutate();
    return;
  }

  const visualTops = followingCards.map((item) => ({
    item,
    top: item.getBoundingClientRect().top
  }));
  visualTops.forEach(({ item }) => groupAnimations.get(item)?.cancel());
  mutate();

  const shifts = visualTops.map(({ item, top }) => ({
    item,
    deltaY: top - item.getBoundingClientRect().top
  }));
  shifts.forEach(({ item, deltaY }) => {
    if (Math.abs(deltaY) < 0.5) {
      groupAnimations.delete(item);
      item.style.removeProperty('will-change');
      return;
    }
    item.style.willChange = 'transform';
    const animation = item.animate(
      [
        { transform: `translate3d(0, ${deltaY}px, 0)` },
        { transform: 'translate3d(0, 0, 0)' }
      ],
      {
        duration: groupMotionMs,
        easing: 'cubic-bezier(0.2, 0, 0, 1)',
        fill: 'both'
      }
    );
    groupAnimations.set(item, animation);
    void animation.finished.then(() => {
      if (groupAnimations.get(item) !== animation) return;
      animation.cancel();
      item.style.removeProperty('will-change');
      groupAnimations.delete(item);
    }).catch(() => undefined);
  });
}

function setGroupExpanded(body: HTMLElement, icon: HTMLElement | null, expanded: boolean, card?: HTMLElement): void {
  const applyState = () => {
    body.classList.toggle('show', expanded);
    body.setAttribute('aria-hidden', String(!expanded));
    icon?.classList.toggle('open', expanded);
  };
  if (card) {
    animateGroupLayoutShift(card, applyState);
    return;
  }
  applyState();
}

function toggleSharedGroup(toggle: HTMLElement): void {
  const uid = toggle.dataset.uid;
  if (!uid) return;
  const card = toggle.closest<HTMLElement>('.group-card');
  if (!card) return;
  const body = card.querySelector<HTMLElement>(`[data-role="group-body"][data-uid="${uid}"]`);
  if (!body) return;
  const icon = card.querySelector<HTMLElement>(`[data-role="group-icon"][data-uid="${uid}"]`) ?? null;
  const expanded = !body.classList.contains('show');
  toggle.setAttribute('aria-expanded', String(expanded));
  setGroupExpanded(body, icon, expanded, card);
}

function syncImeOffset(): void {
  const viewportHeight = Math.round(window.innerHeight || document.documentElement.clientHeight || 0);
  if (viewportHeight <= 0) return;
  stableViewportHeight = Math.max(stableViewportHeight, viewportHeight);
  const offset = Math.max(0, stableViewportHeight - viewportHeight);
  document.documentElement.style.setProperty('--ime-offset', `${offset}px`);
}

function resetStableViewportSoon(): void {
  stableViewportHeight = 0;
  window.setTimeout(syncImeOffset, 260);
}

function renderItem(app: AppInfo): HTMLElement {
  const checked = isEffectivelyBlocked(app.uid, currentBlocked, pendingChanges);
  const card = document.createElement('article');
  card.className = 'card app-card';

  const main = document.createElement('div');
  main.className = 'app-main';
  const name = document.createElement('div');
  name.className = 'app-title';
  name.dataset.role = 'uid-title';
  name.dataset.uid = app.uid;
  name.classList.toggle('blocked-title', checked);
  name.textContent = app.displayPkg;

  const meta = document.createElement('div');
  meta.className = 'app-meta';
  const uid = document.createElement('span');
  uid.textContent = `UID: ${app.uid}`;
  meta.append(uid);
  if (app.isClone) meta.append(createCloneTag());
  meta.append(createBadge(app.uid));
  main.append(name, meta);

  card.append(main, createSwitch(app.uid, checked));
  return card;
}

function renderSharedGroup(uid: string, apps: AppInfo[]): HTMLElement {
  const checked = isEffectivelyBlocked(uid, currentBlocked, pendingChanges);
  const card = document.createElement('article');
  card.className = 'card group-card';

  const head = document.createElement('div');
  head.className = 'group-head';
  head.dataset.role = 'group-toggle';
  head.dataset.uid = uid;
  head.setAttribute('role', 'button');
  head.setAttribute('aria-expanded', 'false');
  head.tabIndex = 0;

  const left = document.createElement('span');
  left.className = 'group-left';
  const icon = createChevronIcon(uid);
  const title = document.createElement('span');
  title.className = 'group-title';
  title.dataset.role = 'uid-title';
  title.dataset.uid = uid;
  title.classList.toggle('blocked-title', checked);
  title.textContent = `UID: ${uid}`;
  const count = document.createElement('span');
  count.className = 'group-count';
  count.textContent = `${apps.length} 应用`;
  left.append(icon, title, count);

  const right = document.createElement('span');
  right.className = 'group-right';
  right.append(createBadge(uid), createSwitch(uid, checked));
  head.append(left, right);

  const body = document.createElement('div');
  body.className = apps.length > 12 ? 'group-body scrollable' : 'group-body';
  body.dataset.role = 'group-body';
  body.dataset.uid = uid;
  body.setAttribute('aria-hidden', 'true');
  const inner = document.createElement('div');
  inner.className = 'group-body-inner';
  for (const app of apps) {
    const row = document.createElement('div');
    row.className = 'group-row';
    const name = document.createElement('span');
    name.className = 'app-title';
    name.dataset.role = 'uid-title';
    name.dataset.uid = uid;
    name.classList.toggle('blocked-title', checked);
    name.textContent = app.displayPkg;
    row.append(name);
    if (app.isClone) row.append(createCloneTag());
    inner.append(row);
  }
  body.append(inner);

  card.append(head, body);
  return card;
}

function createListFragment(category: AppType): DocumentFragment {
  const effectiveBlocked = new Set(mergeBlocked(currentBlocked, pendingChanges));
  const filtered = filterApps(allApps, category, searchQuery, searchMode, effectiveBlocked);
  const fragment = document.createDocumentFragment();

  if (filtered.length === 0) {
    fragment.append(createStatusElement(allApps.length === 0 ? '没有缓存数据，点刷新扫描应用' : '无匹配应用'));
    return fragment;
  }

  if (category === 'shared') {
    for (const group of groupSharedApps(filtered)) fragment.append(renderSharedGroup(group.uid, group.apps));
  } else {
    for (const app of filtered) fragment.append(renderItem(app));
  }
  return fragment;
}

function renderList(keepScroll = false, scrollTop = true): void {
  const oldScroll = keepScroll ? scrollRoot.scrollTop : 0;
  listEl.replaceChildren(createListFragment(currentCategory));
  syncCategoryTabs();
  if (keepScroll) scrollRoot.scrollTo({ top: oldScroll, left: 0 });
  else if (scrollTop && currentPage === 'main') scrollTopAfterRender();
}

function updatePageChrome(page: 'main' | 'about'): void {
  document.body.classList.toggle('about-active', page === 'about');
  backButton.hidden = page !== 'about';
  titleEl.textContent = page === 'about' ? '关于 DNCS' : '网络管控';
  updateUIState();
}

function clearRouteState(): void {
  pageStage.classList.remove('route-moving');
  aboutPage.classList.remove('about-sheet');
  aboutPage.style.removeProperty('opacity');
  aboutPage.style.removeProperty('transform');
}

async function animateAbout(direction: 'in' | 'out'): Promise<void> {
  const entering = direction === 'in';
  const duration = entering ? 260 : 220;
  const keyframes: Keyframe[] = entering
    ? [
        { opacity: 0.01, transform: 'translate3d(100%, 0, 0)' },
        { opacity: 1, transform: 'translate3d(0, 0, 0)' }
      ]
    : [
        { opacity: 1, transform: 'translate3d(0, 0, 0)' },
        { opacity: 0.01, transform: 'translate3d(100%, 0, 0)' }
      ];
  const animation = aboutPage.animate(keyframes, {
    duration,
    easing: 'cubic-bezier(0.2, 0, 0, 1)',
    fill: 'forwards'
  });
  await Promise.race([
    animation.finished.catch(() => undefined),
    sleep(duration + 80)
  ]);
  animation.cancel();
}

async function showPage(nextPage: 'main' | 'about'): Promise<void> {
  if (isTransitioning) {
    queuedPage = nextPage;
    return;
  }
  if (nextPage === currentPage) return;
  isTransitioning = true;

  try {
    if (prefersReducedMotion()) {
      listEl.hidden = nextPage === 'about';
      aboutPage.hidden = nextPage === 'main';
      currentPage = nextPage;
      updatePageChrome(nextPage);
      if (nextPage === 'main') syncCategoryTabs();
      scrollRoot.scrollTo({ top: 0, left: 0 });
      return;
    }

    aboutPage.hidden = false;
    pageStage.classList.add('route-moving');
    aboutPage.classList.add('about-sheet');

    if (nextPage === 'about') {
      currentPage = 'about';
      updatePageChrome('about');
      scrollRoot.scrollTo({ top: 0, left: 0 });
      await animateAbout('in');
      listEl.hidden = true;
      aboutPage.hidden = false;
    } else {
      listEl.hidden = false;
      currentPage = 'main';
      updatePageChrome('main');
      syncCategoryTabs();
      scrollRoot.scrollTo({ top: 0, left: 0 });
      await animateAbout('out');
      aboutPage.hidden = true;
    }
  } finally {
    clearRouteState();
    isTransitioning = false;
    const queued = queuedPage;
    queuedPage = null;
    if (queued && queued !== currentPage) void showPage(queued);
  }
}

function openAbout(pushHistory = true): void {
  if (currentPage === 'about') return;
  closeMenu();
  closeSearch(true);
  if (pushHistory) history.pushState({ page: 'about' }, '', '#about');
  void showPage('about');
}

function returnToMain(): void {
  if (currentPage !== 'about') return;
  if ((history.state as { page?: string } | null)?.page === 'about') history.back();
  else void showPage('main');
}

function switchCategoryTo(targetCategory: AppType): void {
  if (currentPage !== 'main' || targetCategory === currentCategory || !CATEGORIES.includes(targetCategory)) return;
  currentCategory = targetCategory;
  renderList(false, true);
}

async function loadCachedApps(showMissing = true, clearPending = true): Promise<boolean> {
  try {
    const response = await fetch(`apps.txt?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(String(response.status));
    const parsed = parseAppsText(await response.text());
    if (parsed.apps.length === 0) throw new Error('EMPTY_APPS_CACHE');
    allApps = parsed.apps;
    currentBlocked = parsed.blocked;
    if (clearPending) pendingChanges = {};
    updateUIState();
    renderList(false);
    return true;
  } catch {
    if (showMissing) setStatus('没有缓存数据，点刷新扫描应用');
    return false;
  }
}

type RefreshOptions = {
  confirmPending?: boolean;
  toast?: boolean;
  internal?: boolean;
  status?: string;
  allowCachedFallback?: boolean;
};

async function refreshData(options: RefreshOptions = {}): Promise<boolean> {
  const {
    confirmPending = true,
    toast = true,
    internal = false,
    status = '正在扫描应用与多用户数据…',
    allowCachedFallback = true
  } = options;
  if (isBusy && !internal) return false;
  if (confirmPending && Object.keys(pendingChanges).length > 0) {
    const confirmed = await requestConfirm('刷新将丢失当前未保存的修改，确定吗？');
    if (!confirmed) return false;
  }
  if (isBusy && !internal) return false;
  if (!internal) setBusyState(true);
  setRuleStateKnown(false);
  setStatus(status);
  try {
    await yieldForPaint();
    const result = (await runCore(exec, 'list')).trim();
    if (result !== 'READY') throw new Error(result || 'EMPTY');
    if (!(await loadCachedApps(false))) throw new Error('应用缓存读取失败');
    setRuleStateKnown(true);
    if (toast) showToast('应用列表已刷新');
    return true;
  } catch (error) {
    if (allowCachedFallback && await loadCachedApps(false, false)) {
      showToast('扫描失败，已显示上次缓存');
      return false;
    }
    setStatus(`扫描失败：${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    if (!internal) setBusyState(false);
  }
}

async function applyRulesWithReconcile(
  uids: string[],
  unknownMessage: string,
  reconcileStatus: string,
  unresolvedMessage: string
): Promise<ApplyResult | null> {
  const resolution = await resolveApplyExecution(
    () => runCore(exec, 'apply', uids),
    async () => {
      setRuleStateKnown(false);
      showToast(unknownMessage);
      return refreshData({
        confirmPending: false,
        toast: false,
        internal: true,
        status: reconcileStatus,
        allowCachedFallback: false
      });
    }
  );
  if (resolution.kind === 'authoritative') return resolution.result;
  if (!resolution.succeeded) showToast(unresolvedMessage);
  return null;
}

async function saveChanges(): Promise<boolean> {
  if (isBusy || !ruleStateKnown || Object.keys(pendingChanges).length === 0) return false;
  setBusyState(true);
  try {
    await yieldForPaint();
    const finalUids = mergeBlocked(currentBlocked, pendingChanges);
    const result = await applyRulesWithReconcile(
      finalUids,
      '保存结果无法确认，正在重新同步',
      '正在核对已保存规则…',
      '保存结果仍未知，请刷新后再操作'
    );
    if (!result) return false;
    const skipped = result.requestedCount - result.appliedCount;
    currentBlocked = new Set(result.uids);
    pendingChanges = {};
    updateUIState();
    renderList(true, false);
    if (skipped > 0) showToast(`规则已写入，跳过 ${skipped} 个已卸载应用`);
    else showToast('规则已写入');
    return true;
  } catch (error) {
    showToast(`保存失败：${errorText(error)}`);
    return false;
  } finally {
    setBusyState(false);
  }
}

async function backupConfig(): Promise<void> {
  if (isBusy) return;
  if (Object.keys(pendingChanges).length > 0) {
    const confirmed = await requestConfirm('备份前需要先保存当前修改，确定吗？');
    if (!confirmed) return;
    const saved = await saveChanges();
    if (!saved || Object.keys(pendingChanges).length > 0) return;
  }

  if (isBusy) return;
  setBusyState(true);
  try {
    await yieldForPaint();
    const result = (await runCore(exec, 'backup_config')).trim();
    const match = result.match(/^BACKUP:(.+)$/);
    if (!match) throw new Error(result || 'EMPTY');
    showToast(`配置已保存：${match[1]}`);
  } catch (error) {
    showToast(isUnknownResult(error)
      ? '备份结果未知，请检查下载目录'
      : `备份失败：${errorText(error)}`);
  } finally {
    setBusyState(false);
  }
}

async function restoreConfigFromFile(file: File): Promise<void> {
  if (isBusy || !ruleStateKnown) return;
  if (file.size > 262144) {
    showToast('配置文件过大');
    return;
  }

  let uids: string[];
  let confirmText: string;
  try {
    const config = parseConfigText(await file.text());
    const resolved = resolveConfig(config, allApps);
    uids = resolved.uids;
    if (resolved.format === 'v2' && resolved.sourceGroupCount > 0 && uids.length === 0) {
      showToast('配置中的应用均已卸载或身份发生变化，未执行还原');
      return;
    }
    if (resolved.format === 'v2' && resolved.skippedGroupCount > 0) {
      confirmText = `将还原 ${uids.length} 组应用规则，跳过 ${resolved.skippedGroupCount} 组已卸载或身份变化的应用，确定吗？`;
    } else if (resolved.format === 'v2') {
      confirmText = `将还原配置中的 ${uids.length} 组应用规则，确定吗？`;
    } else {
      confirmText = `这是旧版配置，将仅按 ${uids.length} 个 UID 覆盖当前规则，确定吗？`;
    }
  } catch (error) {
    showToast(error instanceof Error ? error.message : '配置文件格式不正确');
    return;
  }

  const confirmed = await requestConfirm(`「${file.name || '配置文件'}」：${confirmText}`);
  if (!confirmed) return;
  if (isBusy || !ruleStateKnown) return;

  setBusyState(true);
  try {
    await yieldForPaint();
    const result = await applyRulesWithReconcile(
      uids,
      '还原结果无法确认，正在重新同步',
      '正在核对还原后的规则…',
      '还原结果仍未知，请刷新后再操作'
    );
    if (!result) return;
    const skipped = result.requestedCount - result.appliedCount;
    currentBlocked = new Set(result.uids);
    pendingChanges = {};
    updateUIState();
    renderList(true, false);
    if (skipped > 0) showToast(`配置已还原，跳过 ${skipped} 个已卸载应用`);
    else showToast('配置已还原');
  } catch (error) {
    showToast(`还原失败：${errorText(error)}`);
  } finally {
    setBusyState(false);
  }
}

async function fetchLog(): Promise<void> {
  const requestSequence = ++logRequestSequence;
  logContent.textContent = '读取日志…';
  let content: string;
  try {
    const response = await fetch(`dncs.log?t=${Date.now()}`, { cache: 'no-store' });
    content = response.ok ? (await response.text()) || '日志为空。' : '日志不存在。';
  } catch {
    content = '无法读取日志。';
  }
  if (requestSequence !== logRequestSequence) return;
  logContent.textContent = content;
  logContent.scrollTop = logContent.scrollHeight;
}

async function toggleDebug(): Promise<void> {
  if (isBusy) return;
  setBusyState(true);
  try {
    await yieldForPaint();
    const result = (await runCore(exec, 'toggle_debug')).trim();
    if (result !== 'DEBUG_ON' && result !== 'DEBUG_OFF') throw new Error(result || 'EMPTY');
    showToast(result === 'DEBUG_ON' ? '调试已开启' : '调试已关闭');
  } catch (error) {
    showToast(isUnknownResult(error) ? '调试开关结果未知' : `调试开关失败：${errorText(error)}`);
  } finally {
    setBusyState(false);
  }
}

async function rescueAll(): Promise<void> {
  if (isBusy || !ruleStateKnown) return;
  if (!(await requestConfirm('将清除 DNCS 防火墙链并恢复所有网络，确定吗？'))) return;
  if (isBusy || !ruleStateKnown) return;
  setBusyState(true);
  try {
    await yieldForPaint();
    const result = (await runCore(exec, 'rescue')).trim();
    if (result !== 'RESCUED') throw new Error(result || 'EMPTY');
    pendingChanges = {};
    currentBlocked.clear();
    updateUIState();
    await refreshData({ confirmPending: false, toast: false, internal: true, status: '正在恢复应用列表…', allowCachedFallback: false });
    showToast('网络已全部放行');
  } catch (error) {
    if (isUnknownResult(error)) {
      setRuleStateKnown(false);
      showToast('恢复结果未知，正在重新同步');
      const reconciled = await refreshData({ confirmPending: false, toast: false, internal: true, status: '正在核对网络规则…', allowCachedFallback: false });
      if (!reconciled) showToast('恢复结果仍未知，请刷新后再操作');
    } else {
      showToast(`恢复失败：${errorText(error)}`);
    }
  } finally {
    setBusyState(false);
  }
}

function openMenu(fromHistory = false): void {
  window.clearTimeout(menuCloseTimer);
  dropdownMenu.hidden = false;
  menuScrim.hidden = false;
  menuButton.setAttribute('aria-expanded', 'true');
  dropdownMenu.classList.remove('closing');
  dropdownMenu.classList.add('show');
  if (!fromHistory) pushOverlayHistory('menu');
}

function closeMenu(fromHistory = false): void {
  if (dropdownMenu.hidden || dropdownMenu.classList.contains('closing')) return;
  dropdownMenu.classList.add('closing');
  dropdownMenu.classList.remove('show');
  menuButton.setAttribute('aria-expanded', 'false');
  menuScrim.hidden = true;
  window.clearTimeout(menuCloseTimer);
  menuCloseTimer = window.setTimeout(() => {
    dropdownMenu.hidden = true;
    dropdownMenu.classList.remove('closing');
  }, 170);
  if (!fromHistory && (history.state as HistoryState | null)?.overlay === 'menu') history.back();
}

function toggleMenu(): void {
  if (dropdownMenu.hidden || dropdownMenu.classList.contains('closing')) openMenu();
  else closeMenu();
}

function runAfterMenuClose(action: () => void): void {
  if ((history.state as HistoryState | null)?.overlay === 'menu') {
    pendingMenuAction = action;
    closeMenu(true);
    history.back();
    return;
  }
  closeMenu(true);
  action();
}

function initHistory(): void {
  history.replaceState({ page: 'main' }, '', `${location.pathname}${location.search}`);
  window.addEventListener('popstate', (event) => {
    const state = event.state as HistoryState | null;
    if (state?.overlay === 'menu') {
      if (dropdownMenu.hidden || dropdownMenu.classList.contains('closing')) openMenu(true);
    } else if (!dropdownMenu.hidden) {
      closeMenu(true);
    }
    if (!confirmModal.hidden && state?.overlay !== 'confirm') closeConfirmModal(false, true);
    if (!logModal.hidden && state?.overlay !== 'log') closeLogModal(true);
    const page = state?.page === 'about' ? 'about' : 'main';
    void showPage(page);
    const action = pendingMenuAction;
    pendingMenuAction = null;
    action?.();
  });
}

function bindEvents(): void {
  syncImeOffset();
  window.addEventListener('resize', () => window.requestAnimationFrame(syncImeOffset), { passive: true });
  window.addEventListener('orientationchange', resetStableViewportSoon, { passive: true });
  menuButton.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleMenu();
  });
  menuButton.setAttribute('aria-expanded', 'false');
  menuScrim.addEventListener('click', () => closeMenu());
  menuScrim.addEventListener('touchmove', (event) => event.preventDefault(), { passive: false });
  dropdownMenu.addEventListener('touchmove', (event) => event.preventDefault(), { passive: false });
  window.addEventListener('click', (event) => {
    if (!(event.target as HTMLElement).closest('.menu-wrap')) closeMenu();
  });
  refreshButton.addEventListener('click', () => {
    closeMenu();
    void refreshData();
  });
  saveButton.addEventListener('click', () => void saveChanges());
  $('search-toggle').addEventListener('click', () => {
    const nextHidden = !searchPanel.hidden;
    searchPanel.hidden = nextHidden;
    document.body.classList.toggle('search-active', !nextHidden);
    if (nextHidden) closeSearch(true);
    else window.requestAnimationFrame(() => searchInput.focus({ preventScroll: true }));
  });
  searchInput.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      searchQuery = searchInput.value;
      renderList(true);
    }, 150);
  });
  document.querySelectorAll<HTMLButtonElement>('[data-search-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      searchMode = btn.dataset.searchMode as SearchMode;
      document.querySelectorAll('[data-search-mode]').forEach((item) => item.classList.toggle('active', item === btn));
      renderList(true);
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-category]').forEach((btn) => {
    btn.addEventListener('click', () => {
      switchCategoryTo(btn.dataset.category as AppType);
    });
  });
  listEl.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('.switch')) return;
    const toggle = target.closest<HTMLElement>('[data-role="group-toggle"]');
    if (toggle) toggleSharedGroup(toggle);
  });
  listEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if ((event.target as HTMLElement).closest('.switch, input')) return;
    const toggle = (event.target as HTMLElement).closest<HTMLElement>('[data-role="group-toggle"]');
    if (!toggle) return;
    event.preventDefault();
    toggle.click();
  });
  $('log-button').addEventListener('click', () => {
    runAfterMenuClose(() => {
      logModal.hidden = false;
      pushOverlayHistory('log');
      void fetchLog();
    });
  });
  $('close-log-button').addEventListener('click', () => closeLogModal());
  logModal.addEventListener('click', (event) => {
    if (event.target === logModal) closeLogModal();
  });
  confirmCancelButton.addEventListener('click', () => closeConfirmModal(false));
  confirmOkButton.addEventListener('click', () => closeConfirmModal(true));
  confirmModal.addEventListener('click', (event) => {
    if (event.target === confirmModal) closeConfirmModal(false);
  });
  $('refresh-log-button').addEventListener('click', () => void fetchLog());
  clearLogButton.addEventListener('click', async () => {
    if (isBusy) return;
    setBusyState(true);
    try {
      await yieldForPaint();
      const result = (await runCore(exec, 'clear_log')).trim();
      if (result !== 'LOG_CLEARED') throw new Error(result || 'EMPTY');
      await fetchLog();
      showToast('日志已清空');
    } catch (error) {
      if (isUnknownResult(error)) {
        await fetchLog();
        showToast('清空日志结果未知');
      } else {
        showToast(`清空日志失败：${errorText(error)}`);
      }
    } finally {
      setBusyState(false);
    }
  });
  debugButton.addEventListener('click', () => runAfterMenuClose(() => void toggleDebug()));
  rescueButton.addEventListener('click', () => runAfterMenuClose(() => void rescueAll()));
  $('about-button').addEventListener('click', () => runAfterMenuClose(() => openAbout(true)));
  backButton.addEventListener('click', returnToMain);
  backupConfigButton.addEventListener('click', () => void backupConfig());
  restoreConfigButton.addEventListener('click', () => {
    if (isBusy || !ruleStateKnown) return;
    restoreConfigInput.value = '';
    restoreConfigInput.click();
  });
  restoreConfigInput.addEventListener('change', () => {
    const file = restoreConfigInput.files?.[0];
    restoreConfigInput.value = '';
    if (file) void restoreConfigFromFile(file);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  try {
    enableEdgeToEdgeCompat(true);
  } catch {
    // Older managers rely on /internal/insets.css only.
  }
  initHistory();
  bindEvents();
  updatePageChrome('main');
  updateUIState();
  void refreshData({ toast: false });
});
