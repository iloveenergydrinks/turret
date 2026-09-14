(() => {
  function update() {
    document.querySelectorAll('.rusd-footer-links, .blog-footer > div, .turret-legal-footer').forEach(footer => {
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
    if (window.Cookiebot) {
      if (control.hasAttribute('data-cookie-withdraw')) window.Cookiebot.withdraw();
      else window.Cookiebot.renew();
    } else {
      const status = document.querySelector('[data-consent-status]');
      if (status) status.textContent = 'Cookie settings could not load. Reload this page or contact support@turret.capital. Optional cookies are not enabled by this control.';
      else window.location.assign('https://turret.capital/cookies');
    }
  });
  function start() {
    update();
    new MutationObserver(update).observe(document.body, {childList:true, subtree:true});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once:true});
  else start();
})();
