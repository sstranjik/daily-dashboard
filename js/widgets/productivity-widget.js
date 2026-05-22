import { escapeHtml } from '../utils/helpers.js';

const STORAGE_KEY = 'dashboard_todos';

let todos = [];

export function renderProductivity() {
  const el = document.getElementById('widget-productivity');
  if (!el) return;

  todos = loadTodos();
  el.classList.remove('loading');
  renderWidget(el);
}

function renderWidget(el) {
  const pending = todos.filter(t => !t.done).length;

  el.innerHTML = `
    <div class="widget-header">
      <span class="widget-label">
        ✓ ZADACI
        ${pending > 0 ? `<span class="tag tag-blue" style="margin-left:4px">${pending}</span>` : ''}
      </span>
    </div>

    <div class="todo-input-row">
      <input
        type="text"
        class="todo-input"
        id="todo-new-input"
        placeholder="Novi zadatak…"
        maxlength="200"
        autocomplete="off"
      />
      <button class="todo-add-btn" id="todo-add-btn">+</button>
    </div>

    <div class="todo-list" id="todo-list">
      ${renderTodoItems(todos)}
    </div>

    <div class="todo-footer">
      <span>${todos.length === 0 ? 'Nema zadataka' : `${pending} preostalo`}</span>
      ${todos.some(t => t.done) ? `<button class="todo-clear-done" id="todo-clear-done">Očisti završene</button>` : ''}
    </div>`;

  attachTodoHandlers(el);
}

function renderTodoItems(items) {
  if (!items.length) {
    return `<div style="padding:8px 0;font-size:12px;color:var(--text-muted);text-align:center">Nema zadataka. Dodaj prvi! ✓</div>`;
  }
  return items.map(t => `
    <div class="todo-item${t.done ? ' done' : ''}" data-id="${t.id}">
      <input type="checkbox" class="todo-check" ${t.done ? 'checked' : ''} data-id="${t.id}" aria-label="Označi završenim">
      <span class="todo-text">${escapeHtml(t.text)}</span>
      <button class="todo-delete" data-id="${t.id}" aria-label="Obriši zadatak">✕</button>
    </div>`).join('');
}

function attachTodoHandlers(el) {
  const input  = el.querySelector('#todo-new-input');
  const addBtn = el.querySelector('#todo-add-btn');
  const list   = el.querySelector('#todo-list');

  const addTodo = () => {
    const text = input?.value.trim();
    if (!text) return;
    todos.push({ id: Date.now().toString(), text, done: false, created: new Date().toISOString() });
    saveTodos();
    input.value = '';
    list.innerHTML = renderTodoItems(todos);
    updateFooter(el);
    attachItemHandlers(el);
  };

  addBtn?.addEventListener('click', addTodo);
  input?.addEventListener('keydown', e => { if (e.key === 'Enter') addTodo(); });

  el.querySelector('#todo-clear-done')?.addEventListener('click', () => {
    todos = todos.filter(t => !t.done);
    saveTodos();
    list.innerHTML = renderTodoItems(todos);
    updateFooter(el);
    attachItemHandlers(el);
  });

  attachItemHandlers(el);
}

function attachItemHandlers(el) {
  el.querySelectorAll('.todo-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const t = todos.find(t => t.id === cb.dataset.id);
      if (t) t.done = cb.checked;
      saveTodos();
      const item = el.querySelector(`.todo-item[data-id="${cb.dataset.id}"]`);
      if (item) item.classList.toggle('done', cb.checked);
      updateFooter(el);
    });
  });

  el.querySelectorAll('.todo-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      todos = todos.filter(t => t.id !== btn.dataset.id);
      saveTodos();
      el.querySelector(`.todo-item[data-id="${btn.dataset.id}"]`)?.remove();
      updateFooter(el);
    });
  });
}

function updateFooter(el) {
  const pending = todos.filter(t => !t.done).length;
  const label   = el.querySelector('.widget-header .widget-label');
  if (label) {
    const badge = pending > 0 ? `<span class="tag tag-blue" style="margin-left:4px">${pending}</span>` : '';
    label.innerHTML = `✓ ZADACI ${badge}`;
  }
  const footer = el.querySelector('.todo-footer');
  if (footer) {
    footer.innerHTML = `
      <span>${todos.length === 0 ? 'Nema zadataka' : `${pending} preostalo`}</span>
      ${todos.some(t => t.done) ? `<button class="todo-clear-done" id="todo-clear-done">Očisti završene</button>` : ''}`;
    footer.querySelector('#todo-clear-done')?.addEventListener('click', () => {
      todos = todos.filter(t => !t.done);
      saveTodos();
      const list = el.querySelector('#todo-list');
      if (list) list.innerHTML = renderTodoItems(todos);
      updateFooter(el);
      attachItemHandlers(el);
    });
  }
}

function loadTodos() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
  catch { return []; }
}

function saveTodos() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
}
