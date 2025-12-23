import { getStoredUser, logout } from './auth.js';

// helper to ensure the user menu stays within the viewport
function ensureMenuFits(menuEl) {
  if (!menuEl) return;
  // compute and nudge left if overflowing
  const rect = menuEl.getBoundingClientRect();
  const overflowX = rect.right - window.innerWidth;
  if (overflowX > 8) {
    // shift left by overflow amount (add a little margin)
    menuEl.style.right = `${8 + overflowX}px`;
  } else {
    menuEl.style.right = '0px';
  }
  // flip above if bottom overflows
  if (rect.bottom > window.innerHeight) {
    menuEl.style.top = 'auto';
    menuEl.style.bottom = 'calc(100% + 12px)';
    menuEl.style.transformOrigin = 'bottom right';
  } else {
    menuEl.style.top = 'calc(100% + 12px)';
    menuEl.style.bottom = 'auto';
    menuEl.style.transformOrigin = 'top right';
  }
}

// exported function must be at module top-level (not inside an IIFE)
export function updateHeaderUserState() {
  const user = getStoredUser();
  const guestEl = document.getElementById('guestActions');
  const userEl = document.getElementById('userActions');
  const avatarImg = document.getElementById('userAvatar');
  const avatarBtn = document.getElementById('userAvatarBtn');
  const menu = document.getElementById('userMenu');

  // user menu small items
  const menuName = document.getElementById('userMenuName');
  const menuEmail = document.getElementById('userMenuEmail');
  const menuAvatarSm = document.getElementById('userMenuAvatarSm');

  if (!guestEl || !userEl || !avatarImg || !avatarBtn || !menu || !menuName || !menuEmail || !menuAvatarSm) {
    // header not present yet; try again shortly
    return;
  }

  // clean up previous bindings if any
  if (updateHeaderUserState._boundDocClick) {
    document.removeEventListener('click', updateHeaderUserState._boundDocClick);
    updateHeaderUserState._boundDocClick = null;
  }
  if (updateHeaderUserState._boundKey) {
    document.removeEventListener('keydown', updateHeaderUserState._boundKey);
    updateHeaderUserState._boundKey = null;
  }

  if (user) {
    guestEl.style.display = 'none';
    userEl.style.display = 'inline-flex';

    const name = user.name || 'User';
    const email = user.email || '';

    avatarImg.src = user.picture || 'assets/default_avatar.png';
    avatarImg.alt = name;

    // populate menu header
    menuName.textContent = name;
    menuEmail.textContent = email;
    menuAvatarSm.src = user.picture || 'assets/default_avatar.png';
    menuAvatarSm.alt = name;

    // toggle function
    const toggle = (ev) => {
      ev.stopPropagation();
      const showing = menu.style.display === 'block';
      if (!showing) {
        menu.style.display = 'block';
        menu.setAttribute('aria-hidden', 'false');
        userEl.setAttribute('aria-expanded', 'true');
        ensureMenuFits(menu);
        // animate in
        menu.style.opacity = '0';
        menu.style.transform = 'translateY(-6px) scale(.98)';
        requestAnimationFrame(() => {
          menu.style.transition = 'opacity .18s ease, transform .18s ease';
          menu.style.opacity = '1';
          menu.style.transform = 'translateY(0) scale(1)';
        });
      } else {
        // hide
        menu.style.transition = 'opacity .12s ease, transform .12s ease';
        menu.style.opacity = '0';
        menu.style.transform = 'translateY(-6px) scale(.98)';
        setTimeout(() => { menu.style.display = 'none'; }, 140);
        menu.setAttribute('aria-hidden', 'true');
        userEl.setAttribute('aria-expanded', 'false');
      }
    };

    avatarBtn.onclick = toggle;

    // close on outside click
    updateHeaderUserState._boundDocClick = (e) => {
      if (!userEl.contains(e.target)) {
        if (menu.style.display === 'block') {
          menu.style.display = 'none';
          menu.setAttribute('aria-hidden', 'true');
          userEl.setAttribute('aria-expanded', 'false');
        }
      }
    };
    document.addEventListener('click', updateHeaderUserState._boundDocClick);

    // close on ESC
    updateHeaderUserState._boundKey = (e) => {
      if (e.key === 'Escape' && menu.style.display === 'block') {
        menu.style.display = 'none';
        menu.setAttribute('aria-hidden', 'true');
        userEl.setAttribute('aria-expanded', 'false');
      }
    };
    document.addEventListener('keydown', updateHeaderUserState._boundKey);

    // logout wiring
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
      logoutBtn.onclick = async (ev) => {
        ev.preventDefault();
        try {
          await logout();
        } catch (e) { /* ignore */ }
        window.location.href = 'index.html';
      };
    }

  } else {
    guestEl.style.display = 'flex';
    userEl.style.display = 'none';
    avatarBtn.onclick = null;
  }
}

// run after header injection
// Simple component injector and small helpers
(async function inject() {
  // Determine base path: pages under /pages/ need ../components paths,
  // root pages need /components paths. We'll try both fallbacks.
  async function fetchEither(path1, path2){
    try {
      const r1 = await fetch(path1);
      if (r1.ok) return r1.text();
    } catch(e){}
    try {
      const r2 = await fetch(path2);
      if (r2.ok) return r2.text();
    } catch(e){}
    return '';
  }

  const headerHtml = await fetchEither('components/header.html', '../components/header.html');
  const footerHtml = await fetchEither('components/footer.html', '../components/footer.html');

  const headerEl = document.getElementById('header');
  const footerEl = document.getElementById('footer');
  if (headerEl && headerHtml) {
    headerEl.innerHTML = headerHtml;
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            updateHeaderUserState();
        });
    });
    setTimeout(() => updateHeaderUserState(), 300);
    setTimeout(() => updateHeaderUserState(), 1000);
}
  if (footerEl && footerHtml) footerEl.innerHTML = footerHtml;

  // small nav active link highlight
  const links = document.querySelectorAll('.header-nav a');
  links.forEach(a => {
    if (window.location.pathname.includes(a.getAttribute('href').replace('../',''))) {
      a.classList.add('active');
    }
  });
})();
