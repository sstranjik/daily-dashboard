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

export async function fetchCalendarList(token) {
  const res = await fetch(`${CALENDAR_API}/users/me/calendarList`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`CalendarList API ${res.status}`);
  return res.json();
}

export async function fetchCalendarEvents(token, calendarId = 'primary') {
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

  const res = await fetch(
    `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Calendar API ${res.status}`);
  return res.json();
}

export async function fetchAllCalendarEvents(token) {
  // 1. Get list of all calendars the user has
  const calList   = await fetchCalendarList(token);

  const _isBirthdayCal = cal =>
    /birthday|ro[đd]endan/i.test(cal.summary ?? '') ||
    /[#@]contacts|birthday/i.test(cal.id ?? '');   // #contacts@group.v.calendar.google.com

  /**
   * Determines if a calendar event is a birthday.
   * Priority order — never relies on event title alone:
   *   1. From a birthday/contacts calendar (most reliable)
   *   2. Google's own eventType field = "birthday"
   *   3. All-day + recurring annually (user-created annual reminder)
   * Title matching is intentionally excluded to avoid false positives
   * like "Organiziramo proslavu za Tomislavov rođendan".
   */
  const _isBirthdayEvent = (ev, calIsBirthday) => {
    if (calIsBirthday) return true;
    if (ev.eventType === 'birthday') return true;
    // All-day event that recurs every year → birthday or anniversary
    // (both deserve birthday-style highlighting in the calendar)
    if (
      ev.start?.date && !ev.start?.dateTime &&
      ev.recurrence?.some(r => /FREQ=YEARLY/i.test(r))
    ) return true;
    return false;
  };

  const calendars = (calList.items ?? []).filter(cal =>
    // Always include birthday calendars even if user hasn't "selected" them in
    // Google Calendar UI — their selected flag defaults to false but they still
    // contain valid events we want to show.
    cal.selected !== false || _isBirthdayCal(cal)
  );

  // 2. Fetch events from every calendar in parallel; ignore individual failures
  const results = await Promise.allSettled(
    calendars.map(cal => {
      const isHolidayCal  = /holiday|blagdan|praznik/i.test(cal.summary);
      const isBirthdayCal = _isBirthdayCal(cal);
      return fetchCalendarEvents(token, cal.id).then(data =>
        (data.items ?? []).map(ev => ({
          ...ev,
          _calColor:   ev.colorId ? null : cal.backgroundColor,
          _calName:    cal.summary,
          _isHoliday:  isHolidayCal,
          // Detect birthday by calendar name/ID OR by event title
          // (catches "Damir Lolić's birthday" in any calendar)
          _isBirthday: _isBirthdayEvent(ev, isBirthdayCal),
        }))
      );
    })
  );

  // 3. Merge + sort by start time
  const all = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);

  all.sort((a, b) => {
    const aT = a.start?.dateTime ?? a.start?.date ?? '';
    const bT = b.start?.dateTime ?? b.start?.date ?? '';
    return aT.localeCompare(bT);
  });

  return { items: all };
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
