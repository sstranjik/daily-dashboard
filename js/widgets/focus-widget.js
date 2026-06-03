/**
 * focus-widget.js — "Dnevni fokus" sticky left sidebar widget
 *
 * Storage:
 *   focus_tasks  — task repository (never auto-deleted)
 *   focus_daily  — { date, completed[], order[], checklistDone:{taskId:[itemId]} }
 */

// ─── STORAGE ──────────────────────────────────────────────────────────────────

const LS_TASKS = 'focus_tasks';
const LS_DAILY = 'focus_daily';

function getTasks()         { try { return JSON.parse(localStorage.getItem(LS_TASKS) || '[]'); } catch { return []; } }
function saveTasks(t)       { localStorage.setItem(LS_TASKS, JSON.stringify(t)); }
function getDaily() {
  const today = todayISO();
  try {
    const d = JSON.parse(localStorage.getItem(LS_DAILY) || 'null');
    if (d && d.date === today) return d;
  } catch { /* ignore */ }
  return { date: today, completed: [], order: [], checklistDone: {} };
}
function saveDaily(d)       { localStorage.setItem(LS_DAILY, JSON.stringify(d)); }

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function uid()         { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function todayISO()    { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())}`; }
function p2(n)         { return String(n).padStart(2, '0'); }
function nowHHMM()     { const d = new Date(); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; }
function tomorrowISO() { const d = new Date(); d.setDate(d.getDate()+1); return `${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())}`; }
function esc(s)        { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ─── VISIBILITY LOGIC ─────────────────────────────────────────────────────────

/** A task is visible today if not completed today, and reminder date <= today (or no reminder) */
function isVisible(task, daily) {
  if (daily.completed.includes(task.id)) return false;
  if (!task.reminder) return true;
  return task.reminder.datetime.slice(0, 10) <= todayISO();
}

/** Build ordered list of visible tasks for widget */
function getVisibleOrdered() {
  const tasks = getTasks();
  const daily = getDaily();
  const visible = tasks.filter(t => isVisible(t, daily));

  // Apply saved order first, append any new tasks at the end
  const ordered = [];
  for (const id of daily.order) {
    const t = visible.find(t => t.id === id);
    if (t) ordered.push(t);
  }
  // Tasks not yet in order (newly added, or order was reset)
  for (const t of visible) {
    if (!ordered.find(o => o.id === t.id)) ordered.push(t);
  }
  return { ordered, daily };
}

/** Renumber priorities 1..N according to current display order, save tasks */
function renumberByOrder(order) {
  const tasks = getTasks();
  order.forEach((id, i) => {
    const t = tasks.find(t => t.id === id);
    if (t) t.priority = i + 1;
  });
  saveTasks(tasks);
}

// ─── RENDER WIDGET ────────────────────────────────────────────────────────────

export function renderWidget() {
  const list = document.getElementById('focus-task-list');
  if (!list) return;

  const { ordered, daily } = getVisibleOrdered();

  if (!ordered.length) {
    list.innerHTML = `<div class="focus-empty">Nema aktivnih taskova.<br>Klikni + za dodavanje.</div>`;
    return;
  }

  list.innerHTML = ordered.map((task, i) => renderCard(task, i + 1, daily)).join('');
  initDrag(list, ordered);
}

function renderCard(task, priority, daily) {
  const remMeta = task.reminder
    ? `<span>⏰ ${task.reminder.datetime.slice(11, 16)}</span>` : '';
  const cDone = (daily.checklistDone[task.id] || []).length;
  const cTotal = task.contentType === 'checklist' ? (task.checklist || []).length : 0;
  const checkMeta = cTotal > 0 ? `<span>${cDone}/${cTotal}</span>` : '';

  return `
    <div class="focus-card" data-id="${esc(task.id)}" draggable="true">
      <div class="focus-drag-handle" title="Povuci za sortiranje">⠿</div>
      <div class="focus-card-body">
        <div class="focus-card-name">${esc(task.name)}</div>
        ${(remMeta || checkMeta) ? `<div class="focus-card-meta">${remMeta}${checkMeta}</div>` : ''}
      </div>
      <button class="focus-card-done" data-id="${esc(task.id)}" title="Označi gotovo"
              onclick="event.stopPropagation()">✓</button>
    </div>`;
}

// ─── DRAG AND DROP ────────────────────────────────────────────────────────────

let _dragId = null;

function initDrag(container, ordered) {
  container.addEventListener('dragstart', e => {
    const card = e.target.closest('.focus-card');
    if (!card) return;
    _dragId = card.dataset.id;
    card.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
  });

  container.addEventListener('dragend', e => {
    const card = e.target.closest('.focus-card');
    if (card) card.classList.remove('is-dragging');
    container.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(el => {
      el.classList.remove('drag-over-top', 'drag-over-bottom');
    });
    _dragId = null;
  });

  container.addEventListener('dragover', e => {
    e.preventDefault();
    const target = e.target.closest('.focus-card');
    container.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(el => {
      el.classList.remove('drag-over-top', 'drag-over-bottom');
    });
    if (!target || target.dataset.id === _dragId) return;
    const rect = target.getBoundingClientRect();
    const mid  = rect.top + rect.height / 2;
    target.classList.add(e.clientY < mid ? 'drag-over-top' : 'drag-over-bottom');
  });

  container.addEventListener('drop', e => {
    e.preventDefault();
    const target = e.target.closest('.focus-card');
    if (!target || !_dragId || target.dataset.id === _dragId) return;

    const rect   = target.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    const ids    = ordered.map(t => t.id);
    const from   = ids.indexOf(_dragId);
    ids.splice(from, 1);
    const to = ids.indexOf(target.dataset.id);
    ids.splice(before ? to : to + 1, 0, _dragId);

    const daily = getDaily();
    daily.order = ids;
    saveDaily(daily);
    renumberByOrder(ids);
    renderWidget();
  });
}

// ─── TASK DETAIL POPUP ────────────────────────────────────────────────────────

let _popupTaskId = null;

export function openPopup(taskId, cardEl) {
  if (_popupTaskId === taskId) { closePopup(); return; }
  _popupTaskId = taskId;

  const tasks = getTasks();
  const daily = getDaily();
  const task  = tasks.find(t => t.id === taskId);
  if (!task) return;

  let popup = document.getElementById('focus-popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'focus-popup';
    popup.className = 'focus-popup';
    document.body.appendChild(popup);
  }

  const doneItems = daily.checklistDone[task.id] || [];
  const bodyHtml = buildPopupBody(task, doneItems);

  popup.innerHTML = `
    <div class="focus-popup-header">
      <span class="focus-popup-title">${esc(task.name)}</span>
      <button class="focus-popup-close" id="focus-popup-close">×</button>
    </div>
    <div class="focus-popup-body">${bodyHtml}</div>
    <div class="focus-popup-footer">
      <button class="focus-popup-done-btn" id="focus-popup-done">Gotovo</button>
    </div>`;

  // Position: to the right of the sidebar
  const sidebar = document.querySelector('.focus-sidebar');
  const sRect   = sidebar ? sidebar.getBoundingClientRect() : { right: 240 };
  const cRect   = cardEl.getBoundingClientRect();
  const topPos  = Math.min(cRect.top, window.innerHeight - 340);
  popup.style.left = `${sRect.right + 8}px`;
  popup.style.top  = `${Math.max(topPos, 64)}px`;
  popup.removeAttribute('hidden');

  document.getElementById('focus-popup-close').addEventListener('click', closePopup);
  document.getElementById('focus-popup-done').addEventListener('click', () => completeTask(taskId));

  // Checklist item toggles
  popup.querySelectorAll('.focus-popup-check-item').forEach(item => {
    const cb = item.querySelector('input[type="checkbox"]');
    cb.addEventListener('change', () => toggleChecklistItem(taskId, item.dataset.itemId, cb.checked));
  });

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('mousedown', _outsidePopup);
  }, 10);
}

function _outsidePopup(e) {
  const popup = document.getElementById('focus-popup');
  if (popup && !popup.contains(e.target) && !e.target.closest('.focus-card-body')) {
    closePopup();
  }
}

export function closePopup() {
  _popupTaskId = null;
  const popup = document.getElementById('focus-popup');
  if (popup) popup.setAttribute('hidden', '');
  document.removeEventListener('mousedown', _outsidePopup);
}

function buildPopupBody(task, doneItems) {
  if (!task.content && (!task.checklist || !task.checklist.length)) {
    return `<p class="focus-popup-no-content">Nema sadržaja.</p>`;
  }
  if (task.contentType === 'checklist' && task.checklist?.length) {
    const items = task.checklist.map(item => {
      const done = doneItems.includes(item.id);
      return `<label class="focus-popup-check-item${done ? ' is-done' : ''}" data-item-id="${esc(item.id)}">
        <input type="checkbox" ${done ? 'checked' : ''} data-item-id="${esc(item.id)}">
        <span>${esc(item.text)}</span>
      </label>`;
    }).join('');
    return `<div class="focus-popup-checklist">${items}</div>`;
  }
  return `<p class="focus-popup-text">${esc(task.content || '')}</p>`;
}

function toggleChecklistItem(taskId, itemId, checked) {
  const daily = getDaily();
  if (!daily.checklistDone[taskId]) daily.checklistDone[taskId] = [];
  if (checked) {
    if (!daily.checklistDone[taskId].includes(itemId)) daily.checklistDone[taskId].push(itemId);
  } else {
    daily.checklistDone[taskId] = daily.checklistDone[taskId].filter(id => id !== itemId);
  }
  saveDaily(daily);

  // Check if all items done → auto-complete
  const tasks = getTasks();
  const task  = tasks.find(t => t.id === taskId);
  if (task?.checklist?.length && daily.checklistDone[taskId].length >= task.checklist.length) {
    completeTask(taskId);
    return;
  }
  // Refresh popup body
  const popup = document.getElementById('focus-popup');
  if (popup) {
    const body = popup.querySelector('.focus-popup-body');
    if (body) body.innerHTML = buildPopupBody(task, daily.checklistDone[taskId] || []);
    popup.querySelectorAll('.focus-popup-check-item').forEach(item => {
      const cb = item.querySelector('input[type="checkbox"]');
      cb.addEventListener('change', () => toggleChecklistItem(taskId, item.dataset.itemId, cb.checked));
    });
  }
  renderWidget();
}

function completeTask(taskId) {
  closePopup();
  const daily = getDaily();
  if (!daily.completed.includes(taskId)) daily.completed.push(taskId);
  saveDaily(daily);
  renderWidget();
  if (typeof openEditModal._listEl !== 'undefined') refreshEditListIfOpen();
}

// ─── EDIT MODAL (list of all tasks) ──────────────────────────────────────────

export function openEditModal() {
  document.getElementById('focus-edit-overlay').classList.remove('hidden');
  document.getElementById('focus-edit-modal').classList.remove('hidden');
  refreshEditList();
}

function closeEditModal() {
  document.getElementById('focus-edit-overlay').classList.add('hidden');
  document.getElementById('focus-edit-modal').classList.add('hidden');
}

function refreshEditListIfOpen() {
  const modal = document.getElementById('focus-edit-modal');
  if (modal && !modal.classList.contains('hidden')) refreshEditList();
}

function refreshEditList() {
  const tasks = getTasks();
  const daily = getDaily();
  const listEl = document.getElementById('focus-edit-list');
  if (!listEl) return;

  if (!tasks.length) {
    listEl.innerHTML = `<div class="focus-edit-empty">Nema taskova. Dodaj prvi!</div>`;
    return;
  }

  // Sort by priority, then by name
  const sorted = [...tasks].sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));

  listEl.innerHTML = sorted.map(task => {
    const isActive    = isVisible(task, daily);
    const isCompleted = daily.completed.includes(task.id);
    const pillClass   = isActive ? 'is-active' : 'is-inactive';
    const pillLabel   = isActive ? 'aktivno' : '–';
    const nameClass   = isCompleted ? 'is-completed' : '';
    return `
      <div class="focus-edit-row">
        <button class="focus-edit-pill ${pillClass}"
                data-toggle-id="${esc(task.id)}"
                title="${isActive ? 'Makni s liste' : 'Dodaj na listu'}">${pillLabel}</button>
        <button class="focus-edit-name-btn ${nameClass}"
                data-edit-id="${esc(task.id)}">${esc(task.name)}</button>
        <button class="focus-edit-trash" data-trash-id="${esc(task.id)}"
                title="Obriši task">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <path d="M2 3.5h9M5 3.5V2.5a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 .5.5v1M3 3.5l.5 7h6l.5-7"
                  stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>`;
  }).join('');

  // Pill toggle — adds/removes task from today's visible list via reminder manipulation
  listEl.querySelectorAll('[data-toggle-id]').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); toggleTaskActive(btn.dataset.toggleId); });
  });
  // Name button → open form
  listEl.querySelectorAll('[data-edit-id]').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); openTaskForm(btn.dataset.editId); });
  });
  // Trash → inline confirm
  listEl.querySelectorAll('[data-trash-id]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (btn.dataset.confirm === 'true') {
        deleteTask(btn.dataset.trashId);
      } else {
        btn.dataset.confirm = 'true';
        btn.textContent = 'Obriši?';
        btn.title = 'Potvrdi brisanje';
        setTimeout(() => {
          btn.dataset.confirm = 'false';
          // Re-render to restore icon
          refreshEditList();
        }, 3000);
      }
    });
  });
}

/** Toggle whether a task appears on today's list.
 *  Active tasks with no reminder: set a past-date reminder to hide, or remove reminder.
 *  Inactive tasks: clear the future reminder (set to today or remove). */
function toggleTaskActive(taskId) {
  const tasks = getTasks();
  const task  = tasks.find(t => t.id === taskId);
  if (!task) return;
  const daily   = getDaily();
  const active  = isVisible(task, daily);

  if (active) {
    // Hide: set reminder to tomorrow (so it disappears today but comes back tomorrow)
    task.reminder = { datetime: `${tomorrowISO()}T00:00` };
  } else {
    // Show: clear reminder
    task.reminder = null;
    // Also un-complete if completed today
    daily.completed = daily.completed.filter(id => id !== taskId);
    saveDaily(daily);
  }
  saveTasks(tasks);
  renderWidget();
  refreshEditList();
}

function deleteTask(taskId) {
  const tasks   = getTasks().filter(t => t.id !== taskId);
  const daily   = getDaily();
  daily.completed = daily.completed.filter(id => id !== taskId);
  daily.order     = daily.order.filter(id => id !== taskId);
  delete daily.checklistDone[taskId];
  saveTasks(tasks);
  saveDaily(daily);
  renderWidget();
  refreshEditList();
}

// ─── TASK FORM ────────────────────────────────────────────────────────────────

let _editingTaskId = null;

export function openTaskForm(taskId = null) {
  _editingTaskId = taskId;
  const tasks = getTasks();
  const task  = taskId ? tasks.find(t => t.id === taskId) : null;

  const modal   = document.getElementById('focus-form-modal');
  const overlay = document.getElementById('focus-form-overlay');
  modal.classList.remove('hidden');
  overlay.classList.remove('hidden');

  // Populate title
  document.getElementById('focus-form-title').textContent = task ? 'Uredi task' : 'Novi task';

  // Fields
  document.getElementById('ff-name').value     = task?.name     || '';
  document.getElementById('ff-priority').value = task?.priority != null ? task.priority : '';

  // Content type
  const type = task?.contentType || 'text';
  setContentType(type);
  document.getElementById('ff-text').value = task?.content || '';
  // Checklist
  const clItems = document.getElementById('ff-checklist-items');
  clItems.innerHTML = '';
  if (type === 'checklist' && task?.checklist) {
    task.checklist.forEach(item => addChecklistRow(item.text, item.id));
  }

  // Reminder
  const hasReminder = !!task?.reminder;
  document.getElementById('ff-reminder-on').checked = hasReminder;
  document.getElementById('ff-reminder-fields').style.display = hasReminder ? '' : 'none';
  if (hasReminder) {
    const dt   = task.reminder.datetime;
    const date = dt.slice(0, 10);
    const day  = date === tomorrowISO() ? 'tomorrow' : 'today';
    document.querySelector(`input[name="ff-day"][value="${day}"]`).checked = true;
    document.getElementById('ff-time').value = dt.slice(11, 16);
  } else {
    document.querySelector('input[name="ff-day"][value="today"]').checked = true;
    document.getElementById('ff-time').value = '';
  }
  updateTimeHint();

  // Delete button visibility
  const delBtn = document.getElementById('focus-form-delete');
  delBtn.style.display = task ? '' : 'none';
}

function closeTaskForm() {
  document.getElementById('focus-form-modal').classList.add('hidden');
  document.getElementById('focus-form-overlay').classList.add('hidden');
  _editingTaskId = null;
}

function setContentType(type) {
  document.getElementById('ff-toggle-text').classList.toggle('is-active', type === 'text');
  document.getElementById('ff-toggle-list').classList.toggle('is-active', type === 'checklist');
  document.getElementById('ff-text-wrap').style.display     = type === 'text' ? '' : 'none';
  document.getElementById('ff-checklist-wrap').style.display = type === 'checklist' ? '' : 'none';
}

function addChecklistRow(text = '', id = null) {
  const container = document.getElementById('ff-checklist-items');
  const rowId     = id || uid();
  const row       = document.createElement('div');
  row.className   = 'ff-checklist-item';
  row.dataset.id  = rowId;
  row.innerHTML   = `
    <input type="text" class="modal-input" placeholder="Stavka…" value="${esc(text)}" style="flex:1">
    <button class="ff-checklist-remove" title="Ukloni stavku">×</button>`;
  row.querySelector('.ff-checklist-remove').addEventListener('click', () => row.remove());
  container.appendChild(row);
  row.querySelector('input').focus();
}

function updateTimeHint() {
  const hint = document.getElementById('ff-time-hint');
  const day  = document.querySelector('input[name="ff-day"]:checked')?.value;
  if (hint) hint.textContent = day === 'today' ? `Mora biti nakon ${nowHHMM()}` : 'Bilo koje vrijeme';
}

function saveTaskForm() {
  const name = document.getElementById('ff-name').value.trim();
  if (!name) {
    document.getElementById('ff-name').focus();
    document.getElementById('ff-name').style.borderColor = 'var(--color-danger)';
    return;
  }
  document.getElementById('ff-name').style.borderColor = '';

  const priorityVal = document.getElementById('ff-priority').value.trim();
  const priority    = priorityVal !== '' ? parseInt(priorityVal) : null;

  // Content
  const type = document.getElementById('ff-toggle-text').classList.contains('is-active') ? 'text' : 'checklist';
  let content   = '';
  let checklist = [];
  if (type === 'text') {
    content = document.getElementById('ff-text').value;
  } else {
    document.querySelectorAll('#ff-checklist-items .ff-checklist-item').forEach(row => {
      const text = row.querySelector('input').value.trim();
      if (text) checklist.push({ id: row.dataset.id, text });
    });
  }

  // Reminder
  let reminder = null;
  if (document.getElementById('ff-reminder-on').checked) {
    const day  = document.querySelector('input[name="ff-day"]:checked')?.value || 'today';
    const time = document.getElementById('ff-time').value;
    if (!time) {
      document.getElementById('ff-time').focus();
      document.getElementById('ff-time').style.borderColor = 'var(--color-danger)';
      return;
    }
    document.getElementById('ff-time').style.borderColor = '';
    // Validate: today's time must be after now
    if (day === 'today' && time <= nowHHMM()) {
      document.getElementById('ff-time').style.borderColor = 'var(--color-danger)';
      document.getElementById('ff-time-hint').textContent  = '⚠ Mora biti nakon trenutnog vremena';
      return;
    }
    const date = day === 'today' ? todayISO() : tomorrowISO();
    reminder = { datetime: `${date}T${time}` };
  }

  const tasks = getTasks();
  if (_editingTaskId) {
    const t = tasks.find(t => t.id === _editingTaskId);
    if (t) {
      t.name = name; t.priority = priority ?? t.priority;
      t.contentType = type; t.content = content; t.checklist = checklist;
      t.reminder = reminder;
    }
  } else {
    // Auto-assign priority: max existing + 1
    const maxP = tasks.reduce((m, t) => Math.max(m, t.priority ?? 0), 0);
    tasks.push({
      id: uid(), name, priority: priority ?? maxP + 1,
      contentType: type, content, checklist, reminder,
    });
  }
  saveTasks(tasks);

  // Update daily order to include new task
  const daily = getDaily();
  if (!_editingTaskId) {
    const newTask = tasks[tasks.length - 1];
    if (!daily.order.includes(newTask.id)) daily.order.push(newTask.id);
    saveDaily(daily);
  }

  closeTaskForm();
  renderWidget();
  refreshEditListIfOpen();
}

// ─── REMINDER SYSTEM ──────────────────────────────────────────────────────────

const _firedReminders = new Set();

export function checkReminders() {
  const tasks   = getTasks();
  const daily   = getDaily();
  const now     = new Date();
  const todayS  = todayISO();
  let   changed = false;

  for (const task of tasks) {
    if (!task.reminder) continue;
    if (daily.completed.includes(task.id)) continue;
    if (_firedReminders.has(task.id)) continue;

    const dt   = task.reminder.datetime;
    const date = dt.slice(0, 10);
    if (date !== todayS) continue; // only today's reminders

    if (new Date(dt) <= now) {
      _firedReminders.add(task.id);
      showReminderNotif(task);
      // Remove reminder from task
      task.reminder = null;
      changed = true;
    }
  }
  if (changed) { saveTasks(tasks); renderWidget(); }
}

function showReminderNotif(task) {
  let notif = document.getElementById('focus-reminder-notif');
  if (!notif) {
    notif = document.createElement('div');
    notif.id        = 'focus-reminder-notif';
    notif.className = 'focus-reminder-notif';
    document.body.appendChild(notif);
  }

  notif.innerHTML = `
    <div class="focus-reminder-tag">⏰ Podsjetnik</div>
    <div class="focus-reminder-name">${esc(task.name)}</div>
    <div class="focus-reminder-actions">
      <button class="btn-secondary" id="focus-reminder-ok">OK</button>
      <button class="btn-primary"   id="focus-reminder-open">Otvori task</button>
    </div>`;
  notif.removeAttribute('hidden');

  const dismiss = () => notif.setAttribute('hidden', '');
  document.getElementById('focus-reminder-ok').addEventListener('click', dismiss);
  document.getElementById('focus-reminder-open').addEventListener('click', () => {
    dismiss();
    // Find and click the card
    const card = document.querySelector(`.focus-card[data-id="${task.id}"]`);
    if (card) openPopup(task.id, card);
    else {
      // Task might not be visible yet — force-show and open
      renderWidget();
      setTimeout(() => {
        const c2 = document.querySelector(`.focus-card[data-id="${task.id}"]`);
        if (c2) openPopup(task.id, c2);
      }, 50);
    }
  });
}

// ─── WIRE UP STATIC HTML ──────────────────────────────────────────────────────

function initStaticHandlers() {
  // Widget card clicks (delegated)
  document.getElementById('focus-task-list')?.addEventListener('click', e => {
    const doneBtn = e.target.closest('.focus-card-done');
    if (doneBtn) {
      completeTask(doneBtn.dataset.id);
      return;
    }
    const card = e.target.closest('.focus-card');
    if (card) openPopup(card.dataset.id, card);
  });

  // Edit modal open/close
  document.getElementById('focus-open-edit')?.addEventListener('click', openEditModal);
  document.getElementById('focus-edit-close')?.addEventListener('click', closeEditModal);
  document.getElementById('focus-edit-overlay')?.addEventListener('click', closeEditModal);
  document.getElementById('focus-add-new-btn')?.addEventListener('click', () => openTaskForm(null));

  // Form modal
  document.getElementById('focus-form-overlay')?.addEventListener('click', closeTaskForm);
  document.getElementById('focus-form-close')?.addEventListener('click', closeTaskForm);
  document.getElementById('focus-form-cancel')?.addEventListener('click', closeTaskForm);
  document.getElementById('focus-form-save')?.addEventListener('click', saveTaskForm);
  document.getElementById('focus-form-delete')?.addEventListener('click', () => {
    if (_editingTaskId && confirm('Trajno obrisati ovaj task?')) {
      deleteTask(_editingTaskId);
      closeTaskForm();
    }
  });

  // Content type toggle
  document.getElementById('ff-toggle-text')?.addEventListener('click', () => setContentType('text'));
  document.getElementById('ff-toggle-list')?.addEventListener('click', () => setContentType('checklist'));

  // Add checklist item
  document.getElementById('ff-add-item')?.addEventListener('click', () => addChecklistRow());

  // Reminder toggle
  document.getElementById('ff-reminder-on')?.addEventListener('change', e => {
    document.getElementById('ff-reminder-fields').style.display = e.target.checked ? '' : 'none';
  });

  // Day radio changes → update hint
  document.querySelectorAll('input[name="ff-day"]').forEach(r =>
    r.addEventListener('change', updateTimeHint));
}

// ─── INIT ─────────────────────────────────────────────────────────────────────

export function initFocusWidget() {
  initStaticHandlers();
  renderWidget();
  checkReminders();
  setInterval(checkReminders, 60_000);
}
