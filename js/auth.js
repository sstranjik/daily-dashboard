import { setAccessToken, clearAccessToken } from './api/google-api.js';

const STORAGE_KEY = 'dashboard_user';
const SCOPES = 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/tasks';

let _user        = null;
let _tokenClient = null;
let _apiReadyCbs = [];

export function initAuth(config) {
  _user = loadStoredUser();
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
      // Wait for GIS to load, then render the official button into the existing container
      waitForGIS(() => {
        window.google.accounts.id.initialize({
          client_id:   clientId,
          callback:    handleCredentialResponse,
          auto_select: false,
        });
        // Replace custom button with rendered Google button
        window.google.accounts.id.renderButton(signinBtn, {
          theme: 'filled_black',
          size:  'small',
          shape: 'pill',
          text:  'signin',
          logo_alignment: 'left',
        });
      });
    }
  }

  document.getElementById('signout-btn')?.addEventListener('click', signOut);
  window.handleGoogleSignIn = handleCredentialResponse;
}

function waitForGIS(cb, attempts = 0) {
  if (window.google?.accounts?.id) { cb(); return; }
  if (attempts > 20) return; // give up after ~2s
  setTimeout(() => waitForGIS(cb, attempts + 1), 100);
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
