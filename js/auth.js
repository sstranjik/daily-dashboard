import { setAccessToken, clearAccessToken, getAccessToken } from './api/google-api.js';

const STORAGE_KEY = 'dashboard_user';
export const GRANTED_KEY = 'google_api_granted';
const SCOPES      = 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/tasks';

let _user        = null;
let _config      = null;
let _tokenClient = null;
let _tokenCbs    = [];
let _lastPrompt  = 'none';
let _silentTried = false; // prevent duplicate silent-auth attempts

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────
export function initAuth(config) {
  _config = config;
  _user   = loadStoredUser();
  updateUI();

  const clientId  = config?.google?.client_id;
  const signinBtn = document.getElementById('google-signin-btn');

  if (signinBtn) {
    if (!clientId || clientId.includes('YOUR_GOOGLE')) {
      signinBtn.addEventListener('click', () =>
        import('./app.js').then(m =>
          m.showToast('Dodaj Google Client ID u config.json.', 'info', 5000)
        )
      );
      return;
    }

    // ── FAST PATH: valid cached token in localStorage ─────────────────────
    // Widgets will read it directly from getAccessToken() — no OAuth needed.
    // Dispatch auth:token on next tick so any listeners set up after initAuth fire.
    if (getAccessToken()) {
      setTimeout(() => window.dispatchEvent(new CustomEvent('auth:token')), 0);
    }

    // ── GIS INIT ─────────────────────────────────────────────────────────
    waitForGIS(() => {
      window.google.accounts.id.initialize({
        client_id:   clientId,
        callback:    handleCredentialResponse,
        auto_select: false,
      });
      window.google.accounts.id.renderButton(signinBtn, {
        theme:          'filled_black',
        size:           'small',
        shape:          'pill',
        text:           'signin',
        logo_alignment: 'left',
      });

      // If no valid cached token but user previously granted access → silent GIS auth
      if (!getAccessToken() && localStorage.getItem(GRANTED_KEY) && !_silentTried) {
        _silentTried = true;
        _toast('info', 'Spajanje s Google...', 3000);
        waitForOAuth2(() => _requestToken(config, 'none'));
      }
    });
  }

  document.getElementById('signout-btn')?.addEventListener('click', signOut);
  window.handleGoogleSignIn = handleCredentialResponse;
}

// ─── TOAST HELPER (avoids circular import with app.js) ────────────────────────
function _toast(type, msg, duration = 4000) {
  import('./app.js').then(m => m.showToast(msg, type, duration)).catch(() => {});
}

// ─── GIS / OAUTH2 READINESS ───────────────────────────────────────────────────
function waitForGIS(cb, attempts = 0) {
  if (window.google?.accounts?.id) { cb(); return; }
  if (attempts > 60) {
    console.warn('[Auth] GIS library did not load in time');
    if (!getAccessToken() && localStorage.getItem(GRANTED_KEY)) {
      _toast('warning', 'Google biblioteka nije se učitala. Klikni "Poveži" za ručno spajanje.', 6000);
      window.dispatchEvent(new CustomEvent('auth:silent-failed'));
    }
    return;
  }
  setTimeout(() => waitForGIS(cb, attempts + 1), 100);
}

function waitForOAuth2(cb, attempts = 0) {
  if (window.google?.accounts?.oauth2) { cb(); return; }
  if (attempts > 60) {
    console.warn('[Auth] GIS oauth2 not available');
    _toast('warning', 'OAuth2 nije dostupan. Klikni "Poveži" za ručno spajanje.', 6000);
    window.dispatchEvent(new CustomEvent('auth:silent-failed'));
    return;
  }
  setTimeout(() => waitForOAuth2(cb, attempts + 1), 100);
}

// ─── TOKEN REQUEST (internal) ─────────────────────────────────────────────────
function _requestToken(config, prompt = 'none') {
  const clientId = config?.google?.client_id;
  if (!clientId || clientId.includes('YOUR_GOOGLE')) return;

  _lastPrompt = prompt;

  if (!_tokenClient) {
    _tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope:     SCOPES,
      callback:  _handleTokenResponse,
    });
  }

  _tokenClient.requestAccessToken({ prompt });
}

function _handleTokenResponse(tokenResponse) {
  const wasSilent = _lastPrompt === 'none';

  if (tokenResponse.error) {
    console.warn('[Auth] Token error:', tokenResponse.error, '(silent:', wasSilent, ')');

    if (wasSilent) {
      _toast('warning',
        `Auto-spajanje nije uspjelo (${tokenResponse.error}). Klikni "Poveži" u widgetu.`,
        7000
      );
      window.dispatchEvent(new CustomEvent('auth:silent-failed'));
    } else {
      _toast('error', `Spajanje nije uspjelo: ${tokenResponse.error}`, 6000);
    }
    _tokenCbs = [];
    return;
  }

  setAccessToken(tokenResponse.access_token, tokenResponse.expires_in ?? 3600);
  localStorage.setItem(GRANTED_KEY, '1');

  const wasAutoReconnect = wasSilent;
  if (wasAutoReconnect) {
    _toast('success', 'Google Calendar i Tasks spojeni ✓', 3000);
  }

  window.dispatchEvent(new CustomEvent('auth:token'));
  _tokenCbs.forEach(cb => cb(tokenResponse.access_token));
  _tokenCbs = [];
}

// ─── SIGN-IN CALLBACK ─────────────────────────────────────────────────────────
function handleCredentialResponse(response) {
  if (!response?.credential) return;
  const payload = parseJwt(response.credential);
  if (!payload) return;

  _user = {
    name:    payload.name || payload.email?.split('@')[0] || 'User',
    email:   payload.email || '',
    picture: payload.picture || '',
    sub:     payload.sub,
  };

  localStorage.setItem(STORAGE_KEY, JSON.stringify(_user));
  updateUI();

  if (localStorage.getItem(GRANTED_KEY)) {
    // Previously granted — get token silently
    waitForOAuth2(() => _requestToken(_config, 'none'));
  } else {
    window.dispatchEvent(new CustomEvent('auth:signin'));
  }
}

// ─── SIGN OUT ─────────────────────────────────────────────────────────────────
function signOut() {
  _user        = null;
  _tokenClient = null;
  _tokenCbs    = [];
  _lastPrompt  = 'none';
  _silentTried = false;
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(GRANTED_KEY);
  clearAccessToken();
  updateUI();
  window.google?.accounts?.id?.disableAutoSelect();
  window.dispatchEvent(new CustomEvent('auth:signout'));
}

// ─── UI ───────────────────────────────────────────────────────────────────────
function loadStoredUser() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function updateUI() {
  const signinWrap = document.getElementById('google-signin-btn');
  const avatarArea = document.getElementById('user-avatar-area');
  const userImg    = document.getElementById('user-img');
  const userName   = document.getElementById('user-display-name');

  if (_user) {
    signinWrap?.classList.add('hidden');
    avatarArea?.classList.remove('hidden');
    if (userImg && _user.picture) { userImg.src = _user.picture; userImg.alt = _user.name; }
    if (userName) userName.textContent = _user.name;
  } else {
    signinWrap?.classList.remove('hidden');
    avatarArea?.classList.add('hidden');
  }
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────
export function getUser()    { return _user; }
export function isSignedIn() { return !!_user; }

/**
 * Request OAuth token from a user-gesture handler (button click).
 * Uses prompt:'' so the OAuth popup is allowed by the browser.
 */
export function requestApiAccess(config, callback) {
  if (!window.google?.accounts?.oauth2) {
    waitForOAuth2(() => requestApiAccess(config, callback));
    return;
  }
  if (callback) _tokenCbs.push(callback);
  _requestToken(config, '');
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function parseJwt(token) {
  try {
    return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch { return null; }
}
