import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync('web-src/index.html', 'utf8');
const css = readFileSync('web-src/style.css', 'utf8');
const main = readFileSync('web-src/main.ts', 'utf8');
const config = readFileSync('web-src/config.ts', 'utf8');

describe('Miuix Web layout contract', () => {
  it('keeps refresh next to the secondary menu in the right toolbar', () => {
    expect(html.indexOf('id="refresh-button"')).toBeLessThan(html.indexOf('id="menu-button"'));
    expect(html).toContain('id="dropdown-menu"');
    expect(html).toContain('运行日志');
    expect(html).toContain('调试开关');
    expect(html).toContain('恢复网络');
    expect(html).toContain('id="about-button"');
  });

  it('moves bottom tools into the menu and keeps the footer discipline line', () => {
    expect(html).not.toContain('class="tool-panel"');
    expect(html).toContain('id="footer-discipline"');
    expect(html).toContain('class="footer-discipline-text"');
    expect(html).toContain('「以臆测体验为耻，以真实测试为荣」');
    expect(html).not.toContain('测试准则');
    expect(css).toMatch(/\.footer-discipline\s*\{[^}]*overflow: clip/s);
    expect(css).not.toMatch(/\.footer-discipline\s*\{[^}]*transform:/s);
    expect(css).toMatch(
      /\.footer-discipline-text\s*\{[^}]*padding: 8px 20px calc\(46px \+ var\(--bottom-inset\)\)[^}]*transform: translateY\(var\(--ime-offset, 0px\)\) scale\(0\.98\)/s
    );
  });

  it('uses centered title and lightweight menu/search interactions', () => {
    expect(css).toContain('.toolbar h1');
    expect(css).toContain('left: 50%');
    expect(css).toContain('translateX(-50%)');
    expect(css).toContain('.toolbar h1::after');
    expect(css).toMatch(/\.toolbar h1::after\s*\{[^}]*position: absolute/s);
    expect(css).toMatch(/\.toolbar h1::after\s*\{[^}]*left: 100%/s);
    expect(css).toContain('.dropdown-menu.show');
    expect(main).toContain('scrollTopAfterRender');
    expect(main).not.toContain('is-pressed');
    expect(main).not.toContain('pointerdown');
    expect(css).not.toContain('is-pressed');
    expect(main).not.toContain('visual' + 'Viewport');
    expect(main).not.toContain('keyboard' + '-active');
    expect(main).not.toContain('isKeyboard' + 'Input');
    expect(main).not.toContain('confirm(');
    expect(html).toContain('id="confirm-modal"');
    expect(main).toContain('requestConfirm');
    expect(main).toContain('if (confirmModal.hidden && !confirmResolver) return');
    expect(main).toContain('if (logModal.hidden) return');
  });

  it('adds Miuix-style config backup and restore actions on the about page', () => {
    expect(html).toContain('id="backup-config-button"');
    expect(html).toContain('备份配置');
    expect(html).toContain('id="restore-config-button"');
    expect(html).toContain('还原配置');
    expect(html).toContain('id="restore-config-input"');
    expect(html).toContain('accept=".config,*/*"');
    expect(css).toContain('.about-config-actions');
    expect(css).toMatch(/\.about-config-actions\s*\{[^}]*margin-bottom: 0/s);
    expect(css).toContain('.config-action');
    expect(css).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
    expect(css).toContain('border-radius: 24px');
    expect(main).toContain('parseConfigText');
    expect(main).toContain('resolveConfig');
    expect(config).toContain('DNCS_CONFIG_V2');
    expect(config).toContain('currentIdentities.size === savedIdentities.size');
    expect(main).toContain("runCore(exec, 'backup_config')");
    expect(main).toContain("runCore(exec, 'apply', uids)");
    expect(main).toContain('restoreConfigInput.click()');
  });

  it('uses a KernelSU-safe internal scroll root, safe-area layout, save bar IME handling, and lightweight route transition', () => {
    expect(html).toContain('class="app-shell"');
    expect(css).toContain('.app-shell');
    expect(css).toContain('height: 100dvh');
    expect(css).toContain('--inline-safe-left');
    expect(css).toContain('--inline-safe-right');
    expect(css).not.toContain('padding: 0 var(--right-inset) 0 var(--left-inset)');
    expect(css).toContain('.page-stage');
    expect(css).toMatch(/\.page-stage\s*\{[^}]*display: flex/s);
    expect(css).toMatch(/\.page-stage\s*\{[^}]*flex-direction: column/s);
    expect(css).toContain('overflow-y: auto');
    expect(css).toContain('-webkit-overflow-scrolling: touch');
    expect(css).toContain('touch-action: pan-y');
    expect(css).toMatch(/\.list-area\s*\{[^}]*flex: 1 0 auto/s);
    expect(css).toMatch(/\.list-area\s*\{[^}]*min-height: 0/s);
    expect(css).not.toMatch(/\.list-area\s*\{[^}]*min-height: 100%/s);
    expect(css).not.toContain('html::' + '-webkit-scrollbar');
    expect(css).not.toContain('body::' + '-webkit-scrollbar');
    expect(css).not.toContain('body.keyboard' + '-active .save-bar');
    expect(css).not.toContain('body.search-active .save-bar');
    expect(css).toContain('.save-bar[hidden]');
    expect(html).toContain('id="menu-scrim"');
    expect(css).toContain('position: fixed');
    expect(css).toContain('width: max-content');
    expect(css).toContain('min-width: 116px');
    expect(css).toContain('--ime-offset');
    expect(main).toContain('syncImeOffset');
    expect(main).toContain('const scrollRoot = pageStage');
    expect(main).not.toContain('window.scrollY');
    expect(main).not.toContain('window.scrollTo');
    expect(main).not.toContain('--route-height');
    expect(main).not.toContain('groupExpanded' + 'Height');
    expect(css).not.toContain('--group' + '-height');
    expect(css).toContain('.about-page');
    expect(css).toMatch(/\.about-page\s*\{[^}]*flex: 0 0 auto/s);
    expect(css).toMatch(/\.about-page\s*\{[^}]*padding: 14px 18px calc\(12px \+ var\(--bottom-inset\)\)/s);
    expect(css).toContain('.about-page.about-sheet');
    for (const token of ['pa' + 'ger', 'mi-' + 'page-in-right', 'about-' + 'rise']) {
      expect(css).not.toContain(token);
    }
    expect(main).not.toContain('lockHeader' + 'TouchScroll');
    expect(main).toContain('createListFragment');
    expect(main).toContain('switchCategoryTo');
    expect(main).toContain('applyToggleChange');
    expect(main).toContain('preventScroll');
    expect(main).toContain('history.pushState');
    expect(main).toContain('popstate');
    expect(main).toContain('refreshData({ toast: false })');
    expect(main).toContain('yieldForPaint');
    for (const token of ['pa' + 'ger', 'set' + 'PointerCapture', 'pointer' + 'move']) {
      expect(main).not.toContain(token);
    }
  });

  it('keeps the shared UID expander on a compositor-friendly transform contract', () => {
    expect(main).toContain("classList.toggle('show', expanded)");
    expect(main).toContain('animateGroupLayoutShift');
    expect(main).toContain('groupAnimations');
    expect(main).toContain('top: item.getBoundingClientRect().top');
    expect(main).toContain('top - item.getBoundingClientRect().top');
    expect(main).toContain('const animation = item.animate(');
    expect(main).toContain("fill: 'both'");
    expect(main).not.toContain('groupLayoutDelta');
    expect(main).not.toContain('groupAnimationVersions');
    expect(main).not.toContain('inverseY');
    expect(main).toContain('group-body-inner');
    expect(main).not.toContain('groupExpanded' + 'Height');
    expect(css).not.toContain('max-height 0.3s cubic-bezier(0.2, 0, 0, 1)');
    expect(css).toContain('.group-body-inner');
    expect(css).toContain('will-change: transform, opacity');
    expect(css).toContain('backface-visibility: hidden');
    expect(css).toContain('transform 0.3s cubic-bezier(0.2, 0, 0, 1)');
    expect(css).toContain('.group-body.show');
    expect(css).not.toContain('max-height: 900px');
    expect(css).toContain('.group-body.scrollable.show');
    expect(css).toContain('height: 450px');
    expect(css).not.toMatch(/\.group-body\s*\{[^}]*contain:/s);
    expect(css).not.toContain('.card:active');
    expect(css).toContain('.app-card:active');
    expect(css).toContain('.group-head:active');
    expect(css).toContain('width: 28px');
    expect(css).toContain('translateX(16px)');
    expect(css).toContain('.switch input:disabled + .slider');
  });

  it('uses a small local bridge instead of bundling unused KernelSU spawn shims', () => {
    const bridge = readFileSync('web-src/bridge.ts', 'utf8');
    expect(main).not.toContain("from 'kernelsu'");
    expect(bridge).toContain('[window.ksu, window.apatch, window.ksud, window.KSU]');
    expect(bridge).toContain("typeof bridge?.exec === 'function'");
    expect(bridge).toContain('BridgeTimeoutError');
    expect(bridge).toContain('__dncsExecCallback_');
    expect(bridge).toContain('createCallbackName');
    expect(bridge).toContain('runSpawn');
    expect(bridge).toContain('bridgeSpawn.call(bridge');
    expect(bridge).not.toContain('execChain');
    expect(bridge).not.toContain('stdin');
    expect(bridge).not.toContain('stdout.on');
  });

  it('guards asynchronous UI state and queues route changes instead of dropping rapid input', () => {
    expect(main).toContain('setBusyState');
    expect(main).toContain('input.disabled = isBusy');
    expect(main).toContain('resolveApplyExecution');
    expect(main).toContain('queuedPage = nextPage');
    expect(main).toContain('if (queued && queued !== currentPage)');
    expect(main).not.toContain("currentPage === 'about' || isTransitioning");
    expect(main).toContain('logRequestSequence');
    expect(main).toContain('ruleStateKnown');
    expect(main).toContain('let ruleStateKnown = false');
    expect(main).toMatch(/setRuleStateKnown\(false\);\s*setStatus\(status\)/);
    expect(main).toContain('allowCachedFallback');
    expect(main).toContain('pushOverlayHistory');
    expect(main).toContain("overlay?: 'confirm' | 'log' | 'menu'");
    expect(main).toContain('runAfterMenuClose');
    expect(main).toContain("state?.overlay !== 'confirm'");
    expect(main).toContain("state?.overlay !== 'log'");
    expect(main).not.toContain("saveBar.classList.toggle('show'");
    expect(main).not.toContain("classList.add('menu-open'");
  });
});
