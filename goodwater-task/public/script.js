// ── State ─────────────────────────────────────────────────────────────────────
let token        = localStorage.getItem('tm_token')    || null;
let currentUser  = localStorage.getItem('tm_username') || null;
let currentRole  = localStorage.getItem('tm_role')     || null;
let cachedTasks  = [];
let currentFilter = 'all';
let currentSearch = '';
let currentProject = '';
let expandedIds  = new Set();
let availableUsers = [];
const pendingDeletes = new Map();
let draggedTaskId = null;
let ignoreNextCardClick = false;
let dragPointerId = null;
let dragStartX = 0;
let dragStartY = 0;
let dragActive = false;
let dropTargetId = null;
let dropPlaceAfter = false;
let dragGhost = null;
let dragOffsetX = 0;
let dragOffsetY = 0;

function goodwaterConfirm(message, options = {}) {
  const previousFocus = document.activeElement;
  const destructive = options.destructive ?? /supprimer|vider|abandonner|refuser|déconnecter|irréversible|perdues/i.test(message);
  const overlay = document.createElement('div');
  overlay.className = 'goodwater-confirm-overlay';
  overlay.setAttribute('role', 'alertdialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `<div class="goodwater-confirm-panel"><div class="goodwater-confirm-icon" aria-hidden="true">?</div><h2>Confirmation Goodwater</h2><p></p><div class="goodwater-confirm-actions"><button type="button" class="secondary-btn" data-confirm-cancel>Annuler</button><button type="button" class="${destructive ? 'danger-btn' : 'primary-btn'}" data-confirm-accept>${options.confirmLabel || 'Confirmer'}</button></div></div>`;
  overlay.querySelector('p').textContent = message;
  document.body.appendChild(overlay);
  return new Promise(resolve => {
    let settled = false;
    const finish = accepted => { if (settled) return; settled = true; document.removeEventListener('keydown', onKeydown); overlay.remove(); previousFocus?.focus?.(); resolve(accepted); };
    const onKeydown = event => { if (event.key === 'Escape') finish(false); if (event.key === 'Enter') finish(true); };
    overlay.addEventListener('click', event => {
      if (event.target === overlay || event.target.closest('[data-confirm-cancel]')) finish(false);
      else if (event.target.closest('[data-confirm-accept]')) finish(true);
    });
    document.addEventListener('keydown', onKeydown);
    overlay.querySelector('[data-confirm-accept]').focus();
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function escapeHtml(t) {
  if (typeof t !== 'string') return '';
  return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
          .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

function normalizeText(t) {
  return t.normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase();
}

function prepareTask(task) {
  task.tags = Array.isArray(task.tags) ? task.tags : [];
  task.sharedWith = Array.isArray(task.sharedWith) ? task.sharedWith : [];
  task.dueAt = task.dueAt || task.due_at || null;
  task.assignedTo = task.assignedTo || task.assigned_to || '';
  task._normalizedTitle = normalizeText(task.title || '');
  return task;
}

const offlineDbPromise = 'indexedDB' in window ? new Promise((resolve, reject) => {
  const request = indexedDB.open('goodwater-task-offline', 1);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains('state')) database.createObjectStore('state', { keyPath: 'key' });
    if (!database.objectStoreNames.contains('queue')) database.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
}) : Promise.resolve(null);

async function offlineStore(mode, storeName, operation) {
  const database = await offlineDbPromise;
  if (!database) return null;
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = operation(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const cacheTasksOffline = tasks => offlineStore('readwrite', 'state', store => store.put({ key: 'tasks', value: tasks, savedAt: Date.now() }));
const readTasksOffline = async () => (await offlineStore('readonly', 'state', store => store.get('tasks')))?.value || [];
const queueOfflineRequest = request => offlineStore('readwrite', 'queue', store => store.add(request));

async function syncOfflineQueue() {
  if (!navigator.onLine || !currentUser) return;
  const queued = await offlineStore('readonly', 'queue', store => store.getAll()) || [];
  let synced = 0;
  for (const item of queued) {
    try {
      const response = await fetch(item.url, {
        method: item.method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: item.body
      });
      if (!response.ok) break;
      await offlineStore('readwrite', 'queue', store => store.delete(item.id));
      synced += 1;
    } catch { break; }
  }
  if (synced) {
    showToast(`${synced} modification${synced > 1 ? 's' : ''} synchronisée${synced > 1 ? 's' : ''}`);
    await loadTasks();
  }
}

async function apiCall(url, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) };
  let res;
  try { res = await fetch(url, { ...opts, headers }); }
  catch {
    const method = opts.method || 'GET';
    if (url === '/api/tasks' && method === 'GET') {
      const cached = await readTasksOffline();
      if (cached.length) {
        showToast('Mode hors connexion · données locales');
        return cached;
      }
    }
    if (url.startsWith('/api/tasks') && method !== 'GET') {
      await queueOfflineRequest({ url, method, body: opts.body || null, createdAt: Date.now() });
      showToast('Modification enregistrée hors ligne');
      const payload = opts.body ? JSON.parse(opts.body) : {};
      if (url === '/api/tasks' && method === 'POST') {
        return { ...payload, id: -Date.now(), user_id: currentUser, completed: 0, position: -Date.now(), canManage: true, sharedWith: [], subtasks: [] };
      }
      if (/\/subtasks$/.test(url) && method === 'POST') return { ...payload, id: -Date.now(), task_id: Number(url.split('/')[3]), completed: 0 };
      return { offline: true, message: 'En attente de synchronisation' };
    }
    throw new Error('Erreur de connexion');
  }
  let data;
  try { data = await res.json(); } catch { throw new Error('Erreur serveur'); }
  if (!res.ok) {
    const err = new Error(data.error || 'Erreur');
    err.status = res.status;
    if (res.status === 401) logout();
    throw err;
  }
  return data;
}

// ── Theme ─────────────────────────────────────────────────────────────────────
function loadTheme() {
  if (localStorage.getItem('tm_theme') === 'dark') document.documentElement.classList.add('dark');
}

function toggleTheme() {
  const dark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('tm_theme', dark ? 'dark' : 'light');
  document.getElementById('theme-toggle').textContent = dark ? '☀️' : '🌙';
}

// ── Auth ──────────────────────────────────────────────────────────────────────
async function login(username, password) {
  const data = await apiCall('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) });
  token = data.token;
  currentUser = data.username;
  currentRole = data.role;
  localStorage.setItem('tm_token', token);
  localStorage.setItem('tm_username', currentUser);
  localStorage.setItem('tm_role', data.role);
  showMainApp();
}

function logout() {
  const logoutHeaders = token ? { Authorization: `Bearer ${token}` } : {};
  fetch('/api/logout', { method: 'POST', headers: logoutHeaders }).catch(() => {});
  token = null; currentUser = null; currentRole = null; cachedTasks = []; expandedIds.clear();
  localStorage.removeItem('tm_token');
  localStorage.removeItem('tm_username');
  localStorage.removeItem('tm_role');
  document.getElementById('settings-modal').classList.add('hidden');
  showPage('login-page');
}

async function validateSession() {
  try {
    const data = await apiCall('/api/validate-token', { method: 'POST' });
    currentUser = data.username;
    currentRole = data.role;
    localStorage.setItem('tm_username', currentUser);
    localStorage.setItem('tm_role', data.role);
    showMainApp();
  } catch {
    if (!navigator.onLine && currentUser) return showMainApp();
    showPage('login-page');
  }
}

function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}

function showMainApp() {
  document.getElementById('current-user').textContent = currentUser;
  document.getElementById('workspace-user').textContent = currentUser || 'vous';
  const dark = localStorage.getItem('tm_theme') === 'dark';
  document.getElementById('theme-toggle').textContent = dark ? '☀️' : '🌙';

  const overlay = document.getElementById('logo-upload-overlay');
  const area    = document.getElementById('logo-upload-area');
  if (overlay && currentRole === 'admin') {
    overlay.classList.remove('hidden');
    area.classList.add('admin-logo');
  }

  showPage('main-page');
  Promise.all([loadUsers(), loadTasks()]).catch(() => {});
}

async function loadUsers() {
  try {
    availableUsers = await apiCall('/api/users');
    const select = document.getElementById('new-task-assignee');
    select.innerHTML = '<option value="">Moi-même</option>' + availableUsers.map(user =>
      `<option value="${escapeHtml(user.username)}">${escapeHtml(user.firstName || user.username)}</option>`
    ).join('');
    if (cachedTasks.length) filterAndRender();
  } catch { availableUsers = []; }
}

async function openSettingsModal() {
  const roleLabels = { viewer: 'Lecteur', user: 'Éditeur', admin: 'Admin' };
  document.getElementById('settings-avatar').textContent = (currentUser || '?')[0].toUpperCase();
  document.getElementById('settings-username-display').value = currentUser || '';
  document.getElementById('settings-role-display').textContent = roleLabels[currentRole] || currentRole;
  document.getElementById('profile-message').textContent = '';
  document.getElementById('change-password-form').reset();
  document.getElementById('password-change-error').classList.add('hidden');
  document.getElementById('password-change-success').classList.add('hidden');
  document.getElementById('settings-modal').classList.remove('hidden');
  document.getElementById('settings-modal').setAttribute('aria-hidden', 'false');
  loadBiometricCredentials();

  try {
    const profile = await apiCall('/api/profile');
    document.getElementById('profile-first-name').value = profile.firstName || '';
    document.getElementById('profile-last-name').value = profile.lastName || '';
    document.getElementById('profile-description').value = profile.description || '';
    document.getElementById('settings-avatar').textContent = (profile.firstName || profile.username || '?')[0].toUpperCase();
  } catch (err) {
    document.getElementById('profile-message').textContent = err.message;
    document.getElementById('profile-message').classList.add('message-error');
  }
}

function closeSettingsModal() {
  document.getElementById('settings-modal').classList.add('hidden');
  document.getElementById('settings-modal').setAttribute('aria-hidden', 'true');
}

// ── Logo ──────────────────────────────────────────────────────────────────────
async function updateFavicon() {
  try {
    const res = await fetch('/api/logo', { method: 'HEAD' });
    const href = res.ok ? '/api/logo?' + Date.now() : '/logo.png';
    document.querySelectorAll("link[rel='icon'], link[rel='apple-touch-icon']").forEach(l => { l.href = href; });
  } catch { /* keep existing favicon */ }
}

function initLogoDisplay() {
  document.querySelectorAll('.app-logo-img').forEach(img => {
    const svgId = img.id.replace('-img', '-svg');
    img.style.display = 'none';
    img.addEventListener('load', function() {
      this.style.display = 'block';
      const svg = document.getElementById(svgId);
      if (svg) svg.style.display = 'none';
    });
    img.addEventListener('error', function() {
      this.style.display = 'none';
      const svg = document.getElementById(svgId);
      if (svg) svg.style.display = '';
    });
    img.src = '/api/logo?' + Date.now();
  });
  updateFavicon();
}

function refreshLogos() {
  const ts = Date.now();
  document.querySelectorAll('.app-logo-img').forEach(img => {
    img.src = '/api/logo?' + ts;
  });
  updateFavicon();
}

async function uploadLogo(file) {
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      await apiCall('/api/logo', { method: 'POST', body: JSON.stringify({ image: e.target.result }) });
      refreshLogos();
    } catch (err) { alert('Erreur upload logo : ' + err.message); }
  };
  reader.readAsDataURL(file);
}

// ── Tasks ─────────────────────────────────────────────────────────────────────
async function loadTasks() {
  try {
    cachedTasks = (await apiCall('/api/tasks')).map(prepareTask);
    if (navigator.onLine) cacheTasksOffline(cachedTasks).catch(() => {});
    refreshProjectFilter();
    filterAndRender();
  } catch (err) {
    document.getElementById('tasks-list').innerHTML =
      `<p style="color:var(--muted-foreground);padding:1rem 0">${escapeHtml(err.message)}</p>`;
  }
}

function refreshProjectFilter() {
  const select = document.getElementById('project-filter');
  const selected = currentProject;
  const projects = [...new Set(cachedTasks.map(task => task.project).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr'));
  select.innerHTML = '<option value="">Tous les projets</option>' + projects.map(project =>
    `<option value="${escapeHtml(project)}">${escapeHtml(project)}</option>`
  ).join('');
  select.value = projects.includes(selected) ? selected : '';
  currentProject = select.value;
}

function filterAndRender() {
  let tasks = cachedTasks;

  const total = cachedTasks.length;
  const done = cachedTasks.filter(task => task.completed).length;
  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-active').textContent = total - done;
  document.getElementById('stat-done').textContent = done;

  if (currentFilter === 'active') tasks = tasks.filter(t => !t.completed);
  if (currentFilter === 'done')   tasks = tasks.filter(t =>  t.completed);

  if (currentSearch) {
    const q = normalizeText(currentSearch);
    tasks = tasks.filter(t => t._normalizedTitle.includes(q));
  }
  if (currentProject) tasks = tasks.filter(task => task.project === currentProject);

  const visibleLabel = `${tasks.length} tâche${tasks.length > 1 ? 's' : ''}`;
  document.getElementById('visible-task-count').textContent = visibleLabel;
  renderTasks(tasks);
}

function setTaskFilter(filter) {
  currentFilter = filter;
  document.querySelectorAll('.overview-card').forEach(card => {
    const selected = card.dataset.filter === filter;
    card.classList.toggle('active', selected);
    card.setAttribute('aria-pressed', selected ? 'true' : 'false');
  });
  filterAndRender();
}

function renderTasks(tasks) {
  const container = document.getElementById('tasks-list');
  container.innerHTML = '';

  if (!tasks.length) {
    const labels = { all: 'Aucune tâche pour le moment', active: 'Aucune tâche en cours', done: 'Aucune tâche terminée' };
    container.innerHTML = `
      <div class="empty-state">
        <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
          <rect x="8" y="8" width="48" height="48" rx="12" stroke="currentColor" stroke-width="2"/>
          <path d="M20 32h24M20 22h24M20 42h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
        <strong>${labels[currentFilter] || 'Aucune tâche'}</strong>
        <p>${currentSearch ? 'Essayez un autre terme de recherche.' : currentFilter === 'all' ? 'Créez votre première tâche !' : ''}</p>
      </div>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const task of tasks) fragment.appendChild(buildTaskCard(task));
  container.appendChild(fragment);
}

function formatDueDate(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function toLocalDateTimeValue(value) {
  if (!value) return '';
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function taskBadges(task) {
  const badges = [];
  if (task.priority === 'high') badges.push('<span class="task-badge priority-high">Priorité haute</span>');
  if (task.project) badges.push(`<span class="task-badge project-badge">${escapeHtml(task.project)}</span>`);
  if (task.dueAt) {
    const overdue = !task.completed && new Date(task.dueAt).getTime() < Date.now();
    badges.push(`<span class="task-badge due-badge${overdue ? ' overdue' : ''}">${overdue ? 'En retard · ' : ''}${escapeHtml(formatDueDate(task.dueAt))}</span>`);
  }
  if (task.recurrence && task.recurrence !== 'none') badges.push('<span class="task-badge">↻ Récurrente</span>');
  if (task.assignedTo) badges.push(`<span class="task-badge assigned-badge">Pour ${escapeHtml(task.assignedTo)}</span>`);
  if (!task.canManage) badges.push(`<span class="task-badge shared-badge">Partagée par ${escapeHtml(task.user_id)}</span>`);
  return badges.length ? `<div class="task-badges">${badges.join('')}</div>` : '';
}

function buildTaskCard(task) {
  const div = document.createElement('div');
  div.className = `task-card${task.completed ? ' task-done' : ''}`;
  div.dataset.id = task.id;

  const doneCount  = task.subtasks.filter(s => s.completed).length;
  const totalCount = task.subtasks.length;
  const isExpanded = expandedIds.has(task.id);
  const descPreview = task.description
    ? `<div class="task-desc-hint">${escapeHtml(task.description.substring(0, 80))}${task.description.length > 80 ? '…' : ''}</div>`
    : '';

  div.innerHTML = `
    <div class="task-header">
      ${task.canManage ? '<span class="task-drag-handle" title="Glisser pour déplacer" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></span>' : '<span class="task-shared-spacer"></span>'}
      <button class="task-check ${task.completed ? 'done' : ''}" data-id="${task.id}" title="${task.completed ? 'Marquer en cours' : 'Marquer terminée'}"></button>
      <div class="task-meta">
        <span class="task-title">${escapeHtml(task.title)}</span>
        ${!isExpanded ? descPreview : ''}
        ${taskBadges(task)}
      </div>
      ${totalCount > 0 ? `<span class="subtask-progress ${doneCount === totalCount ? 'all-done' : ''}">${doneCount}/${totalCount}</span>` : ''}
      <button class="task-expand-btn ${isExpanded ? 'expanded' : ''}" data-id="${task.id}" title="${isExpanded ? 'Réduire' : 'Développer'}">▾</button>
      ${task.canManage ? `<button class="task-delete-btn" data-id="${task.id}" title="Supprimer">✕</button>` : ''}
    </div>
    ${isExpanded ? buildTaskBody(task) : ''}
  `;

  return div;
}

function buildTaskBody(task) {
  const subtasksHtml = task.subtasks.length
    ? `<div class="subtasks-section">
        <h4>Sous-tâches</h4>
        <ul class="subtasks-list">
          ${task.subtasks.map(s => `
            <li class="subtask-item${s.completed ? ' subtask-done' : ''}">
              <button class="subtask-check ${s.completed ? 'done' : ''}" data-tid="${task.id}" data-sid="${s.id}"></button>
              <span class="subtask-title">${escapeHtml(s.title)}</span>
              <button class="subtask-delete-btn" data-tid="${task.id}" data-sid="${s.id}" title="Supprimer">✕</button>
            </li>`).join('')}
        </ul>
      </div>` : '';

  const desc = task.description || '';
  const descHtml = `
    <div class="task-description${desc ? '' : ' empty'}" data-id="${task.id}">
      ${desc ? escapeHtml(desc).replace(/\n/g, '<br>') : 'Cliquez pour ajouter une description…'}
    </div>`;

  const userOptions = '<option value="">Non attribuée</option>' + availableUsers.map(user =>
    `<option value="${escapeHtml(user.username)}" ${task.assignedTo === user.username ? 'selected' : ''}>${escapeHtml(user.firstName || user.username)}</option>`
  ).join('');
  const shareOptions = availableUsers.map(user => `
    <label class="share-user-option">
      <input type="checkbox" value="${escapeHtml(user.username)}" ${task.sharedWith.includes(user.username) ? 'checked' : ''}>
      <span>${escapeHtml(user.firstName || user.username)}</span>
    </label>`).join('');
  const propertiesHtml = task.canManage ? `
    <section class="task-properties" data-id="${task.id}">
      <h4>Organisation</h4>
      <div class="task-properties-grid">
        <label>Échéance<input class="task-property-due" type="datetime-local" value="${toLocalDateTimeValue(task.dueAt)}"></label>
        <label>Priorité<select class="task-property-priority"><option value="low" ${task.priority === 'low' ? 'selected' : ''}>Basse</option><option value="normal" ${task.priority === 'normal' ? 'selected' : ''}>Normale</option><option value="high" ${task.priority === 'high' ? 'selected' : ''}>Haute</option></select></label>
        <label>Récurrence<select class="task-property-recurrence"><option value="none">Aucune</option><option value="daily" ${task.recurrence === 'daily' ? 'selected' : ''}>Chaque jour</option><option value="weekly" ${task.recurrence === 'weekly' ? 'selected' : ''}>Chaque semaine</option><option value="monthly" ${task.recurrence === 'monthly' ? 'selected' : ''}>Chaque mois</option></select></label>
        <label>Projet<input class="task-property-project" maxlength="60" value="${escapeHtml(task.project || '')}"></label>
        <label>Étiquettes<input class="task-property-tags" value="${escapeHtml(task.tags.join(', '))}" placeholder="urgent, maison"></label>
        <label>Attribuer à<select class="task-property-assignee">${userOptions}</select></label>
      </div>
      <div class="task-share-box"><strong>Partager avec</strong><div class="share-user-list">${shareOptions || '<span>Aucun autre utilisateur</span>'}</div></div>
      <button class="primary-btn task-properties-save" data-id="${task.id}" type="button">Enregistrer l’organisation</button>
    </section>` : '';

  return `
    <div class="task-body">
      ${descHtml}
      ${propertiesHtml}
      ${subtasksHtml}
      <div class="add-subtask-row">
        <input type="text" class="add-subtask-input" data-tid="${task.id}" placeholder="Ajouter une sous-tâche… (Entrée pour valider)">
        <button class="add-subtask-btn" data-tid="${task.id}" title="Ajouter">+</button>
      </div>
    </div>`;
}

// ── Actions ───────────────────────────────────────────────────────────────────
async function toggleTask(id) {
  const task = cachedTasks.find(t => t.id === id);
  if (!task) return;
  try {
    const result = await apiCall(`/api/tasks/${id}`, { method: 'PUT', body: JSON.stringify({ completed: !task.completed }) });
    task.completed = !task.completed;
    if (result.nextTask) return loadTasks();
    filterAndRender();
  } catch (err) { alert(err.message); }
}

function showToast(message, actionLabel = '', action = null, duration = 5000) {
  const region = document.getElementById('toast-region');
  const toast = document.createElement('div');
  toast.className = 'app-toast';
  toast.innerHTML = `<span>${escapeHtml(message)}</span>${actionLabel ? `<button type="button">${escapeHtml(actionLabel)}</button>` : ''}`;
  region.appendChild(toast);
  const dismiss = () => { toast.classList.add('leaving'); setTimeout(() => toast.remove(), 180); };
  const timer = setTimeout(dismiss, duration);
  toast.querySelector('button')?.addEventListener('click', () => {
    clearTimeout(timer);
    dismiss();
    action?.();
  });
  return dismiss;
}

function deleteTask(id) {
  if (pendingDeletes.has(id)) return;
  const index = cachedTasks.findIndex(task => task.id === id);
  if (index < 0) return;
  const [task] = cachedTasks.splice(index, 1);
  expandedIds.delete(id);
  filterAndRender();

  const undo = () => {
    const pending = pendingDeletes.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingDeletes.delete(id);
    cachedTasks.splice(Math.min(index, cachedTasks.length), 0, task);
    filterAndRender();
  };
  const timer = setTimeout(async () => {
    pendingDeletes.delete(id);
    try { await apiCall(`/api/tasks/${id}`, { method: 'DELETE' }); }
    catch (err) {
      cachedTasks.splice(Math.min(index, cachedTasks.length), 0, task);
      filterAndRender();
      showToast(err.message);
    }
  }, 5200);
  pendingDeletes.set(id, { timer, task });
  showToast('Tâche supprimée', 'Annuler', undo, 5000);
}

async function reorderTask(draggedId, targetId, placeAfter) {
  if (draggedId === targetId) return;
  const previousOrder = [...cachedTasks];
  const fromIndex = cachedTasks.findIndex(task => task.id === draggedId);
  if (fromIndex < 0) return;

  const [movedTask] = cachedTasks.splice(fromIndex, 1);
  let targetIndex = cachedTasks.findIndex(task => task.id === targetId);
  if (targetIndex < 0) {
    cachedTasks.splice(fromIndex, 0, movedTask);
    return;
  }
  if (placeAfter) targetIndex += 1;
  cachedTasks.splice(targetIndex, 0, movedTask);
  filterAndRender();

  try {
    await apiCall('/api/tasks/reorder', {
      method: 'PUT',
      body: JSON.stringify({ ids: cachedTasks.filter(task => task.canManage).map(task => task.id) })
    });
  } catch (err) {
    cachedTasks = previousOrder;
    filterAndRender();
    alert(err.message);
  }
}

async function toggleSubtask(tid, sid) {
  const task = cachedTasks.find(t => t.id === tid);
  const sub  = task?.subtasks.find(s => s.id === sid);
  if (!sub) return;
  try {
    await apiCall(`/api/tasks/${tid}/subtasks/${sid}`, { method: 'PUT', body: JSON.stringify({ completed: !sub.completed }) });
    sub.completed = !sub.completed;
    filterAndRender();
  } catch (err) { alert(err.message); }
}

async function deleteSubtask(tid, sid) {
  try {
    await apiCall(`/api/tasks/${tid}/subtasks/${sid}`, { method: 'DELETE' });
    const task = cachedTasks.find(t => t.id === tid);
    if (task) task.subtasks = task.subtasks.filter(s => s.id !== sid);
    filterAndRender();
  } catch (err) { alert(err.message); }
}

async function addSubtask(tid, title) {
  const input = document.querySelector(`.add-subtask-input[data-tid="${tid}"]`);
  try {
    const sub = await apiCall(`/api/tasks/${tid}/subtasks`, { method: 'POST', body: JSON.stringify({ title }) });
    const task = cachedTasks.find(t => t.id === tid);
    if (task) task.subtasks.push(sub);
    if (input) input.value = '';
    filterAndRender();
    // Restore focus to the input after re-render
    setTimeout(() => {
      const newInput = document.querySelector(`.add-subtask-input[data-tid="${tid}"]`);
      if (newInput) newInput.focus();
    }, 0);
  } catch (err) { alert(err.message); }
}

// Description inline editing
function startEditDescription(taskId) {
  const task = cachedTasks.find(t => t.id === taskId);
  if (!task) return;
  const descDiv = document.querySelector(`.task-description[data-id="${taskId}"]`);
  if (!descDiv || descDiv.classList.contains('editing')) return;

  descDiv.classList.add('editing');
  descDiv.innerHTML = `
    <textarea class="desc-edit-textarea" rows="3" placeholder="Description…">${escapeHtml(task.description || '')}</textarea>
    <div class="desc-edit-actions">
      <button class="primary-btn desc-save-btn" data-id="${taskId}" style="font-size:0.8rem;padding:0.4rem 0.9rem">Sauvegarder</button>
      <button class="ghost-btn desc-cancel-btn" data-id="${taskId}" style="font-size:0.8rem;padding:0.4rem 0.9rem">Annuler</button>
    </div>`;
  descDiv.querySelector('textarea').focus();
}

async function saveDescription(taskId, desc) {
  try {
    await apiCall(`/api/tasks/${taskId}`, { method: 'PUT', body: JSON.stringify({ description: desc }) });
    const task = cachedTasks.find(t => t.id === taskId);
    if (task) task.description = desc;
    filterAndRender();
  } catch (err) { alert(err.message); }
}

async function saveTaskProperties(taskId, section) {
  const selectedShares = [...section.querySelectorAll('.share-user-option input:checked')].map(input => input.value);
  const dueValue = section.querySelector('.task-property-due').value;
  const payload = {
    dueAt: dueValue ? new Date(dueValue).toISOString() : '',
    priority: section.querySelector('.task-property-priority').value,
    recurrence: section.querySelector('.task-property-recurrence').value,
    project: section.querySelector('.task-property-project').value,
    tags: section.querySelector('.task-property-tags').value,
    assignedTo: section.querySelector('.task-property-assignee').value
  };
  const button = section.querySelector('.task-properties-save');
  button.disabled = true;
  try {
    await apiCall(`/api/tasks/${taskId}`, { method: 'PUT', body: JSON.stringify(payload) });
    await apiCall(`/api/tasks/${taskId}/share`, { method: 'PUT', body: JSON.stringify({ usernames: selectedShares }) });
    showToast('Organisation enregistrée');
    await loadTasks();
  } catch (err) { showToast(err.message); }
  finally { button.disabled = false; }
}

// New task form
function showNewTaskForm() {
  document.getElementById('new-task-form').classList.remove('hidden');
  document.getElementById('new-task-title').focus();
  document.getElementById('add-task-btn').classList.add('hidden');
}

function hideNewTaskForm() {
  document.getElementById('new-task-form').classList.add('hidden');
  document.getElementById('new-task-title').value = '';
  document.getElementById('new-task-desc').value = '';
  document.getElementById('new-task-due').value = '';
  document.getElementById('new-task-priority').value = 'normal';
  document.getElementById('new-task-recurrence').value = 'none';
  document.getElementById('new-task-project').value = '';
  document.getElementById('new-task-tags').value = '';
  document.getElementById('new-task-assignee').value = '';
  document.getElementById('add-task-btn').classList.remove('hidden');
}

async function saveNewTask() {
  const title = document.getElementById('new-task-title').value.trim();
  const description = document.getElementById('new-task-desc').value.trim();
  const dueValue = document.getElementById('new-task-due').value;
  if (!title) { document.getElementById('new-task-title').focus(); return; }

  const btn = document.getElementById('save-task-btn');
  btn.disabled = true;
  try {
    const task = await apiCall('/api/tasks', { method: 'POST', body: JSON.stringify({
      title, description,
      dueAt: dueValue ? new Date(dueValue).toISOString() : '',
      priority: document.getElementById('new-task-priority').value,
      recurrence: document.getElementById('new-task-recurrence').value,
      project: document.getElementById('new-task-project').value,
      tags: document.getElementById('new-task-tags').value,
      assignedTo: document.getElementById('new-task-assignee').value
    }) });
    cachedTasks.unshift(prepareTask(task));
    refreshProjectFilter();
    hideNewTaskForm();
    filterAndRender();
  } catch (err) { alert(err.message); }
  finally { btn.disabled = false; }
}

async function registerPasskey() {
  if (!window.SimpleWebAuthnBrowser) return showToast('La connexion par biométrie n’est pas disponible sur ce navigateur.');
  const button = document.getElementById('register-passkey-btn');
  button.disabled = true;
  try {
    const optionsJSON = await apiCall('/api/passkeys/register/options', { method: 'POST', body: '{}' });
    const response = await window.SimpleWebAuthnBrowser.startRegistration({ optionsJSON });
    await apiCall('/api/passkeys/register/verify', { method: 'POST', body: JSON.stringify(response) });
    showToast('Connexion par biométrie activée sur votre compte Goodwater');
    await loadBiometricCredentials();
  } catch (error) { showToast(error.message || 'Activation de la connexion par biométrie annulée'); }
  finally { button.disabled = false; }
}

async function loadBiometricCredentials() {
  const list = document.getElementById('biometric-list');
  list.innerHTML = '<p class="biometric-empty">Chargement…</p>';
  try {
    const credentials = await apiCall('/api/passkeys');
    if (!credentials.length) {
      list.innerHTML = '<p class="biometric-empty">Aucune connexion biométrique activée.</p>';
      return;
    }
    list.innerHTML = credentials.map(credential => {
      const date = credential.createdAt
        ? new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(`${credential.createdAt.replace(' ', 'T')}Z`))
        : '';
      const deviceLabel = credential.deviceLabel || 'Appareil non identifié';
      const browserName = credential.browserName || 'Sera identifié à la prochaine connexion biométrique';
      const isMobile = /iPhone|iPad|Android/i.test(deviceLabel);
      return `<div class="biometric-item">
        <div class="biometric-device-icon" aria-hidden="true">${isMobile ? '▯' : '▰'}</div>
        <div class="biometric-device-info">
          <div class="biometric-device-title"><strong>${escapeHtml(deviceLabel)}</strong>${credential.backedUp ? '<span class="biometric-badge">Synchronisée</span>' : ''}</div>
          <span>${escapeHtml(browserName)}</span>
          <small>${date ? `Ajoutée le ${escapeHtml(date)}` : 'Date d’ajout inconnue'}</small>
        </div>
        <button class="biometric-delete-btn" type="button" data-biometric-id="${credential.id}" aria-label="Supprimer la connexion biométrique de ${escapeHtml(deviceLabel)}">Supprimer</button>
      </div>`;
    }).join('');
  } catch (error) {
    list.innerHTML = `<p class="biometric-empty message-error">${escapeHtml(error.message)}</p>`;
  }
}

async function deleteBiometricCredential(id, button) {
  if (!await goodwaterConfirm('Supprimer cette connexion biométrique ? Vous pourrez toujours vous connecter avec votre mot de passe.')) return;
  button.disabled = true;
  try {
    await apiCall(`/api/passkeys/${id}`, { method: 'DELETE' });
    showToast('Connexion biométrique supprimée');
    await loadBiometricCredentials();
  } catch (error) {
    showToast(error.message || 'Suppression impossible');
    button.disabled = false;
  }
}

async function loginWithPasskey() {
  const username = document.getElementById('login-username').value.trim();
  const errorElement = document.getElementById('login-error');
  if (!username) {
    errorElement.textContent = "Saisissez d’abord votre nom d’utilisateur.";
    errorElement.classList.remove('hidden');
    return;
  }
  const button = document.getElementById('passkey-login-btn');
  button.disabled = true;
  errorElement.classList.add('hidden');
  try {
    const optionsJSON = await apiCall('/api/passkeys/login/options', { method: 'POST', body: JSON.stringify({ username }) });
    const response = await window.SimpleWebAuthnBrowser.startAuthentication({ optionsJSON });
    const data = await apiCall('/api/passkeys/login/verify', { method: 'POST', body: JSON.stringify({ username, response }) });
    token = data.token;
    currentUser = data.username;
    currentRole = data.role;
    localStorage.setItem('tm_token', token);
    localStorage.setItem('tm_username', currentUser);
    localStorage.setItem('tm_role', currentRole);
    showMainApp();
  } catch (error) {
    errorElement.textContent = error.message || 'Connexion par biométrie annulée';
    errorElement.classList.remove('hidden');
  } finally { button.disabled = false; }
}

// ── Event delegation ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadTheme();
  initLogoDisplay();
  validateSession();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(registrations => {
      registrations.forEach(registration => registration.unregister());
    }).catch(() => {});
  }
  if ('caches' in window) {
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key.startsWith('goodwater-task-')).map(key => caches.delete(key))
    )).catch(() => {});
  }
  window.addEventListener('online', syncOfflineQueue);

  // Login
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;
    const errorEl  = document.getElementById('login-error');
    const btn      = e.target.querySelector('button[type="submit"]');
    errorEl.classList.add('hidden');
    btn.disabled = true; btn.textContent = 'Connexion…';
    try { await login(username, password); }
    catch (err) { errorEl.textContent = err.message; errorEl.classList.remove('hidden'); }
    finally { btn.disabled = false; btn.textContent = 'Se connecter'; }
  });

  document.getElementById('logout-btn').addEventListener('click', logout);
  document.getElementById('passkey-login-btn').addEventListener('click', loginWithPasskey);
  document.getElementById('settings-btn').addEventListener('click', openSettingsModal);
  document.getElementById('close-settings-modal').addEventListener('click', closeSettingsModal);
  document.getElementById('settings-modal').addEventListener('click', (e) => {
    if (e.target.id === 'settings-modal') closeSettingsModal();
  });

  document.getElementById('profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = document.getElementById('profile-message');
    const submitBtn = e.target.querySelector('button[type="submit"]');
    message.textContent = '';
    message.className = 'form-message';
    submitBtn.disabled = true;
    try {
      const profile = await apiCall('/api/profile', {
        method: 'PUT',
        body: JSON.stringify({
          firstName: document.getElementById('profile-first-name').value,
          lastName: document.getElementById('profile-last-name').value,
          description: document.getElementById('profile-description').value
        })
      });
      document.getElementById('settings-avatar').textContent = (profile.firstName || profile.username || '?')[0].toUpperCase();
      message.textContent = 'Profil enregistré sur tous les services.';
      message.classList.add('message-success');
    } catch (err) {
      message.textContent = err.message;
      message.classList.add('message-error');
    } finally {
      submitBtn.disabled = false;
    }
  });

  document.querySelectorAll('[data-password-toggle]').forEach(button => {
    button.addEventListener('click', () => {
      const input = document.getElementById(button.dataset.passwordToggle);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      button.textContent = show ? 'Masquer' : 'Afficher';
      button.setAttribute('aria-pressed', show ? 'true' : 'false');
    });
  });

  document.getElementById('change-password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl  = document.getElementById('password-change-error');
    const successEl = document.getElementById('password-change-success');
    const submitBtn = e.target.querySelector('button[type="submit"]');
    errorEl.classList.add('hidden');
    successEl.classList.add('hidden');
    submitBtn.disabled = true;

    const currentPassword  = document.getElementById('current-password').value;
    const newPassword      = document.getElementById('new-password-profile').value;
    const confirmPassword  = document.getElementById('confirm-password').value;

    try {
      await apiCall('/api/profile/password', {
        method: 'PUT',
        body: JSON.stringify({ currentPassword, newPassword, confirmPassword })
      });
      e.target.reset();
      successEl.classList.remove('hidden');
      const circle = successEl.querySelector('.pw-checkmark-circle');
      const check  = successEl.querySelector('.pw-checkmark-check');
      if (circle) { circle.style.animation = 'none'; void circle.offsetWidth; circle.style.animation = ''; }
      if (check)  { check.style.animation  = 'none'; void check.offsetWidth;  check.style.animation  = ''; }
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    } finally {
      submitBtn.disabled = false;
    }
  });

  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
  document.getElementById('register-passkey-btn').addEventListener('click', registerPasskey);
  document.getElementById('biometric-list').addEventListener('click', event => {
    const button = event.target.closest('[data-biometric-id]');
    if (button) deleteBiometricCredential(button.dataset.biometricId, button);
  });

  // Logo upload (admin uniquement)
  document.getElementById('logo-upload-area').addEventListener('click', () => {
    if (currentRole === 'admin') document.getElementById('logo-file-input').click();
  });
  document.getElementById('logo-file-input').addEventListener('change', (e) => {
    if (e.target.files[0]) uploadLogo(e.target.files[0]);
    e.target.value = '';
  });

  // Toolbar
  document.getElementById('add-task-btn').addEventListener('click', showNewTaskForm);
  document.getElementById('save-task-btn').addEventListener('click', saveNewTask);
  document.getElementById('cancel-task-btn').addEventListener('click', hideNewTaskForm);

  document.getElementById('new-task-title').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveNewTask(); }
    if (e.key === 'Escape') hideNewTaskForm();
  });

  let searchFrame = null;
  document.getElementById('task-search').addEventListener('input', (e) => {
    currentSearch = e.target.value.trim();
    if (searchFrame !== null) cancelAnimationFrame(searchFrame);
    searchFrame = requestAnimationFrame(() => {
      searchFrame = null;
      filterAndRender();
    });
  });

  document.getElementById('project-filter').addEventListener('change', (e) => {
    currentProject = e.target.value;
    filterAndRender();
  });

  document.querySelectorAll('.overview-card').forEach(card => {
    card.addEventListener('click', () => setTaskFilter(card.dataset.filter));
  });

  // Task list — delegation
  const tasksList = document.getElementById('tasks-list');
  let highlightedDropCard = null;
  let activeDraggedCard = null;

  const clearDragState = () => {
    dragGhost?.remove();
    dragGhost = null;
    draggedTaskId = null;
    dragPointerId = null;
    dragActive = false;
    dropTargetId = null;
    activeDraggedCard?.classList.remove('dragging');
    highlightedDropCard?.classList.remove('drag-over-before', 'drag-over-after');
    activeDraggedCard = null;
    highlightedDropCard = null;
    setTimeout(() => { ignoreNextCardClick = false; }, 100);
  };

  tasksList.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.task-drag-handle');
    if (!handle || e.button !== 0) return;
    const card = handle.closest('.task-card');
    const bounds = card.getBoundingClientRect();
    e.preventDefault();
    dragPointerId = e.pointerId;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    draggedTaskId = parseInt(card.dataset.id);
    dragOffsetX = e.clientX - bounds.left;
    dragOffsetY = e.clientY - bounds.top;
    dropTargetId = null;
    ignoreNextCardClick = true;
    handle.setPointerCapture(e.pointerId);
  });

  tasksList.addEventListener('pointermove', (e) => {
    if (e.pointerId !== dragPointerId || draggedTaskId === null) return;
    e.preventDefault();
    if (!dragActive && Math.hypot(e.clientX - dragStartX, e.clientY - dragStartY) < 5) return;
    if (!dragActive) {
      dragActive = true;
      const sourceCard = tasksList.querySelector(`.task-card[data-id="${draggedTaskId}"]`);
      activeDraggedCard = sourceCard;
      const bounds = sourceCard.getBoundingClientRect();
      dragGhost = sourceCard.cloneNode(true);
      dragGhost.classList.remove('dragging', 'drag-over-before', 'drag-over-after');
      dragGhost.classList.add('task-drag-ghost');
      dragGhost.removeAttribute('data-id');
      dragGhost.querySelector('.task-body')?.remove();
      dragGhost.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
      dragGhost.style.width = `${bounds.width}px`;
      document.body.appendChild(dragGhost);
    }

    if (dragGhost) {
      const maxLeft = Math.max(8, window.innerWidth - dragGhost.offsetWidth - 8);
      const left = Math.min(Math.max(8, e.clientX - dragOffsetX), maxLeft);
      const top = Math.min(Math.max(8, e.clientY - dragOffsetY), window.innerHeight - 56);
      dragGhost.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    }

    const draggedCard = activeDraggedCard;
    draggedCard?.classList.add('dragging');
    highlightedDropCard?.classList.remove('drag-over-before', 'drag-over-after');
    highlightedDropCard = null;

    const pointedCard = document.elementFromPoint(e.clientX, e.clientY)?.closest('.task-card');
    if (pointedCard && pointedCard !== draggedCard && tasksList.contains(pointedCard)) {
      const bounds = pointedCard.getBoundingClientRect();
      dropTargetId = parseInt(pointedCard.dataset.id);
      dropPlaceAfter = e.clientY > bounds.top + bounds.height / 2;
      pointedCard.classList.add(dropPlaceAfter ? 'drag-over-after' : 'drag-over-before');
      highlightedDropCard = pointedCard;
    }

    const edge = 72;
    if (e.clientY < edge) window.scrollBy({ top: -12, behavior: 'auto' });
    else if (e.clientY > window.innerHeight - edge) window.scrollBy({ top: 12, behavior: 'auto' });
  });

  tasksList.addEventListener('pointerup', async (e) => {
    if (e.pointerId !== dragPointerId) return;
    const sourceId = draggedTaskId;
    const targetId = dropTargetId;
    const placeAfter = dropPlaceAfter;
    const shouldReorder = dragActive && sourceId !== null && targetId !== null;
    clearDragState();
    if (shouldReorder) await reorderTask(sourceId, targetId, placeAfter);
  });

  tasksList.addEventListener('pointercancel', () => {
    clearDragState();
  });

  tasksList.addEventListener('click', async (e) => {
    // Task check
    const checkBtn = e.target.closest('.task-check');
    if (checkBtn) { toggleTask(parseInt(checkBtn.dataset.id)); return; }

    // Task delete
    const delBtn = e.target.closest('.task-delete-btn');
    if (delBtn) { deleteTask(parseInt(delBtn.dataset.id)); return; }

    // Expand/collapse
    const expBtn = e.target.closest('.task-expand-btn');
    if (expBtn) {
      const id = parseInt(expBtn.dataset.id);
      expandedIds.has(id) ? expandedIds.delete(id) : expandedIds.add(id);
      filterAndRender();
      return;
    }

    if (e.target.closest('.task-drag-handle')) return;

    const propertiesSave = e.target.closest('.task-properties-save');
    if (propertiesSave) {
      const section = propertiesSave.closest('.task-properties');
      await saveTaskProperties(parseInt(propertiesSave.dataset.id), section);
      return;
    }

    // Un clic sur l'en-tête de la tâche ouvre ou referme son détail.
    const taskHeader = e.target.closest('.task-header');
    if (taskHeader && !ignoreNextCardClick) {
      const id = parseInt(taskHeader.closest('.task-card').dataset.id);
      expandedIds.has(id) ? expandedIds.delete(id) : expandedIds.add(id);
      filterAndRender();
      return;
    }

    // Description — save
    const saveDesc = e.target.closest('.desc-save-btn');
    if (saveDesc) {
      const id = parseInt(saveDesc.dataset.id);
      const textarea = saveDesc.closest('.task-description').querySelector('textarea');
      await saveDescription(id, textarea.value.trim());
      return;
    }

    // Description — cancel
    const cancelDesc = e.target.closest('.desc-cancel-btn');
    if (cancelDesc) { filterAndRender(); return; }

    // Description — start edit
    const descDiv = e.target.closest('.task-description');
    if (descDiv && !descDiv.classList.contains('editing')) {
      startEditDescription(parseInt(descDiv.dataset.id));
      return;
    }

    // Subtask check
    const sCheck = e.target.closest('.subtask-check');
    if (sCheck) { toggleSubtask(parseInt(sCheck.dataset.tid), parseInt(sCheck.dataset.sid)); return; }

    // Subtask delete
    const sDel = e.target.closest('.subtask-delete-btn');
    if (sDel) { deleteSubtask(parseInt(sDel.dataset.tid), parseInt(sDel.dataset.sid)); return; }

    // Add subtask button
    const addBtn = e.target.closest('.add-subtask-btn');
    if (addBtn) {
      const tid = parseInt(addBtn.dataset.tid);
      const input = document.querySelector(`.add-subtask-input[data-tid="${tid}"]`);
      if (input?.value.trim()) addSubtask(tid, input.value.trim());
      return;
    }
  });

  // Add subtask via Enter
  tasksList.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList.contains('add-subtask-input')) {
      e.preventDefault();
      const tid = parseInt(e.target.dataset.tid);
      if (e.target.value.trim()) addSubtask(tid, e.target.value.trim());
    }
    if (e.key === 'Escape' && e.target.classList.contains('add-subtask-input')) {
      e.target.value = '';
      e.target.blur();
    }
  });
});
