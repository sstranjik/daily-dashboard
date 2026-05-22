const STORAGE_KEY = 'dashboard_user';

let _user = null;

export function initAuth(config) {
  _user = loadStoredUser();
  updateUI();

  document.getElementById('google-signin-btn')?.addEventListener('click', () => {
    const clientId = config?.google?.client_id;
    if (!clientId || clientId.includes('YOUR_GOOGLE')) {
      showAuthNotice();
      return;
    }
    // Trigger Google One Tap or button flow
    if (window.google?.accounts?.id) {
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: handleCredentialResponse,
        auto_select: false,
      });
      window.google.accounts.id.prompt();
    }
  });

  document.getElementById('signout-btn')?.addEventListener('click', signOut);

  // GIS global callback
  window.handleGoogleSignIn = handleCredentialResponse;
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
}

function signOut() {
  _user = null;
  localStorage.removeItem(STORAGE_KEY);
  updateUI();
  if (window.google?.accounts?.id) {
    window.google.accounts.id.disableAutoSelect();
  }
}

function loadStoredUser() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function updateUI() {
  const signinBtn   = document.getElementById('google-signin-btn');
  const avatarArea  = document.getElementById('user-avatar-area');
  const userImg     = document.getElementById('user-img');
  const userName    = document.getElementById('user-display-name');

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

function showAuthNotice() {
  import('./app.js').then(m => {
    m.showToast('Dodaj Google Client ID u config.json da aktiviraš prijavu.', 'info', 5000);
  });
}

function parseJwt(token) {
  try {
    return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch { return null; }
}

export function getUser() { return _user; }
