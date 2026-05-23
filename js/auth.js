import { setAccessToken, clearAccessToken } from './api/google-api.js';

const STORAGE_KEY = 'dashboard_user';
export const GRANTED_KEY = 'google_api_granted'; // set once user grants Calendar+Tasks access
const SCOPES      = 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/tasks';

let _user        = null;
let _config      = null;
let _tokenClient = null;
let _tokenCbs    = []; // per-request callbacks waiting for a fresh token
let _lastPrompt  = 'none'; // track whether the last requestAccessToken was silent

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
    } else {
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

        // If user previously granted API access → try silent reconnect immediately.
        // Uses prompt:'none' — no popup, returns token or error, never blocks.
        if (localStorage.getItem(GRANTED_KEY)) {
          waitForOAuth2(() => _requestToken(config, 'none'));
        }
      });
    }
  }

  document.getElementById('signout-btn')?.addEventListener('click', signOut);
  window.handleGoogleSignIn = handleCredentialResponse;
}

// ─── GIS / OAUTH2 READINESS ───────────────────────────────────────────────────
function waitForGIS(cb, attempts = 0) {
  if (window.google?.accounts?.id) { cb(); return; }
  if (attempts > 60) {
    console.warn('GIS did not load in time');
    return;
  }
  setTimeout(() => waitForGIS(cb, attempts + 1), 100);
}

function waitForOAuth2(cb, attempts = 0) {
  if (window.google?.accounts?.oauth2) { cb(); return; }
  if (attempts > 60) {
    console.warn('GIS oauth2 did not load in time');
    // If it never loads and user had granted access, fire silent-failed so widgets fall back
    if (localStorage.getItem(GRANTED_KEY)) {
      window.dispatchEvent(new CustomEvent('auth:silent-failed'));
    }
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
    if (!wasSilent) {
      // Non-silent failures are unexpected — log them
      console.error('OAuth error:', tokenResponse.error);
    }
    // For silent failures, tell widgets to fall back to the connect prompt
    if (wasSilent) {
      window.dispatchEvent(new CustomEvent('auth:silent-failed'));
    }
    _tokenCbs = [];
    return;
  }

  setAccessToken(tokenResponse.access_token, tokenResponse.expires_in ?? 3600);
  localStorage.setItem(GRANTED_KEY, '1');

  // Notify widgets that a fresh token is available
  window.dispatchEvent(new CustomEvent('auth:token'));

  // Fire any per-request callbacks (e.g. from "Poveži" button)
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

  // After sign-in: if user previously granted access, get token silently (no popup)
  if (localStorage.getItem(GRANTED_KEY)) {
    waitForOAuth2(() => _requestToken(_config, 'none'));
  } else {
    // First time — dispatch sign-in so widgets refresh and show "Poveži" button
    window.dispatchEvent(new CustomEvent('auth:signin'));
  }
}

// ─── SIGN OUT ─────────────────────────────────────────────────────────────────
function signOut() {
  _user        = null;
  _tokenClient = null;
  _tokenCbs    = [];
  _lastPrompt  = 'none';
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
 * Request an OAuth token for Calendar + Tasks.
 * Call this from a user-gesture handler (button click) — prompt:'' allows popup.
 * `callback` is called with the token string on success.
 */
export function requestApiAccess(config, callback) {
  if (!window.google?.accounts?.oauth2) {
    // GIS not loaded yet — wait for it
    waitForOAuth2(() => requestApiAccess(config, callback));
    return;
  }
  if (callback) _tokenCbs.push(callback);
  // Use empty prompt so popup is allowed (must be called from user gesture)
  _requestToken(config, '');
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function parseJwt(token) {
  try {
    return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch { return null; }
}
