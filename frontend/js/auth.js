// /frontend/js/auth.js
// Robust compat-based Firebase auth helper with clear error messaging when an incompatible Firebase namespace is present.
//
// If you see "fb.auth is not a function" in the console, it means the page has a Firebase object
// that is NOT the compat SDK (firebase-app-compat + firebase-auth-compat). To fix: include the compat
// scripts BEFORE this module, or remove any modular SDK scripts that conflict.
import { FIREBASE_CONFIG } from './firebase-config.js';

const LOCAL_KEY = 'sarthi_user_v1';

// COMPAT CDN URLs — these are the builds that expose window.firebase.auth()
const COMPAT_SDKS = [
  'https://www.gstatic.com/firebasejs/9.22.2/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/9.22.2/firebase-auth-compat.js'
];

// helper to inject a script and wait for load
function injectScript(src, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = false;
    s.onload = () => resolve(true);
    s.onerror = (e) => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
    setTimeout(() => reject(new Error('Timeout loading ' + src)), timeoutMs);
  });
}

// ensure compat SDKs exist (try existing, then inject fallback)
async function ensureCompatSdks() {
  if (typeof window !== 'undefined' && typeof window.firebase !== 'undefined' && typeof window.firebase.auth === 'function') {
    // compat already present
    return true;
  }

  // try injecting compat SDKs (one by one)
  try {
    for (const url of COMPAT_SDKS) {
      // if compat is already present mid-loop, stop
      if (typeof window.firebase !== 'undefined' && typeof window.firebase.auth === 'function') break;
      // if global firebase exists but auth is not function, still inject compat scripts which will augment/replace it
      await injectScript(url, 8000);
    }
  } catch (e) {
    console.warn('[auth.js] compat SDK injection failed', e);
  }

  // final check
  if (typeof window.firebase !== 'undefined' && typeof window.firebase.auth === 'function') {
    return true;
  }

  return false;
}

// initialize compat app and return auth or throw helpful error
async function initCompatAuthOrThrow() {
  const ok = await ensureCompatSdks();
  if (!ok) {
    // If firebase exists but lacks compat API, provide explicit instructions
    if (typeof window.firebase !== 'undefined' && typeof window.firebase.auth !== 'function') {
      const msg = [
        'A Firebase namespace was found but it does not provide the compat API (firebase.auth is missing).',
        'This happens when the modular Firebase SDK is loaded instead of the compat builds, or when scripts conflict.',
        'To fix:',
        '  1) Remove any modular Firebase SDK script tags (firebase-app.js / firebase-auth.js) from this page.',
        '  2) Include these compat scripts BEFORE /js/auth.js:',
        '     <script src="https://www.gstatic.com/firebasejs/9.22.2/firebase-app-compat.js"></script>',
        '     <script src="https://www.gstatic.com/firebasejs/9.22.2/firebase-auth-compat.js"></script>',
        '  3) Alternatively, ensure only the compat SDK is loaded globally and then reload the page.'
      ].join('\n');
      console.error('[auth.js] Incompatible Firebase namespace detected. ' + msg);
      throw new Error('Incompatible Firebase namespace: firebase.auth is not available. See console for remediation steps.');
    }

    // No firebase global at all: instruct to include compat scripts or allow auth.js to inject them
    const msg2 = [
      'Firebase SDK not found. Ensure the compat SDK scripts are loaded BEFORE /js/auth.js, for example:',
      '  <script src="https://www.gstatic.com/firebasejs/9.22.2/firebase-app-compat.js"></script>',
      '  <script src="https://www.gstatic.com/firebasejs/9.22.2/firebase-auth-compat.js"></script>',
      'Or allow this module to inject them automatically (it attempts to do so).'
    ].join('\n');
    console.error('[auth.js] Firebase not detected. ' + msg2);
    throw new Error('Firebase SDK not detected. Include compat SDKs or enable script injection.');
  }

  // now firebase compat is present
  try {
    if (!window.firebase.apps || !window.firebase.apps.length) {
      window.firebase.initializeApp(FIREBASE_CONFIG);
      console.debug('[auth.js] firebase.initializeApp called (compat).');
    }
    const auth = window.firebase.auth();
    return auth;
  } catch (e) {
    console.error('[auth.js] Failed to initialize firebase auth (compat).', e);
    throw e;
  }
}

// small helper: read next param only if safe
function getNextParamSafe() {
  try {
    const p = new URLSearchParams(window.location.search).get('next');
    if (!p) return null;
    if (p.startsWith('/')) return p;
  } catch (e) {}
  return null;
}

// local storage helpers
function saveUserLocally(user) {
  if (!user) {
    try { localStorage.removeItem(LOCAL_KEY); } catch (e) {}
    return;
  }
  try {
    const small = { uid: user.uid, name: user.displayName || '', email: user.email || '', picture: user.photoURL || '' };
    localStorage.setItem(LOCAL_KEY, JSON.stringify(small));
  } catch (e) {
    console.warn('[auth.js] failed to save user locally', e);
  }
}
export function getStoredUser() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) { return null; }
}

// getIdToken
export async function getIdToken(forceRefresh = false) {
  const auth = await initCompatAuthOrThrow();
  const user = auth.currentUser;
  if (!user) return null;
  try {
    return await user.getIdToken(forceRefresh);
  } catch (e) {
    console.warn('[auth.js] getIdToken failed', e);
    return null;
  }
}

// logout
export async function logout() {
  try {
    const auth = await initCompatAuthOrThrow();
    await auth.signOut();
  } catch (e) {
    console.warn('[auth.js] logout error', e);
  } finally {
    saveUserLocally(null);
  }
}

// oauthSignIn (popup-first, fallback-to-redirect)
export async function oauthSignIn(provider = 'google') {
  const auth = await initCompatAuthOrThrow();
  if (provider !== 'google') throw new Error('Only google provider supported here');
  const googleProvider = new window.firebase.auth.GoogleAuthProvider();
  try {
    const res = await auth.signInWithPopup(googleProvider);
    return res;
  } catch (err) {
    console.warn('[auth.js] signInWithPopup failed; falling back to redirect', err);
    await auth.signInWithRedirect(googleProvider);
    return null;
  }
}

// attach onAuthStateChanged
(async function attachAuthListener() {
  try {
    const auth = await initCompatAuthOrThrow();
    auth.onAuthStateChanged((user) => {
      console.debug('[auth.js] onAuthStateChanged', !!user);
      if (user) {
        saveUserLocally(user);
        try {
          const pathname = window.location.pathname.replace(/\/$/, '');
          const isAuthPage = pathname === '/auth.html' || pathname.endsWith('/auth.html');
          const next = getNextParamSafe();
          if (isAuthPage) {
            if (next) {
              window.location.replace(next);
              return;
            } else {
              window.location.replace('/');
              return;
            }
          }
        } catch (e) {
          console.warn('[auth.js] redirect error', e);
        }
      } else {
        saveUserLocally(null);
      }
    });
    console.debug('[auth.js] onAuthStateChanged attached (compat)');
  } catch (e) {
    // initCompatAuthOrThrow already logged a helpful error
  }
})();

// helper to redirect respecting ?next=
export function handleRedirectAfterAuth(defaultPath = '/') {
  try {
    const params = new URLSearchParams(window.location.search);
    const next = params.get('next');
    if (next && next.startsWith('/')) {
      window.location.href = next;
    } else {
      window.location.href = defaultPath;
    }
  } catch (e) {
    window.location.href = defaultPath;
  }
}

// Waits until Firebase Auth is initialized and we know the user's true state
export function onAuthReady() {
  return new Promise(async (resolve) => {
    const auth = await initCompatAuthOrThrow();
    if (auth.currentUser !== null) return resolve(auth.currentUser);
    const unsub = auth.onAuthStateChanged(user => {
      unsub();
      resolve(user);
    });
  });
}

export default {
  oauthSignIn,
  getStoredUser,
  getIdToken,
  logout,
  handleRedirectAfterAuth,
  onAuthReady
};
