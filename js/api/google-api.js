const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const TASKS_API    = 'https://www.googleapis.com/tasks/v1';

const TOKEN_KEY     = 'g_access_token';
const TOKEN_EXP_KEY = 'g_token_expiry';

export function setAccessToken(token, expiresIn = 3600) {
  const expiry = Date.now() + expiresIn * 1000 - 60_000;
  sessionStorage.setItem(TOKEN_KEY, token);
  sessionStorage.setItem(TOKEN_EXP_KEY, String(expiry));
}

export function getAccessToken() {
  const token  = sessionStorage.getItem(TOKEN_KEY);
  const expiry = Number(sessionStorage.getItem(TOKEN_EXP_KEY));
  if (!token || Date.now() > expiry) return null;
  return token;
}

export function clearAccessToken() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_EXP_KEY);
}

export async function fetchCalendarEvents(token) {
  const now     = new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: 'true',
    orderBy:      'startTime',
    maxResults:   '50',
  });

  const res = await fetch(`${CALENDAR_API}/calendars/primary/events?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Calendar API ${res.status}`);
  return res.json();
}

export async function fetchTaskLists(token) {
  const res = await fetch(`${TASKS_API}/users/@me/lists`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Tasks lists API ${res.status}`);
  return res.json();
}

export async function fetchTasks(token, listId = '@default') {
  const params = new URLSearchParams({
    showCompleted: 'false',
    maxResults:    '50',
    showHidden:    'false',
  });
  const res = await fetch(`${TASKS_API}/lists/${encodeURIComponent(listId)}/tasks?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Tasks API ${res.status}`);
  return res.json();
}

export async function updateTask(token, listId, taskId, updates) {
  const res = await fetch(
    `${TASKS_API}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
    {
      method:  'PATCH',
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(updates),
    }
  );
  if (!res.ok) throw new Error(`Tasks PATCH ${res.status}`);
  return res.json();
}
