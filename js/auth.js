import { setAccessToken, clearAccessToken } from './api/google-api.js';

const STORAGE_KEY = 'dashboard_user';
const GRANTED_KEY = 'google_api_granted'; // set once user grants Calendar+Tasks access
const SCOPES      = 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/tasks';

let _user        = null;
let _config      = null;
let _tokenClient = null;
let _tokenCbs    = []; // per-request callbacks waiting for a fresh token

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────
export function initAuth(config) {
  _config = config;
  _user   = loadStoredUser();
  updateUI();

  const clientId = config?.google?.client_id;
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
          theme: 'filled_black',
          size:  'small',
          shape: 'pill',
          text:  'signin',
          logo_alignment: 'left',
        });

        // If user was previously signed in and has granted API access → reconnect silently
        if (_user && localStorage.getItem(GRANTED_KEY)) {
          waitForOAuth2(() => _requestToken(config, ''));
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
  if (attempts > 20) return;
  setTimeout(() => waitForGIS(cb, attempts + 1), 100);
}

function waitForOAuth2(cb, attempts = 0) {
  if (window.google?.accounts?.oauth2) { cb(); return; }
  if (attempts > 20) return;
  setTimeout(() => waitForOAuth2(cb, attempts + 1), 100);
}

// ─── TOKEN REQUEST (internal) ─────────────────────────────────────────────────
function _requestToken(config, prompt = '') {
  const clientId = config?.google?.client_id;
  if (!clientId || clientId.includes('YOUR_GOOGLE')) return;

  if (!_tokenClient) {
    _tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope:     SCOPES,
      callback:  (tokenResponse) => {
        if (tokenResponse.error) {
          console.error('OAuth error:', tokenResponse.error);
          _tokenCbs = [];
          return;
        }
        setAccessToken(tokenResponse.access_token, tokenResponse.expires_in ?? 3600);
        localStorage.setItem(GRANTED_KEY, '1');

        // Notify widgets that a fresh token is available
        window.dispatchEvent(new CustomEvent('auth:token'));

        // Fire any per-request callbacks
        _tokenCbs.forEach(cb => cb(tokenResponse.access_token));
        _tokenCbs = [];
      },
    });
  }

  _tokenClient.requestAccessToken({ prompt });
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

  // After sign-in: if user previously granted access, get token immediately (no popup)
  // Otherwise widgets will show the "Poveži" button for first-time consent
  if (localStorage.getItem(GRANTED_KEY)) {
    waitForOAuth2(() => _requestToken(_config, ''));
  } else {
    // First time — dispatch sign-in so widgets refresh and show connect button
    window.dispatchEvent(new CustomEvent('auth:signin'));
  }
}

// ─── SIGN OUT ─────────────────────────────────────────────────────────────────
function signOut() {
  _user        = null;
  _tokenClient = null;
  _tokenCbs    = [];
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
export function getUser()     { return _user; }
export function isSignedIn()  { return !!_user; }

/**
 * Request an OAuth token for Calendar + Tasks.
 * `callback` is called with the token string on success.
 * Uses empty prompt (no popup) if user has already granted access.
 */
export function requestApiAccess(config, callback) {
  if (!window.google?.accounts?.oauth2) {
    console.warn('GIS oauth2 not loaded yet');
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
