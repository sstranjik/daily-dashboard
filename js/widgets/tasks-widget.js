import { getAccessToken, fetchTaskLists, fetchTasks, updateTask, createTask } from '../api/google-api.js';
import { requestApiAccess } from '../auth.js';
import { showToast } from '../app.js';

let _listId    = '@default';
let _allTasks  = [];          // all tasks incl. subtasks and completed
let _appConfig = null;

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────
export async function renderTasks(config) {
  _appConfig = config;
  const el = document.getElementById('widget-tasks');
  if (!el) return;
  el.classList.remove('loading');

  const token = getAccessToken();
  if (!token) { showConnectPrompt(el, config); return; }

  el.innerHTML = headerHtml() + skeletonHtml();

  try {
    try {
      const lists = await fetchTaskLists(token);
      if (lists.items?.length) _listId = lists.items[0].id;
    } catch { /* keep @default */ }

    const data  = await fetchTasks(token, _listId);
    _allTasks   = data.items ?? [];

    const rootTasks = _allTasks.filter(t => !t.parent && t.status !== 'completed');
    renderTaskList(el, rootTasks);
  } catch (err) {
    console.error('Tasks fetch failed:', err);
    if (err.message?.includes('401')) showConnectPrompt(el, config);
    else el.innerHTML = headerHtml() + `<div class="error-state">⚠ Greška pri dohvaćanju taskova.</div>`;
  }
}

// ─── KEEP / MULTI-LINE NOTE HELPERS ──────────────────────────────────────────
function isMultiLineNote(task) {
  return !!(task.notes && task.notes.includes('\n'));
}

function getDisplayTitle(task) {
  if (task.title && task.title.trim()) return task.title;
  if (task.notes) {
    const firstLine = task.notes.split('\n')[0].trim();
    if (firstLine) return firstLine;
  }
  return '(bez naslova)';
}

function getNotesPreview(task) {
  if (!task.notes) return '';
  const lines = task.notes.split('\n').filter(l => l.trim());
  if (!task.title || !task.title.trim()) {
    // Title derived from first line — show second line as preview
    return lines.length > 1 ? lines[1].trim() : '';
  }
  return lines[0] || '';
}

// ─── DUE DATE HELPERS ─────────────────────────────────────────────────────────
/**
 * Returns { date: Date, showTime: boolean }.
 * Midnight UTC (Google Tasks date-only) → local-date parse, no time shown.
 * Any other time → UTC Date parse, time shown in local timezone.
 */
function parseDueInfo(due) {
  if (!due) return null;
  const isDateOnly = /T00:00:00(\.000)?Z$/.test(due);
  if (isDateOnly) {
    const [y, m, d] = due.slice(0, 10).split('-').map(Number);
    return { date: new Date(y, m - 1, d), showTime: false };
  }
  return { date: new Date(due), showTime: true };
}

function localMidnight(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

// ─── RENDER LIST ──────────────────────────────────────────────────────────────
function renderTaskList(el, tasks) {
  if (!tasks.length) {
    el.innerHTML = `
      ${headerHtml()}
      <div class="empty-state">
        <div class="empty-state-icon">✅</div>
        <div class="empty-state-title">Sve završeno!</div>
        <div class="empty-state-desc">Nema aktivnih zadataka.</div>
      </div>`;
    return;
  }

  const today = localMidnight(new Date());

  // Sort ascending by full datetime; tasks without due date go last
  const sorted = [...tasks].sort((a, b) => {
    if (a.due && !b.due) return -1;
    if (!a.due && b.due) return  1;
    if (a.due && b.due)  return parseDueInfo(a.due).date - parseDueInfo(b.due).date;
    return 0;
  });

  const itemsHtml = sorted.map(task => {
    const subtaskCount = _allTasks.filter(t => t.parent === task.id && t.status !== 'completed').length;
    const subtaskDone  = _allTasks.filter(t => t.parent === task.id && t.status === 'completed').length;
    const subtaskTotal = subtaskCount + subtaskDone;

    const displayTitle   = getDisplayTitle(task);
    const notesPreview   = getNotesPreview(task);
    const multiLine      = isMultiLineNote(task);
    const hasNoTitle     = !task.title || !task.title.trim();

    const noteText = notesPreview.replace(/\s+/g, ' ').trim();
    const notesHtml = noteText
      ? `<div class="task-notes">${escHtml(noteText)}${hasNoTitle ? ' <span class="task-keep-badge">bilj.</span>' : ''}</div>`
      : hasNoTitle && multiLine
        ? `<div class="task-notes"><span class="task-keep-badge">bilj.</span></div>`
        : '';

    let dueHtml = '';
    if (task.due) {
      const dueInfo = parseDueInfo(task.due);
      const due     = dueInfo.date;
      const diff    = Math.round((localMidnight(due) - today) / 86400000);
      let cls = '', label = '';
      if      (diff < 0)  { cls = 'overdue'; label = `Zakašnjelo ${Math.abs(diff)}d`; }
      else if (diff === 0) { cls = 'today';   label = 'Danas'; }
      else if (diff === 1) { label = 'Sutra'; }
      else if (diff <= 6)  { label = due.toLocaleDateString('hr-HR', { weekday: 'short', day: 'numeric', month: 'numeric' }); }
      else                 { label = due.toLocaleDateString('hr-HR', { day: 'numeric', month: 'short' }); }

      if (dueInfo.showTime) {
        const timeStr = due.toLocaleTimeString('hr-HR', { hour: '2-digit', minute: '2-digit' });
        label += ` · ${timeStr}`;
      }

      dueHtml = `
        <div class="task-meta">
          <span class="task-due${cls ? ' ' + cls : ''}">
            <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
              <rect x="0.5" y="1" width="8" height="7" rx="1" stroke="currentColor" stroke-width="0.9"/>
              <path d="M0.5 3.5h8M2.5 0.5v1.5M6.5 0.5v1.5" stroke="currentColor" stroke-width="0.9" stroke-linecap="round"/>
            </svg>
            ${label}
          </span>
          ${subtaskTotal ? `<span class="task-subtask-badge">${subtaskDone}/${subtaskTotal}</span>` : ''}
        </div>`;
    } else if (subtaskTotal) {
      dueHtml = `
        <div class="task-meta">
          <span class="task-subtask-badge">${subtaskDone}/${subtaskTotal}</span>
        </div>`;
    }

    return `
      <div class="task-item" data-task-id="${escHtml(task.id)}" data-list-id="${escHtml(_listId)}">
        <input type="checkbox" class="task-check" aria-label="Završi zadatak">
        <div class="task-body">
          <div class="task-title">${escHtml(displayTitle)}</div>
          ${notesHtml}
          ${dueHtml}
        </div>
        <span class="task-edit-hint">uredi →</span>
      </div>`;
  }).join('');

  el.innerHTML = `
    ${headerHtml()}
    <div class="tasks-scroll">
      <div class="task-list">${itemsHtml}</div>
    </div>
    <div class="tasks-footer">
      <span>${tasks.length} aktiv${tasks.length === 1 ? 'an' : 'nih'}</span>
      <span>Google Tasks</span>
    </div>`;

  attachTaskHandlers(el, sorted);
}

// ─── EVENT HANDLERS ───────────────────────────────────────────────────────────
function attachTaskHandlers(el, tasks) {
  el.querySelectorAll('.task-item').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.classList.contains('task-check')) return;
      const task = tasks.find(t => t.id === row.dataset.taskId);
      if (task) openTaskModal(task);
    });
  });

  el.querySelectorAll('.task-check').forEach(chk => {
    chk.addEventListener('change', async e => {
      e.stopPropagation();
      const row    = chk.closest('.task-item');
      const taskId = row.dataset.taskId;
      const listId = row.dataset.listId;
      row.classList.add('completed');
      chk.disabled = true;

      const token = getAccessToken();
      if (!token) return;
      try {
        await updateTask(token, listId, taskId, { status: 'completed' });
        setTimeout(() => {
          row.style.transition = 'opacity 0.3s';
          row.style.opacity = '0';
          setTimeout(() => row.remove(), 300);
        }, 500);
      } catch (err) {
        console.error('Task complete failed:', err);
        row.classList.remove('completed');
        chk.disabled = false;
        chk.checked  = false;
      }
    });
  });
}

// ─── TASK MODAL ───────────────────────────────────────────────────────────────
function openTaskModal(task) {
  const modal   = document.getElementById('task-modal');
  const overlay = document.getElementById('task-modal-overlay');
  if (!modal) return;

  const titleEl = document.getElementById('task-edit-title');
  const dateEl  = document.getElementById('task-edit-date');
  const timeEl  = document.getElementById('task-edit-time');
  const notesEl = document.getElementById('task-edit-notes');

  if (titleEl) titleEl.value = task.title || '';
  if (dateEl)  dateEl.value  = task.due ? task.due.slice(0, 10) : '';

  // Show/hide time field based on whether task has a real (non-midnight) time
  const timeField = timeEl?.closest('.modal-field');
  if (timeField) {
    const dueInfo = task.due ? parseDueInfo(task.due) : null;
    if (dueInfo?.showTime) {
      timeField.style.display = '';
      timeEl.value = dueInfo.date.toLocaleTimeString('hr-HR', {
        hour: '2-digit', minute: '2-digit', hour12: false,
      });
    } else {
      timeField.style.display = 'none';
      if (timeEl) timeEl.value = '';
    }
  }

  // Notes: hide textarea for multi-line notes (shown as checklist instead)
  const multiLine = isMultiLineNote(task);
  if (notesEl) {
    if (multiLine) {
      notesEl.style.display = 'none';
    } else {
      notesEl.style.display = '';
      notesEl.value = task.notes || '';
    }
  }

  // Render subtasks + Keep checklist sections
  renderSubtasksInModal(modal, task);

  modal.classList.remove('hidden');
  overlay.classList.remove('hidden');
  titleEl?.focus();

  const saveBtn   = document.getElementById('task-modal-save');
  const cancelBtn = document.getElementById('task-modal-cancel');
  const closeBtn  = document.getElementById('task-modal-close');

  const cleanup = () => {
    modal.classList.add('hidden');
    overlay.classList.add('hidden');
    if (notesEl) notesEl.style.display = '';
    if (timeField) timeField.style.display = 'none';
    saveBtn?.removeEventListener('click', onSave);
    cancelBtn?.removeEventListener('click', cleanup);
    closeBtn?.removeEventListener('click', cleanup);
    overlay?.removeEventListener('click', cleanup);
  };

  const onSave = async () => {
    const updates = { title: titleEl?.value?.trim() || task.title };

    // Collect notes from checklist or textarea
    if (multiLine) {
      const checklist = modal.querySelector('.task-keep-checklist');
      if (checklist) {
        const lines = [];
        checklist.querySelectorAll('.keep-item-text').forEach(inp => {
          const v = inp.value.trim();
          if (v) lines.push(v);
        });
        updates.notes = lines.join('\n');
      }
    } else {
      if (notesEl?.value !== undefined) updates.notes = notesEl.value;
    }

    if (dateEl?.value) {
      const timeVisible = timeField && timeField.style.display !== 'none';
      if (timeVisible && timeEl?.value) {
        // Combine date + local time → UTC ISO string
        const localDt = new Date(dateEl.value + 'T' + timeEl.value + ':00');
        updates.due = localDt.toISOString();
      } else {
        updates.due = dateEl.value + 'T00:00:00.000Z';
      }
    } else {
      updates.due = null;
    }

    const token = getAccessToken();
    if (!token) { cleanup(); return; }

    try {
      await updateTask(token, _listId, task.id, updates);
      cleanup();
      renderTasks(_appConfig);
      showToast('Zadatak spremljen', 'success');
    } catch (err) {
      console.error('Task save failed:', err);
      showToast('Greška pri spremanju.', 'error');
    }
  };

  saveBtn?.addEventListener('click', onSave);
  cancelBtn?.addEventListener('click', cleanup);
  closeBtn?.addEventListener('click', cleanup);
  overlay?.addEventListener('click', cleanup);
}

function renderSubtasksInModal(modal, task) {
  modal.querySelector('.task-modal-subtasks')?.remove();
  modal.querySelector('.task-keep-checklist-section')?.remove();

  const modalBody = modal.querySelector('.modal-body');
  if (!modalBody) return;

  // Keep / multi-line notes checklist
  if (isMultiLineNote(task)) {
    renderKeepChecklist(modalBody, task);
  }

  // Regular subtasks section
  const subtasks = _allTasks.filter(t => t.parent === task.id);

  const section = document.createElement('div');
  section.className = 'task-modal-subtasks';

  const itemsHtml = subtasks.map(sub => `
    <div class="task-subtask-row" data-subtask-id="${escHtml(sub.id)}">
      <input type="checkbox" class="task-check subtask-modal-check"
             ${sub.status === 'completed' ? 'checked' : ''}
             aria-label="${escHtml(sub.title)}">
      <span class="task-subtask-title${sub.status === 'completed' ? ' done' : ''}">${escHtml(sub.title || '')}</span>
    </div>`).join('');

  section.innerHTML = `
    <div class="modal-label" style="margin-top:var(--sp-3);margin-bottom:6px">
      Podzadaci${subtasks.length ? ` <span style="color:var(--text-muted);font-weight:400">(${subtasks.filter(s=>s.status==='completed').length}/${subtasks.length})</span>` : ''}
    </div>
    <div class="task-subtask-list">${itemsHtml}</div>
    <div style="display:flex;gap:var(--sp-2);margin-top:6px">
      <input type="text" class="modal-input" id="new-subtask-input"
             placeholder="Novi podzadatak…" style="flex:1;font-size:12px">
      <button class="btn-secondary" id="add-subtask-btn" style="font-size:12px;padding:6px 12px;white-space:nowrap">+ Dodaj</button>
    </div>`;

  modalBody.appendChild(section);

  section.querySelectorAll('.subtask-modal-check').forEach(chk => {
    chk.addEventListener('change', async () => {
      const row       = chk.closest('.task-subtask-row');
      const subtaskId = row.dataset.subtaskId;
      const titleEl   = row.querySelector('.task-subtask-title');
      const token     = getAccessToken();
      if (!token) return;
      try {
        const newStatus = chk.checked ? 'completed' : 'needsAction';
        await updateTask(token, _listId, subtaskId, { status: newStatus });
        const sub = _allTasks.find(t => t.id === subtaskId);
        if (sub) sub.status = newStatus;
        titleEl?.classList.toggle('done', chk.checked);
        updateSubtaskBadge(task.id);
      } catch (err) {
        console.error('Subtask toggle failed:', err);
        chk.checked = !chk.checked;
      }
    });
  });

  section.querySelector('#add-subtask-btn')?.addEventListener('click', async () => {
    const input = section.querySelector('#new-subtask-input');
    const title = input?.value?.trim();
    if (!title) return;
    const token = getAccessToken();
    if (!token) return;
    try {
      const newSub = await createTask(token, _listId, { title, parent: task.id });
      _allTasks.push(newSub);
      input.value = '';
      renderSubtasksInModal(modal, task);
      updateSubtaskBadge(task.id);
      showToast('Podzadatak dodan', 'success');
    } catch (err) {
      console.error('Create subtask failed:', err);
      showToast('Greška pri dodavanju podzadatka.', 'error');
    }
  });
}

function renderKeepChecklist(modalBody, task) {
  const lines = task.notes.split('\n').filter(l => l.trim());

  const section = document.createElement('div');
  section.className = 'task-keep-checklist-section';

  const itemsHtml = lines.map(line => `
    <div class="keep-item">
      <button class="keep-item-remove" aria-label="Ukloni stavku" title="Ukloni">×</button>
      <input type="text" class="keep-item-text modal-input" value="${escHtml(line.trim())}" style="flex:1;font-size:12px">
    </div>`).join('');

  section.innerHTML = `
    <div class="modal-label" style="margin-top:var(--sp-3);margin-bottom:6px">
      Sadržaj bilješke <span style="color:var(--text-muted);font-weight:400">(${lines.length} stavki)</span>
    </div>
    <div class="task-keep-checklist">${itemsHtml}</div>
    <div style="display:flex;gap:var(--sp-2);margin-top:6px">
      <input type="text" class="modal-input" id="new-keep-line-input"
             placeholder="Nova stavka…" style="flex:1;font-size:12px">
      <button class="btn-secondary" id="add-keep-line-btn" style="font-size:12px;padding:6px 12px;white-space:nowrap">+ Dodaj</button>
    </div>`;

  modalBody.appendChild(section);

  section.querySelectorAll('.keep-item-remove').forEach(btn => {
    btn.addEventListener('click', () => btn.closest('.keep-item')?.remove());
  });

  section.querySelector('#add-keep-line-btn')?.addEventListener('click', () => {
    const input    = section.querySelector('#new-keep-line-input');
    const text     = input?.value?.trim();
    if (!text) return;
    const checklist = section.querySelector('.task-keep-checklist');
    const newItem   = document.createElement('div');
    newItem.className = 'keep-item';
    newItem.innerHTML = `
      <button class="keep-item-remove" aria-label="Ukloni stavku" title="Ukloni">×</button>
      <input type="text" class="keep-item-text modal-input" value="${escHtml(text)}" style="flex:1;font-size:12px">`;
    newItem.querySelector('.keep-item-remove')?.addEventListener('click', () => newItem.remove());
    checklist.appendChild(newItem);
    if (input) input.value = '';
    input?.focus();
  });
}

function updateSubtaskBadge(parentId) {
  const row = document.querySelector(`[data-task-id="${CSS.escape(parentId)}"]`);
  if (!row) return;
  const subs  = _allTasks.filter(t => t.parent === parentId);
  const done  = subs.filter(t => t.status === 'completed').length;
  const total = subs.length;
  let badge = row.querySelector('.task-subtask-badge');
  if (!badge && total) {
    const meta = row.querySelector('.task-meta') ?? (() => {
      const m = document.createElement('div');
      m.className = 'task-meta';
      row.querySelector('.task-body')?.appendChild(m);
      return m;
    })();
    badge = document.createElement('span');
    badge.className = 'task-subtask-badge';
    meta.appendChild(badge);
  }
  if (badge) badge.textContent = `${done}/${total}`;
}

// ─── CONNECT PROMPT ───────────────────────────────────────────────────────────
function showConnectPrompt(el, config) {
  el.innerHTML = `
    ${headerHtml()}
    <div class="connect-prompt">
      <div class="connect-prompt-icon">✅</div>
      <div class="connect-prompt-title">Poveži Google Tasks</div>
      <div class="connect-prompt-desc">Prikaži i uređuj svoje Google zadatke s podsjetnicima.</div>
      <button class="btn-connect" id="tasks-connect-btn">Poveži</button>
    </div>`;
  el.querySelector('#tasks-connect-btn')?.addEventListener('click', () => {
    requestApiAccess(config, async () => { await renderTasks(config); });
  });
}

// ─── HTML HELPERS ─────────────────────────────────────────────────────────────
function headerHtml() {
  return `
    <div class="widget-header">
      <span class="widget-label widget-label-icon">
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
          <path d="M1 2.5h9M1 5.5h6M1 8.5h7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
          <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"/>
        </svg>
        TASKOVI
      </span>
    </div>`;
}

function skeletonHtml() {
  return `
    <div class="sk sk-line" style="width:90%"></div>
    <div class="sk sk-line" style="width:80%"></div>
    <div class="sk sk-line" style="width:85%"></div>
    <div class="sk sk-line" style="width:70%"></div>`;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
