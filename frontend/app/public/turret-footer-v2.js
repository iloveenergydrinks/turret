// Bring independently released shells into the shared footer layout. Existing
// links/buttons are moved, not cloned, so event handlers and destinations survive.
(() => {
  if (window.__turretFooterV2) return;
  window.__turretFooterV2 = true;
  const legalPaths = new Set(['/terms', '/privacy', '/cookies', '/platform/risks']);
  function group(parent, className, title) {
    let node = parent.querySelector(`:scope > .${className}`);
    if (!node) {
      node = document.createElement('nav');
      node.className = `turret-footer-group ${className}`;
      node.setAttribute('aria-label', `Footer ${title.toLowerCase()}`);
      const heading = document.createElement('h2');
      heading.textContent = title;
      node.append(heading);
      parent.append(node);
    }
    return node;
  }
  function update() {
    for (const footer of document.querySelectorAll('.rusd-footer')) {
      const inner = footer.querySelector('.rusd-footer-inner');
      const links = inner?.querySelector('.rusd-footer-links');
      if (!inner || !links) continue;
      let brand = inner.querySelector('.turret-footer-brand');
      if (!brand) {
        brand = document.createElement('div');
        brand.className = 'turret-footer-brand';
        const description = inner.querySelector(':scope > span');
        if (description) { description.classList.add('turret-footer-description'); brand.append(description); }
        inner.prepend(brand);
      }
      let contact = brand.querySelector('.turret-footer-contact');
      if (!contact) { contact = document.createElement('div'); contact.className = 'turret-footer-contact'; brand.append(contact); }
      const resources = group(links, 'turret-footer-resources', 'Resources');
      const legal = group(links, 'turret-footer-legal', 'Legal');
      for (const control of links.querySelectorAll('a, button')) {
        const href = control.getAttribute('href') || '';
        const path = href ? new URL(href, location.href).pathname.replace(/\/$/, '') : '';
        const destination = href.startsWith('mailto:') || href.includes('x.com/turret_capital')
          ? contact : legalPaths.has(path) || control.hasAttribute('data-cookie-settings') ? legal : resources;
        if (control.parentElement !== destination) destination.append(control);
      }
      const technology = footer.querySelector('.turret-technology');
      if (technology && technology.parentElement !== brand) brand.append(technology);
      footer.classList.add('turret-footer');
    }
  }
  function start() {
    update();
    new MutationObserver(update).observe(document.body, {childList: true, subtree: true});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once: true});
  else start();
})();
