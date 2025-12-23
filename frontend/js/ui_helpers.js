// /frontend/js/ui_helpers.js
// Enhances header after injection:
//  - sets signup/login links with ?next= current page
//  - shows user avatar/name and an accessible dropdown (Dashboard / Profile / Sign out)
//  - adds an animated caret icon on the profile button (rotates when open)
//
// Backwards-compatible: falls back to localStorage if auth helpers missing.

let getStoredUser = null;
let logout = null;
try {
  import('./auth.js').then(mod => {
    if (mod.getStoredUser) getStoredUser = mod.getStoredUser;
    if (mod.logout) logout = mod.logout;
  }).catch(() => {
    // ignore
  });
} catch (e) {
  // ignore
}

const esc = (s = '') => {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

window.onHeaderInjected = () => {
  const currentPath = window.location.pathname + window.location.search;
  const headerActions = document.querySelector('.header-actions');
  if (!headerActions) return;

  function attachNext(linkEl) {
    if (!linkEl) return;
    try {
      const url = new URL(linkEl.href, window.location.origin);
      url.searchParams.set('next', currentPath);
      linkEl.href = url.toString();
    } catch (e) {
      if (linkEl.href && !linkEl.href.includes('next=')) {
        linkEl.href = `${linkEl.href}${linkEl.href.includes('?') ? '&' : '?'}next=${encodeURIComponent(currentPath)}`;
      }
    }
  }

  const signupLink = headerActions.querySelector('a.btn-primary.small') || headerActions.querySelector('a.help-cta') || headerActions.querySelector('a.signup');
  const loginLink = headerActions.querySelector('a.btn-outline') || headerActions.querySelector('a.login');
  attachNext(signupLink);
  attachNext(loginLink);

  function renderHeaderUser() {
    let user = null;
    try {
      if (typeof getStoredUser === 'function') user = getStoredUser();
      if (!user) {
        const raw = localStorage.getItem('sarthi_user_v1');
        if (raw) {
          try { user = JSON.parse(raw); } catch { user = null; }
        }
      }
    } catch (e) {
      console.warn('getStoredUser failed', e);
      user = null;
    }

    if (!user) {
      headerActions.innerHTML = `
        <a href="/auth.html" class="btn-outline">Log in</a>
        <a href="/auth.html?mode=signup" class="btn-primary small">Sign Up</a>
      `;
      attachNext(headerActions.querySelector('a.btn-primary.small'));
      attachNext(headerActions.querySelector('a.btn-outline'));
      return;
    }

    const name = esc(user.name || user.email || 'Me');
    const avatar = esc(user.picture || '/assets/google_icon.svg');

    // Build elements using createElement to avoid surprises (structure is static)
    headerActions.innerHTML = ''; // clear

    const wrapper = document.createElement('div');
    wrapper.className = 'header-user';
    wrapper.style.position = 'relative';
    wrapper.style.display = 'inline-flex';
    wrapper.style.alignItems = 'center';

    const toggle = document.createElement('button');
    toggle.id = 'profileToggle';
    toggle.setAttribute('aria-haspopup', 'true');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', 'profileDropdown');
    toggle.title = 'Open profile menu';
    toggle.style.display = 'flex';
    toggle.style.alignItems = 'center';
    toggle.style.gap = '8px';
    toggle.style.background = 'transparent';
    toggle.style.border = '0';
    toggle.style.cursor = 'pointer';
    toggle.style.padding = '4px';

    const avatarImg = document.createElement('img');
    avatarImg.src = avatar;
    avatarImg.alt = name;
    avatarImg.className = 'header-avatar';
    avatarImg.style.width = '36px';
    avatarImg.style.height = '36px';
    avatarImg.style.borderRadius = '8px';
    avatarImg.style.objectFit = 'cover';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'header-username';
    nameSpan.style.fontWeight = '600';
    nameSpan.style.fontSize = '0.95rem';
    nameSpan.style.marginLeft = '6px';
    nameSpan.textContent = user.name || user.email || 'Me';

    // Caret (SVG) element: animated by CSS when button has .open
    const caret = document.createElement('span');
    caret.className = 'profile-caret';
    caret.setAttribute('aria-hidden', 'true');
    caret.innerHTML = `
      <svg width="12" height="8" viewBox="0 0 12 8" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M1 1L6 6L11 1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
    // group inside toggle
    toggle.appendChild(avatarImg);
    toggle.appendChild(nameSpan);
    toggle.appendChild(caret);

    // Dropdown panel
    const dropdown = document.createElement('div');
    dropdown.id = 'profileDropdown';
    dropdown.setAttribute('role', 'menu');
    dropdown.setAttribute('aria-hidden', 'true');
    dropdown.style.position = 'absolute';
    dropdown.style.right = '0';
    dropdown.style.top = '56px';
    dropdown.style.minWidth = '200px';
    dropdown.style.background = 'var(--card-bg, rgba(18,18,22,0.95))';
    dropdown.style.border = '1px solid rgba(255,255,255,0.06)';
    dropdown.style.borderRadius = '8px';
    dropdown.style.padding = '8px';
    dropdown.style.boxShadow = '0 6px 20px rgba(0,0,0,0.6)';
    dropdown.style.display = 'none';
    dropdown.style.zIndex = '1200';

    // user info header
    const userInfo = document.createElement('div');
    userInfo.className = 'user-info';
    userInfo.style.display = 'flex';
    userInfo.style.gap = '10px';
    userInfo.style.alignItems = 'center';
    userInfo.style.padding = '8px';
    userInfo.style.borderBottom = '1px solid rgba(255,255,255,0.03)';
    userInfo.style.marginBottom = '6px';

    const userAvatar = document.createElement('img');
    userAvatar.src = avatar;
    userAvatar.alt = name;
    userAvatar.style.width = '44px';
    userAvatar.style.height = '44px';
    userAvatar.style.borderRadius = '8px';
    userAvatar.style.objectFit = 'cover';
    userAvatar.style.border = '1px solid rgba(255,255,255,0.04)';

    const userText = document.createElement('div');
    userText.style.overflow = 'hidden';
    userText.style.minWidth = '0';

    const userName = document.createElement('div');
    userName.style.fontWeight = '700';
    userName.style.color = 'var(--text)';
    userName.textContent = user.name || user.email || 'Me';

    const userEmail = document.createElement('div');
    userEmail.style.fontSize = '0.86rem';
    userEmail.style.color = 'var(--muted)';
    userEmail.style.whiteSpace = 'nowrap';
    userEmail.style.overflow = 'hidden';
    userEmail.style.textOverflow = 'ellipsis';
    userEmail.textContent = user.email || '';

    userText.appendChild(userName);
    userText.appendChild(userEmail);

    userInfo.appendChild(userAvatar);
    userInfo.appendChild(userText);
    dropdown.appendChild(userInfo);

    // menu items
    const dashLink = document.createElement('a');
    dashLink.href = '/pages/dashboard.html';
    dashLink.setAttribute('role', 'menuitem');
    dashLink.tabIndex = 0;
    dashLink.className = 'menu-item';
    dashLink.style.display = 'block';
    dashLink.style.padding = '8px';
    dashLink.style.borderRadius = '6px';
    dashLink.textContent = 'Dashboard';

    const signoutBtn = document.createElement('button');
    signoutBtn.id = 'headerSignoutBtn';
    signoutBtn.setAttribute('role', 'menuitem');
    signoutBtn.tabIndex = 0;
    signoutBtn.className = 'menu-item';
    signoutBtn.style.display = 'block';
    signoutBtn.style.padding = '8px';
    signoutBtn.style.borderRadius = '6px';
    signoutBtn.style.width = '100%';
    signoutBtn.style.textAlign = 'left';
    signoutBtn.style.background = 'transparent';
    signoutBtn.style.border = '0';
    signoutBtn.style.cursor = 'pointer';
    signoutBtn.textContent = 'Sign out';

    dropdown.appendChild(dashLink);
    dropdown.appendChild(signoutBtn);

    wrapper.appendChild(toggle);
    wrapper.appendChild(dropdown);
    headerActions.appendChild(wrapper);

    // Accessibility & interactivity wiring (with caret animation via toggle.classList)
    let outsideClickHandler = null;
    let keydownHandler = null;
    let focusOutHandler = null;

    function openDropdown() {
      dropdown.style.display = 'block';
      dropdown.setAttribute('aria-hidden', 'false');
      toggle.setAttribute('aria-expanded', 'true');
      toggle.classList.add('open'); // caret rotates via CSS

      const focusable = dropdown.querySelectorAll('[role="menuitem"], a, button');
      if (focusable && focusable.length) {
        for (const el of focusable) {
          if (el.tabIndex !== -1) { el.focus(); break; }
        }
      }

      outsideClickHandler = (e) => {
        if (!dropdown.contains(e.target) && !toggle.contains(e.target)) closeDropdown();
      };
      document.addEventListener('click', outsideClickHandler);

      keydownHandler = (e) => {
        if (e.key === 'Escape') { closeDropdown(); toggle.focus(); }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          const items = Array.from(dropdown.querySelectorAll('[role="menuitem"], a, button'));
          if (!items.length) return;
          const idx = items.indexOf(document.activeElement);
          let next = 0;
          if (idx === -1) next = 0;
          else {
            if (e.key === 'ArrowDown') next = Math.min(items.length - 1, idx + 1);
            else next = Math.max(0, idx - 1);
          }
          items[next].focus();
          e.preventDefault();
        }
        if (e.key === 'Enter' && document.activeElement && (document.activeElement.matches('[role="menuitem"], a, button'))) {
          document.activeElement.click();
        }
      };
      document.addEventListener('keydown', keydownHandler);

      focusOutHandler = (e) => {
        setTimeout(() => {
          if (!dropdown.contains(document.activeElement) && !toggle.contains(document.activeElement)) {
            closeDropdown();
          }
        }, 0);
      };
      dropdown.addEventListener('focusout', focusOutHandler);
    }

    function closeDropdown() {
      dropdown.style.display = 'none';
      dropdown.setAttribute('aria-hidden', 'true');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.classList.remove('open');

      if (outsideClickHandler) document.removeEventListener('click', outsideClickHandler);
      if (keydownHandler) document.removeEventListener('keydown', keydownHandler);
      if (focusOutHandler) dropdown.removeEventListener('focusout', focusOutHandler);
      outsideClickHandler = null; keydownHandler = null; focusOutHandler = null;
    }

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      if (expanded) closeDropdown(); else openDropdown();
    });

    // menu item clicks
    [dashLink, signoutBtn].forEach(el => {
      el.addEventListener('click', (ev) => {
        if (el === signoutBtn) {
          ev.preventDefault();
          (async () => {
            try {
              if (typeof logout === 'function') {
                await logout();
              } else {
                localStorage.removeItem('sarthi_user_v1');
                window.dispatchEvent(new StorageEvent('storage', { key: 'sarthi_user_v1', newValue: null }));
              }
            } catch (err) {
              console.warn('logout failed', err);
            } finally {
              closeDropdown();
              renderHeaderUser();
            }
          })();
          return;
        }
        closeDropdown();
      });
    });
  } // end renderHeaderUser()

  renderHeaderUser();

  window.addEventListener('storage', (ev) => {
    if (ev.key === 'sarthi_user_v1') renderHeaderUser();
  });

  setTimeout(renderHeaderUser, 700);
};
