import { getAccessToken, fetchTaskLists, fetchTasks, updateTask } from '../api/google-api.js';
import { requestApiAccess } from '../auth.js';

let _listId    = '@default';
let _tasks     = [];
let _appConfig = null;

export async function renderTasks(config) {
  _appConfig = config;
  const el = document.getElementById('widget-tasks');
  if (!el) return;
  el.classList.remove('loading');

  const token = getAccessToken();
  if (!token) {
    showConnectPrompt(el, config);
    return;
  }

  el.innerHTML = headerHtml() + skeletonHtml();

  try {
    // Try to get first task list id
    try {
      const lists = await fetchTaskLists(token);
      if (lists.items?.length) _listId = lists.items[0].id;
    } catch { /* keep @default */ }

    const data = await fetchTasks(token, _listId);
    _tasks = (data.items ?? []).filter(t => t.status !== 'completed');
    renderTaskList(el, _tasks);
  } catch (err) {
    console.error('Tasks fetch failed:', err);
    if (err.message?.includes('401')) {
      showConnectPrompt(el, config);
    } else {
      el.innerHTML = headerHtml() + `<div class="error-state">⚠ Greška pri dohvaćanju taskova.</div>`;
    }
  }
}

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

  const now   = new Date();
  const today = new Date(now); today.setHours(0, 0, 0, 0);

  // Sort: overdue first, then by due date ascending, undated last
  const sorted = [...tasks].sort((a, b) => {
    if (a.due && !b.due) return -1;
    if (!a.due && b.due) return  1;
    if (a.due && b.due)  return new Date(a.due) - new Date(b.due);
    return 0;
  });

  const itemsHtml = sorted.map(task => {
    // Notes snippet — max 150 chars
    const notes = task.notes
      ? task.notes.replace(/\s+/g, ' ').trim().slice(0, 150) + (task.notes.length > 150 ? '…' : '')
      : null;

    let dueHtml = '';
    if (task.due) {
      const dueDate = new Date(task.due);
      // Google Tasks always returns midnight UTC; convert to local
      const dueMidnight = new Date(dueDate);
      dueMidnight.setHours(0, 0, 0, 0);
      const diff = Math.round((dueMidnight - today) / 86400000);

      let cls   = '';
      let label = '';
      if      (diff < 0)  { cls = 'overdue'; label = `Zakašnjelo ${Math.abs(diff)}d`; }
      else if (diff === 0) { cls = 'today';   label = 'Danas'; }
      else if (diff === 1) { label = 'Sutra'; }
      else if (diff <= 6)  { label = dueMidnight.toLocaleDateString('hr-HR', { weekday:'short', day:'numeric', month:'numeric' }); }
      else                 { label = dueMidnight.toLocaleDateString('hr-HR', { day:'numeric', month:'short' }); }

      // Show time if not midnight (some integrations populate it)
      const h = dueDate.getHours(), m = dueDate.getMinutes();
      const timeStr = (h || m) ? ` ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}` : '';

      dueHtml = `
        <div class="task-meta">
          <span class="task-due${cls ? ' ' + cls : ''}">
            <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
              <rect x="0.5" y="1" width="8" height="7" rx="1" stroke="currentColor" stroke-width="0.9"/>
              <path d="M0.5 3.5h8M2.5 0.5v1.5M6.5 0.5v1.5" stroke="currentColor" stroke-width="0.9" stroke-linecap="round"/>
            </svg>
            ${label}${timeStr}
          </span>
        </div>`;
    }

    return `
      <div class="task-item" data-task-id="${escHtml(task.id)}" data-list-id="${escHtml(_listId)}">
        <input type="checkbox" class="task-check" aria-label="Završi zadatak">
        <div class="task-body">
          <div class="task-title">${escHtml(task.title || '(bez naslova)')}</div>
          ${notes ? `<div class="task-notes">${escHtml(notes)}</div>` : ''}
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

function attachTaskHandlers(el, tasks) {
  // Click task row → open modal
  el.querySelectorAll('.task-item').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.classList.contains('task-check')) return;
      const taskId = row.dataset.taskId;
      const task   = tasks.find(t => t.id === taskId);
      if (task) openTaskModal(task);
    });
  });

  // Checkbox → complete task
  el.querySelectorAll('.task-check').forEach(chk => {
    chk.addEventListener('change', async (e) => {
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

function openTaskModal(task) {
  const modal   = document.getElementById('task-modal');
  const overlay = document.getElementById('task-modal-overlay');
  if (!modal) return;

  // Fill fields
  const titleEl = document.getElementById('task-edit-title');
  const dateEl  = document.getElementById('task-edit-date');
  const timeEl  = document.getElementById('task-edit-time');
  const notesEl = document.getElementById('task-edit-notes');

  if (titleEl) titleEl.value = task.title || '';
  if (notesEl) notesEl.value = task.notes || '';

  if (task.due) {
    const d = new Date(task.due);
    if (dateEl) dateEl.value = d.toISOString().slice(0, 10);
  } else {
    if (dateEl) dateEl.value = '';
  }
  if (timeEl) timeEl.value = '';

  modal.classList.remove('hidden');
  overlay.classList.remove('hidden');
  titleEl?.focus();

  // Save handler
  const saveBtn   = document.getElementById('task-modal-save');
  const cancelBtn = document.getElementById('task-modal-cancel');
  const closeBtn  = document.getElementById('task-modal-close');

  const cleanup = () => {
    modal.classList.add('hidden');
    overlay.classList.add('hidden');
    saveBtn?.removeEventListener('click', onSave);
    cancelBtn?.removeEventListener('click', cleanup);
    closeBtn?.removeEventListener('click', cleanup);
    overlay?.removeEventListener('click', cleanup);
  };

  const onSave = async () => {
    const updates = { title: titleEl?.value?.trim() || task.title };
    if (notesEl?.value) updates.notes = notesEl.value;

    if (dateEl?.value) {
      const dueDate = new Date(dateEl.value + 'T00:00:00Z');
      updates.due = dueDate.toISOString();
    }

    const token = getAccessToken();
    if (!token) { cleanup(); return; }

    try {
      await updateTask(token, _listId, task.id, updates);
      cleanup();
      // Refresh widget
      const el = document.getElementById('widget-tasks');
      if (el) renderTasks(_appConfig);
    } catch (err) {
      console.error('Task save failed:', err);
      import('../app.js').then(m => m.showToast('Greška pri spremanju.', 'error'));
    }
  };

  saveBtn?.addEventListener('click', onSave);
  cancelBtn?.addEventListener('click', cleanup);
  closeBtn?.addEventListener('click', cleanup);
  overlay?.addEventListener('click', cleanup);
}

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
    requestApiAccess(config, async () => {
      await renderTasks(config);
    });
  });
}

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
