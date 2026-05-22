import { setAccessToken, clearAccessToken } from './api/google-api.js';

const STORAGE_KEY = 'dashboard_user';
const SCOPES = 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/tasks';

let _user        = null;
let _tokenClient = null;
let _apiReadyCbs = [];

export function initAuth(config) {
  _user = loadStoredUser();
  updateUI();

  document.getElementById('google-signin-btn')?.addEventListener('click', () => {
    const clientId = config?.google?.client_id;
    if (!clientId || clientId.includes('YOUR_GOOGLE')) {
      import('./app.js').then(m =>
        m.showToast('Dodaj Google Client ID u config.json.', 'info', 5000)
      );
      return;
    }
    triggerSignIn(clientId);
  });

  document.getElementById('signout-btn')?.addEventListener('click', signOut);
  window.handleGoogleSignIn = handleCredentialResponse;
}

function triggerSignIn(clientId) {
  if (!window.google?.accounts?.id) return;
  window.google.accounts.id.initialize({
    client_id: clientId,
    callback:  handleCredentialResponse,
    auto_select: false,
  });
  window.google.accounts.id.prompt();
}

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

  // Notify any widgets waiting for sign-in
  _apiReadyCbs.forEach(cb => cb());
  _apiReadyCbs = [];
}

function signOut() {
  _user = null;
  localStorage.removeItem(STORAGE_KEY);
  clearAccessToken();
  _tokenClient = null;
  updateUI();
  window.google?.accounts?.id?.disableAutoSelect();
  // Reload widgets to show sign-in prompts
  window.dispatchEvent(new CustomEvent('auth:signout'));
}

function loadStoredUser() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function updateUI() {
  const signinBtn  = document.getElementById('google-signin-btn');
  const avatarArea = document.getElementById('user-avatar-area');
  const userImg    = document.getElementById('user-img');
  const userName   = document.getElementById('user-display-name');

  if (_user) {
    signinBtn?.setAttribute('hidden', '');
    avatarArea?.removeAttribute('hidden');
    if (userImg && _user.picture) { userImg.src = _user.picture; userImg.alt = _user.name; }
    if (userName) userName.textContent = _user.name;
  } else {
    signinBtn?.removeAttribute('hidden');
    avatarArea?.setAttribute('hidden', '');
  }
}

export function getUser() { return _user; }

export function isSignedIn() { return !!_user; }

/**
 * Request an OAuth token for Calendar + Tasks.
 * `callback` is called with the token string on success.
 * If user isn't signed in yet, queues the request for after sign-in.
 */
export function requestApiAccess(config, callback) {
  if (!window.google?.accounts?.oauth2) {
    console.warn('GIS not loaded yet');
    return;
  }

  const clientId = config?.google?.client_id;
  if (!clientId || clientId.includes('YOUR_GOOGLE')) return;

  if (!_tokenClient) {
    _tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope:     SCOPES,
      callback:  (tokenResponse) => {
        if (tokenResponse.error) {
          console.error('OAuth error:', tokenResponse.error);
          return;
        }
        setAccessToken(tokenResponse.access_token, tokenResponse.expires_in ?? 3600);
        if (callback) callback(tokenResponse.access_token);
      },
    });
  }

  _tokenClient.requestAccessToken({ prompt: '' });
}

function parseJwt(token) {
  try {
    return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch { return null; }
}
