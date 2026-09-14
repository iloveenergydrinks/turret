(() => {
  let panel, requested = false, returnFocus = null;
  const categories = ['preferences', 'statistics', 'marketing'];
  const sdkReady = () => typeof window.Cookiebot?.submitCustomConsent === 'function';
  function close() {
    if (!panel) return;
    const restore = panel.contains(document.activeElement);
    panel.hidden = true;
    if (restore && returnFocus?.isConnected) returnFocus.focus({preventScroll:true});
  }
  function details(expanded, focus = false) {
    panel.querySelector('[data-consent-details]').hidden = !expanded;
    panel.querySelector('[data-consent-main]').hidden = expanded;
    panel.querySelector('[data-consent-save-row]').hidden = !expanded;
    if (focus) panel.querySelector(expanded ? 'input' : '[data-consent-customize]').focus();
  }
  function open(expanded = false, focus = false) {
    if (!panel || !sdkReady()) { requested = true; return; }
    for (const category of categories) panel.querySelector(`[name="${category}"]`).checked = window.Cookiebot.consent?.[category] === true;
    panel.querySelector('[data-consent-error]').hidden = true;
    panel.hidden = false;
    details(expanded, focus);
    // Take over only once our controls and the real consent SDK are ready.
    document.documentElement.classList.add('turret-consent-ready');
    window.Cookiebot.hide();
    requested = false;
  }
  function save(values) {
    try {
      if (!sdkReady()) throw new Error('unavailable');
      window.Cookiebot.submitCustomConsent(...values);
      close();
    } catch {
      const error = panel.querySelector('[data-consent-error]');
      error.textContent = 'Your choice could not be saved. Try again or reload this page.';
      error.hidden = false;
    }
  }
  window.addEventListener('CookiebotOnDialogDisplay', () => open());
  window.addEventListener('CookiebotOnConsentReady', () => {
    if (panel && sdkReady()) document.documentElement.classList.add('turret-consent-ready');
    if (window.Cookiebot?.hasResponse) close();
    else if (requested) open();
  });
  function updateFooters() {
    document.querySelectorAll('.rusd-footer-links, .blog-footer > div, .turret-legal-footer').forEach(container => {
      const footer = container.querySelector('.turret-footer-legal') || container;
      for (const [label, path] of [['Privacy', '/privacy'], ['Cookies', '/cookies']]) {
        if (footer.querySelector(`a[data-turret-legal="${path}"]`)) continue;
        const link = document.createElement('a');
        link.href = 'https://turret.capital' + path;
        link.className = 'rusd-text-link';
        link.dataset.turretLegal = path;
        link.textContent = label;
        footer.append(link);
      }
      if (!document.getElementById('Cookiebot') || footer.querySelector('[data-cookie-settings]')) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'turret-cookie-settings';
      button.dataset.cookieSettings = '';
      button.textContent = 'Cookie settings';
      footer.append(button);
    });
  }
  document.addEventListener('click', event => {
    const control = event.target.closest?.('[data-cookie-settings], [data-cookie-withdraw]');
    if (!control) return;
    event.preventDefault();
    if (sdkReady()) {
      returnFocus = control;
      if (control.hasAttribute('data-cookie-withdraw')) window.Cookiebot.withdraw();
      open(true, true);
    } else {
      const status = document.querySelector('[data-consent-status]');
      if (status) status.textContent = 'Cookie settings could not load. Reload this page or contact support@turret.capital. Optional cookies are not enabled by this control.';
      else window.location.assign('https://turret.capital/cookies');
    }
  });
  function start() {
    if (document.getElementById('Cookiebot')) {
      panel = document.createElement('section');
      panel.id = 'turret-consent';
      panel.hidden = true;
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'false');
      panel.setAttribute('aria-labelledby', 'turret-consent-title');
      panel.innerHTML = `<div class="tc-heading"><img src="/brand/turret-icon.png" alt="" width="28" height="28"><h2 id="turret-consent-title">Your privacy</h2></div>
        <p class="tc-intro">Necessary cookies keep Turret working. You choose whether to allow optional cookies. <a href="/cookies">Cookie policy</a></p>
        <div data-consent-details hidden class="tc-details">
          <p class="tc-necessary">Necessary <span>Always on</span></p>
          <label><span>Preferences<small>Remember your settings</small></span><input type="checkbox" name="preferences"></label>
          <label><span>Statistics<small>Understand how the site is used</small></span><input type="checkbox" name="statistics"></label>
          <label><span>Marketing<small>Personalize ads and measure campaigns</small></span><input type="checkbox" name="marketing"></label>
        </div>
        <div data-consent-main class="tc-actions"><button type="button" data-consent-reject>Reject optional</button><button type="button" data-consent-accept>Accept all</button><button type="button" data-consent-customize class="tc-text">Customize</button></div>
        <div data-consent-save-row hidden class="tc-save"><button type="button" data-consent-back class="tc-text">Back</button><button type="button" data-consent-save>Save choices</button></div>
        <p data-consent-error role="alert" hidden class="tc-error"></p>`;
      document.body.append(panel);
      panel.querySelector('[data-consent-reject]').addEventListener('click', () => save([false, false, false]));
      panel.querySelector('[data-consent-accept]').addEventListener('click', () => save([true, true, true]));
      panel.querySelector('[data-consent-customize]').addEventListener('click', () => details(true, true));
      panel.querySelector('[data-consent-back]').addEventListener('click', () => details(false, true));
      panel.querySelector('[data-consent-save]').addEventListener('click', () => save(categories.map(category => panel.querySelector(`[name="${category}"]`).checked)));
      panel.addEventListener('keydown', event => {
        if (event.key === 'Escape' && window.Cookiebot?.hasResponse) close();
      });
      if (sdkReady()) document.documentElement.classList.add('turret-consent-ready');
      if (requested || (sdkReady() && window.Cookiebot.hasResponse === false)) open();
    }
    updateFooters();
    new MutationObserver(updateFooters).observe(document.body, {childList:true, subtree:true});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once:true});
  else start();
})();
