const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const TASKS_API    = 'https://www.googleapis.com/tasks/v1';

const TOKEN_KEY     = 'g_access_token';
const TOKEN_EXP_KEY = 'g_token_expiry';

export function setAccessToken(token, expiresIn = 3600) {
  // Store in localStorage so it survives page reloads (valid ~1 hour)
  const expiry = Date.now() + expiresIn * 1000 - 60_000;
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(TOKEN_EXP_KEY, String(expiry));
}

export function getAccessToken() {
  const token  = localStorage.getItem(TOKEN_KEY);
  const expiry = Number(localStorage.getItem(TOKEN_EXP_KEY));
  if (!token || Date.now() > expiry) return null;
  return token;
}

export function clearAccessToken() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_EXP_KEY);
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

/**
 * Fetch task-type events from Google Calendar to read their reminder times.
 * Google Tasks API discards the time from `due`, but Calendar API exposes it.
 * Returns Map<titleLowerCase → "HH:MM">
 */
export async function fetchTaskTimesFromCalendar(token) {
  const now     = new Date();
  const timeMin = new Date(now.getTime() -  60 * 24 * 3600 * 1000).toISOString(); // 60 days back
  const timeMax = new Date(now.getTime() + 365 * 24 * 3600 * 1000).toISOString(); // 1 year ahead

  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: 'true',
    maxResults:   '250',
    eventTypes:   'task',
  });

  const res = await fetch(`${CALENDAR_API}/calendars/primary/events?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Calendar eventTypes=task: ${res.status}`);
  const data = await res.json();

  const map   = new Map();
  const nowMs = now.getTime();

  for (const ev of data.items ?? []) {
    const dt = ev.start?.dateTime;
    if (!dt || !ev.summary) continue;    // skip date-only tasks (no time info)
    const key  = ev.summary.trim().toLowerCase();
    const evMs = new Date(dt).getTime();
    const d    = new Date(dt);
    const time = d.toLocaleTimeString('hr-HR', { hour: '2-digit', minute: '2-digit', hour12: false });

    // If multiple tasks share the same title, keep the one closest to today
    if (!map.has(key) || Math.abs(evMs - nowMs) < Math.abs(map.get(key)._ms - nowMs)) {
      map.set(key, { time, _ms: evMs });
    }
  }

  return new Map([...map.entries()].map(([k, v]) => [k, v.time]));
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
    showCompleted: 'true',   // fetch all incl. subtasks (we filter in JS)
    maxResults:    '100',
    showHidden:    'false',
  });
  const res = await fetch(`${TASKS_API}/lists/${encodeURIComponent(listId)}/tasks?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Tasks API ${res.status}`);
  return res.json();
}

export async function createTask(token, listId, taskData) {
  const params = new URLSearchParams();
  if (taskData.parent) params.set('parent', taskData.parent);
  const res = await fetch(
    `${TASKS_API}/lists/${encodeURIComponent(listId)}/tasks?${params}`,
    {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: taskData.title, notes: taskData.notes ?? '' }),
    }
  );
  if (!res.ok) throw new Error(`Tasks create ${res.status}`);
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
