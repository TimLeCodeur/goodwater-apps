// State
let token = localStorage.getItem('token') || null;
let currentUser = localStorage.getItem('username') || null;
let isAdmin = localStorage.getItem('role') === 'admin';

function goodwaterConfirm(message, options = {}) {
  const previousFocus = document.activeElement;
  const destructive = options.destructive ?? /supprimer|vider|abandonner|refuser|déconnecter|irréversible|perdues/i.test(message);
  const overlay = document.createElement('div');
  overlay.className = 'goodwater-confirm-overlay';
  overlay.setAttribute('role', 'alertdialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `<div class="goodwater-confirm-panel"><div class="goodwater-confirm-icon" aria-hidden="true">?</div><h2>Confirmation Goodwater</h2><p></p><div class="goodwater-confirm-actions"><button type="button" class="btn-secondary" data-confirm-cancel>Annuler</button><button type="button" class="${destructive ? 'btn-danger' : 'btn-primary'}" data-confirm-accept>${options.confirmLabel || 'Confirmer'}</button></div></div>`;
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

// Workout state
let workoutStartTime = null;
let workoutTimerInterval = null;
let activeExercises = [];
let totalKg = 0;
let totalSets = 0;
let previousWorkoutsData = null;
let workoutTemplates = [];
let selectedTemplateExercises = new Set();
let selectedLibraryExercises = new Set();
let dashboardWorkouts = [];
let calendarDate = new Date();
let calendarActivities = [];
let calendarView = 'month';
let calendarWheelLocked = false;
let calendarTransitionDirection = 0;
let calendarWindowStart = null;
let currentDetailWorkoutId = null;
let allRecords = [];
let workoutDeleteConfirmationResolve = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

async function apiCall(endpoint, options = {}) {
  const baseUrl = window.location.origin;
  const headers = {
    'Content-Type': 'application/json',
    ...(token && { Authorization: `Bearer ${token}` })
  };

  const response = await fetch(baseUrl + endpoint, { ...options, headers });

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('Erreur serveur');
  }

  if (!response.ok) {
    if (response.status === 401) logout();
    const error = new Error(data.error || 'Erreur');
    throw error;
  }
  return data;
}

function showPage(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
  document.getElementById(pageId)?.classList.remove('hidden');
}

function showMainApp() {
  showPage('main-page');
  document.getElementById('current-user').textContent = currentUser || '';
  document.getElementById('workspace-user').textContent = currentUser || 'vous';
  renderSecretBadges();
  loadDashboard();
}

function toggleMobileNav() {
  document.getElementById('main-page').classList.toggle('mobile-nav-open');
}

function switchNav(navId) {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelector(`.tab-btn[data-nav="${navId}"]`)?.classList.add('active');
  
  document.querySelectorAll('.content').forEach(c => c.classList.add('hidden'));
  document.getElementById(navId)?.classList.remove('hidden');

  if (navId === 'dashboard') loadDashboard();
  if (navId === 'history') loadHistory();
  if (navId === 'exercises') loadExercises();
  if (navId === 'records') loadRecords();
  if (navId === 'workout') loadWorkoutExercises();
  if (navId === 'programs') loadWorkoutTemplates();
}

async function loadWorkoutExercises() {
  try {
    allExercises = await apiCall('/api/exercises');
  } catch (err) {
    console.warn('Impossible de charger les exercices:', err.message);
  }
}

function emptyState(title, description) {
  return `<div class="empty-state"><div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(description)}</span></div></div>`;
}

function showToast(message) {
  const region = document.getElementById('toast-region');
  if (!region) return;
  const toast = document.createElement('div');
  toast.className = 'app-toast';
  toast.textContent = message;
  region.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

function renderSecretBadges() {
  const container = document.getElementById('easter-egg-badges');
  if (!container) return;
  const nightUnlocked = localStorage.getItem(`goodwater-night-creature:${currentUser || 'guest'}`) === '1';
  container.innerHTML = nightUnlocked ? '<span class="secret-badge" title="Séance terminée entre minuit et 5 h">☾ Créature de la nuit</span>' : '';
}

function unlockNightCreature() {
  const hour = new Date().getHours();
  if (hour >= 5) return false;
  const key = `goodwater-night-creature:${currentUser || 'guest'}`;
  const isNew = localStorage.getItem(key) !== '1';
  localStorage.setItem(key, '1');
  renderSecretBadges();
  return isNew;
}

function normalizeSecretName(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase('fr');
}

async function ensureChallengeExercise(name, muscleGroup, matcher) {
  const existing = allExercises.find(exercise => matcher(normalizeSecretName(exercise.name)));
  if (existing) return existing;
  const created = await apiCall('/api/exercises', { method:'POST', body:JSON.stringify({ name, muscle_group:muscleGroup, equipment:'Poids du corps' }) });
  allExercises.push(created);
  return created;
}

async function prepareOnePunchChallenge() {
  try {
    if (!allExercises.length) await loadWorkoutExercises();
    const exercises = await Promise.all([
      ensureChallengeExercise('Pompes', 'Pectoraux', name => name === 'pompes' || name === 'push-up'),
      ensureChallengeExercise('Squats', 'Quadriceps', name => name === 'squats' || name === 'squat'),
      ensureChallengeExercise('Abdos', 'Abdominaux', name => name === 'abdos')
    ]);
    exercises.forEach(exercise => addExerciseToActiveWorkout({ ...exercise, setsData:[{ reps:100, weight:0 }] }));
    showToast('Défi One Punch Man : 100 pompes, 100 squats et 100 abdos !');
  } catch (error) {
    showToast(`Défi One Punch Man indisponible : ${error.message}`);
  }
}

// Auth
async function login(username, password) {
  const data = await apiCall('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  });

  token = data.token;
  currentUser = data.username;
  isAdmin = data.role === 'admin';

  localStorage.setItem('token', token);
  localStorage.setItem('username', currentUser);
  localStorage.setItem('role', data.role);

  showMainApp();
}

async function register(username, password) {
  await apiCall('/api/register', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  });
  document.getElementById('register-form').reset();
}

async function logout() {
  try {
    await fetch('/api/logout', {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
  } catch {}
  token = null;
  currentUser = null;
  isAdmin = false;
  localStorage.removeItem('token');
  localStorage.removeItem('username');
  localStorage.removeItem('role');
  closeSettings();
  document.querySelectorAll('.modal').forEach(modal => modal.classList.add('hidden'));
  showPage('login-page');
}

async function restoreSharedSession() {
  try {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const response = await fetch('/api/session', { headers });
    if (!response.ok) return false;
    const session = await response.json();
    currentUser = session.username;
    isAdmin = session.role === 'admin';
    localStorage.setItem('username', currentUser);
    localStorage.setItem('role', session.role);
    return true;
  } catch {
    return false;
  }
}

// Theme
function loadTheme() {
  if (localStorage.getItem('theme') === 'dark') {
    document.documentElement.classList.add('dark');
  }
}

function toggleTheme() {
  document.documentElement.classList.toggle('dark');
  localStorage.setItem('theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light');
  updateThemeControls();
}

function updateThemeControls() {
  const dark = document.documentElement.classList.contains('dark');
  const headerButton = document.getElementById('theme-btn');
  if (headerButton) headerButton.textContent = dark ? '☀' : '☾';
  const value = document.getElementById('settings-theme-value');
  if (value) value.textContent = dark ? 'Activé' : 'Désactivé';
}

async function openSettings() {
  const modal = document.getElementById('settings-modal');
  const name = currentUser || 'Utilisateur';
  document.getElementById('settings-username').value = name;
  document.getElementById('settings-avatar').textContent = name.slice(0, 1).toUpperCase();
  document.getElementById('settings-role').textContent = isAdmin ? 'Administrateur' : 'Utilisateur';
  document.getElementById('profile-message').textContent = '';
  document.getElementById('password-change-message').textContent = '';
  document.getElementById('change-password-form').reset();
  updateThemeControls();
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  loadBiometricCredentials();
  try {
    const profile = await apiCall('/api/profile');
    document.getElementById('profile-first-name').value = profile.firstName || '';
    document.getElementById('profile-last-name').value = profile.lastName || '';
    document.getElementById('profile-description').value = profile.description || '';
    document.getElementById('settings-avatar').textContent = (profile.firstName || profile.username || '?').slice(0, 1).toUpperCase();
  } catch (error) {
    document.getElementById('profile-message').textContent = error.message;
    document.getElementById('profile-message').className = 'form-message message-error';
  }
}

async function registerPasskey() {
  if (!window.SimpleWebAuthnBrowser) return showToast('La biométrie n’est pas disponible sur ce navigateur.');
  const button = document.getElementById('register-passkey-btn');
  button.disabled = true;
  try {
    const optionsJSON = await apiCall('/api/passkeys/register/options', { method:'POST', body:'{}' });
    const response = await window.SimpleWebAuthnBrowser.startRegistration({ optionsJSON });
    await apiCall('/api/passkeys/register/verify', { method:'POST', body:JSON.stringify(response) });
    showToast('Connexion biométrique activée');
    loadBiometricCredentials();
  } catch (error) { showToast(error.message || 'Activation biométrique annulée'); }
  finally { button.disabled = false; }
}

async function loadBiometricCredentials() {
  const list = document.getElementById('biometric-list');
  if (!list) return;
  list.innerHTML = '<p class="biometric-empty">Chargement…</p>';
  try {
    const credentials = await apiCall('/api/passkeys');
    if (!credentials.length) { list.innerHTML = '<p class="biometric-empty">Aucune connexion biométrique activée.</p>'; return; }
    list.innerHTML = credentials.map(credential => {
      const date = credential.createdAt ? new Intl.DateTimeFormat('fr-FR', { dateStyle:'medium', timeStyle:'short' }).format(new Date(`${credential.createdAt.replace(' ', 'T')}Z`)) : '';
      const device = credential.deviceLabel || 'Appareil non identifié';
      const mobile = /iPhone|iPad|Android/i.test(device);
      return `<div class="biometric-item"><div class="biometric-device-icon" aria-hidden="true">${mobile ? '▯' : '▰'}</div><div class="biometric-device-info"><div class="biometric-device-title"><strong>${escapeHtml(device)}</strong>${credential.backedUp ? '<span class="biometric-badge">Synchronisée</span>' : ''}</div><span>${escapeHtml(credential.browserName || 'Navigateur non identifié')}</span><small>${date ? `Ajoutée le ${escapeHtml(date)}` : ''}</small></div><button class="biometric-delete-btn" data-biometric-id="${Number(credential.id)}" type="button">Supprimer</button></div>`;
    }).join('');
  } catch (error) { list.innerHTML = `<p class="biometric-empty message-error">${escapeHtml(error.message)}</p>`; }
}

async function loginWithPasskey() {
  const username = document.getElementById('login-username').value.trim();
  const errorElement = document.getElementById('login-error');
  if (!username) { errorElement.textContent = 'Saisissez d’abord votre nom d’utilisateur.'; return; }
  if (!window.SimpleWebAuthnBrowser) { errorElement.textContent = 'La biométrie n’est pas disponible sur ce navigateur.'; return; }
  const button = document.getElementById('passkey-login-btn');
  button.disabled = true;
  errorElement.textContent = '';
  try {
    const optionsJSON = await apiCall('/api/passkeys/login/options', { method:'POST', body:JSON.stringify({ username }) });
    const response = await window.SimpleWebAuthnBrowser.startAuthentication({ optionsJSON });
    const data = await apiCall('/api/passkeys/login/verify', { method:'POST', body:JSON.stringify({ username, response }) });
    token = data.token; currentUser = data.username; isAdmin = data.role === 'admin';
    localStorage.setItem('token', token); localStorage.setItem('username', currentUser); localStorage.setItem('role', data.role);
    showMainApp();
  } catch (error) { errorElement.textContent = error.message || 'Connexion biométrique annulée'; }
  finally { button.disabled = false; }
}

function closeSettings() {
  const modal = document.getElementById('settings-modal');
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}

// Dashboard
async function loadDashboard() {
  try {
    const stats = await apiCall('/api/stats');
    document.getElementById('stat-workouts').textContent = stats.totalWorkouts || 0;
    document.getElementById('stat-duration').textContent = stats.totalDuration || 0;
    document.getElementById('stat-records').textContent = stats.totalRecords || 0;
  } catch {}

  try {
    const workouts = await apiCall('/api/workouts?limit=100');
    dashboardWorkouts = workouts;
    loadCalendarMonth();
    const container = document.getElementById('recent-workouts');
    container.innerHTML = workouts.slice(0, 5).map(w => `
      <div class="list-item recent-workout-item" data-workout-id="${Number(w.id)}">
        <div class="recent-workout-copy"><div class="list-item-title">${escapeHtml(w.name || 'Séance')} - ${new Date(w.date).toLocaleDateString('fr-FR')}</div>
        <div class="list-item-subtitle">${w.duration ? w.duration + ' min' : ''}</div></div>
        <button class="reuse-recent-workout" data-reuse-workout="${Number(w.id)}" type="button" aria-label="Refaire la séance ${escapeHtml(w.name || 'Séance')}">↻ <span>Refaire</span></button>
        <button class="delete-recent-workout" data-delete-workout="${Number(w.id)}" type="button" aria-label="Supprimer la séance ${escapeHtml(w.name || 'Séance')}" title="Supprimer"><span aria-hidden="true">×</span></button>
      </div>
    `).join('') || emptyState('Aucune séance pour le moment', 'Démarrez un entraînement pour suivre votre progression.');
  } catch {}
}

function closeWorkoutDeleteConfirmation(confirmed = false) {
  const modal = document.getElementById('delete-workout-modal');
  modal?.classList.add('hidden');
  if (workoutDeleteConfirmationResolve) {
    workoutDeleteConfirmationResolve(confirmed);
    workoutDeleteConfirmationResolve = null;
  }
}

function confirmWorkoutDeletion() {
  const modal = document.getElementById('delete-workout-modal');
  modal.classList.remove('hidden');
  document.getElementById('cancel-delete-workout')?.focus();
  return new Promise(resolve => { workoutDeleteConfirmationResolve = resolve; });
}

async function deleteCompletedWorkout(id, button) {
  if (!await confirmWorkoutDeletion()) return;
  if (button) button.disabled = true;
  try {
    await apiCall(`/api/workouts/${id}`, { method:'DELETE' });
    showToast('Séance supprimée');
    await loadDashboard();
  } catch (error) {
    showToast(error.message || 'Impossible de supprimer la séance');
    if (button) button.disabled = false;
  }
}

function localDateKey(value) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

async function loadCalendarMonth() {
  let url = `/api/workout-calendar?view=${calendarView}&year=${calendarDate.getFullYear()}&month=${calendarDate.getMonth() + 1}`;
  if (calendarView === 'week') {
    const start = startOfCalendarWeek(calendarDate);
    const end = new Date(start); end.setDate(end.getDate() + 6);
    url += `&start=${localDateKey(start)}&end=${localDateKey(end)}`;
  }
  if (calendarView === 'month') {
    if (!calendarWindowStart) calendarWindowStart = startOfCalendarWeek(new Date(calendarDate.getFullYear(), calendarDate.getMonth(), 1));
    const end = new Date(calendarWindowStart); end.setDate(end.getDate() + 41);
    url = `/api/workout-calendar?view=week&year=${calendarWindowStart.getFullYear()}&start=${localDateKey(calendarWindowStart)}&end=${localDateKey(end)}`;
  }
  try {
    calendarActivities = await apiCall(url);
  } catch { calendarActivities = []; }
  renderWorkoutCalendar();
}

function startOfCalendarWeek(value) {
  const date = new Date(value.getFullYear(), value.getMonth(), value.getDate());
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return date;
}

function calendarDayPoint(date, activity) {
  const key = localDateKey(date);
  const day = date.getDate();
  const today = key === localDateKey(new Date());
  return `<button type="button" class="calendar-day ${activity ? 'done' : 'rest'}${today ? ' today' : ''}"${activity ? ` data-calendar-day="${key}" aria-label="Voir les ${Number(activity.workout_count)} séance${Number(activity.workout_count) > 1 ? 's' : ''} du ${day}"` : ` aria-label="${day}, aucune séance"`}><span>${day}</span>${Number(activity?.workout_count) > 1 ? `<small>${Number(activity.workout_count)}</small>` : ''}</button>`;
}

function calendarAgendaDay(date, activity, outside = false) {
  const key = localDateKey(date);
  const today = key === localDateKey(new Date());
  const workouts = activity?.workouts || [];
  const startsMonth = date.getDate() === 1;
  const monthLabel = startsMonth ? new Intl.DateTimeFormat('fr-FR', { month:'short' }).format(date).replace('.', '') : '';
  return `<article class="calendar-agenda-day ${activity ? 'done' : 'rest'}${today ? ' today' : ''}${outside ? ' outside' : ''}${startsMonth ? ' month-start' : ''}"${startsMonth ? ` data-month-label="${escapeHtml(monthLabel)}"` : ''}${activity ? ` data-calendar-day="${key}"` : ''}>
    <span class="agenda-day-number">${date.getDate()}</span>
    <div class="agenda-events">${workouts.map(workout => `<button type="button" class="calendar-agenda-event" data-calendar-event="${Number(workout.id)}" title="${escapeHtml(workout.name)}"><i></i><span>${escapeHtml(workout.name)}</span>${Number(workout.duration) > 0 ? `<small>${Number(workout.duration)} min</small>` : ''}</button>`).join('')}</div>
  </article>`;
}

function animateCalendarTransition() {
  const calendar = document.getElementById('workout-calendar');
  calendar.classList.remove('calendar-enter-next', 'calendar-enter-previous');
  if (!calendarTransitionDirection) return;
  void calendar.offsetWidth;
  calendar.classList.add(calendarTransitionDirection > 0 ? 'calendar-enter-next' : 'calendar-enter-previous');
  window.setTimeout(() => calendar.classList.remove('calendar-enter-next', 'calendar-enter-previous'), 320);
  calendarTransitionDirection = 0;
}

function renderWorkoutCalendar() {
  const year = calendarDate.getFullYear();
  const month = calendarDate.getMonth();
  const workoutsByDay = new Map(calendarActivities.map(activity => [activity.day, activity]));
  const card = document.querySelector('.calendar-card');
  card?.classList.toggle('year-view', calendarView === 'year');
  card?.classList.toggle('month-view', calendarView === 'month');
  card?.classList.toggle('week-view', calendarView === 'week');
  const previousButton = document.getElementById('calendar-prev');
  const nextButton = document.getElementById('calendar-next');
  previousButton.textContent = calendarView === 'month' ? '↑' : '←';
  nextButton.textContent = calendarView === 'month' ? '↓' : '→';
  previousButton.setAttribute('aria-label', calendarView === 'month' ? 'Reculer dans le calendrier' : 'Période précédente');
  nextButton.setAttribute('aria-label', calendarView === 'month' ? 'Avancer dans le calendrier' : 'Période suivante');
  document.querySelectorAll('[data-calendar-view]').forEach(button => button.classList.toggle('active', button.dataset.calendarView === calendarView));
  if (calendarView === 'week') {
    const start = startOfCalendarWeek(calendarDate);
    const end = new Date(start); end.setDate(end.getDate() + 6);
    document.getElementById('calendar-month').textContent = `${start.toLocaleDateString('fr-FR', { day:'numeric', month:'short' })} – ${end.toLocaleDateString('fr-FR', { day:'numeric', month:'short', year:'numeric' })}`;
    document.getElementById('workout-calendar').innerHTML = Array.from({ length:7 }, (_, index) => { const date = new Date(start); date.setDate(date.getDate() + index); return calendarDayPoint(date, workoutsByDay.get(localDateKey(date))); }).join('');
    animateCalendarTransition();
    return;
  }
  if (calendarView === 'year') {
    document.getElementById('calendar-month').textContent = String(year);
    document.getElementById('workout-calendar').innerHTML = Array.from({ length:12 }, (_, currentMonth) => {
      const firstOffset = (new Date(year, currentMonth, 1).getDay() + 6) % 7;
      const days = new Date(year, currentMonth + 1, 0).getDate();
      const cells = Array.from({ length:firstOffset }, () => '<span class="calendar-day empty"></span>');
      for (let day = 1; day <= days; day++) { const date = new Date(year, currentMonth, day); cells.push(calendarDayPoint(date, workoutsByDay.get(localDateKey(date)))); }
      return `<section class="calendar-year-month"><h3>${new Intl.DateTimeFormat('fr-FR', { month:'long' }).format(new Date(year, currentMonth, 1))}</h3><div class="calendar-year-weekdays"><span>L</span><span>M</span><span>M</span><span>J</span><span>V</span><span>S</span><span>D</span></div><div class="calendar-year-days">${cells.join('')}</div></section>`;
    }).join('');
    animateCalendarTransition();
    return;
  }
  const windowStart = calendarWindowStart || startOfCalendarWeek(new Date(year, month, 1));
  const windowCenter = new Date(windowStart); windowCenter.setDate(windowCenter.getDate() + 20);
  document.getElementById('calendar-month').textContent = new Intl.DateTimeFormat('fr-FR', { month:'long', year:'numeric' }).format(windowCenter);
  const cells = [];
  for (let index = 0; index < 42; index++) {
    const date = new Date(windowStart); date.setDate(date.getDate() + index);
    cells.push(calendarAgendaDay(date, workoutsByDay.get(localDateKey(date)), date.getMonth() !== windowCenter.getMonth()));
  }
  document.getElementById('workout-calendar').innerHTML = cells.join('');
  animateCalendarTransition();
}

// History
async function loadHistory() {
  try {
    const workouts = await apiCall('/api/workouts');
    const container = document.getElementById('history-list');
    container.innerHTML = workouts.map(w => `
      <div class="list-item" data-workout-id="${Number(w.id)}">
        <div class="list-item-title">${escapeHtml(w.name || 'Séance')} - ${new Date(w.date).toLocaleDateString('fr-FR')}</div>
        <div class="list-item-subtitle">${w.duration ? w.duration + ' min' : ''}</div>
      </div>
    `).join('') || emptyState('Votre historique est vide', 'Vos séances terminées apparaîtront ici.');
  } catch {}
}

async function showWorkoutDetail(id) {
  try {
    const w = await apiCall(`/api/workouts/${id}`);
    currentDetailWorkoutId = Number(w.id);
    document.querySelector('.detail-stats')?.classList.remove('hidden');
    document.getElementById('reuse-workout-btn')?.classList.remove('hidden');

    // Calculate totals
    let totalKg = 0;
    let totalSets = 0;
    w.exercises?.forEach(ex => {
      ex.sets?.forEach(set => {
        totalKg += (set.weight || 0) * (set.reps || 0);
        totalSets++;
      });
    });

    // Update modal content
    document.getElementById('detail-workout-name').textContent = w.name || 'Séance';
    const hasRecordedSets = Boolean(w.exercises?.length && totalSets);
    document.getElementById('detail-duration').textContent = Number(w.duration) > 0 ? w.duration : '—';
    document.getElementById('detail-kg').textContent = hasRecordedSets ? totalKg : '—';
    document.getElementById('detail-sets').textContent = hasRecordedSets ? totalSets : '—';

    // Build exercises list
    const container = document.getElementById('detail-exercises');
    container.innerHTML = '';
    
    if (w.exercises && w.exercises.length > 0) {
      w.exercises.forEach(ex => {
        const html = `
          <div class="detail-exercise">
            <div class="detail-exercise-header">${ex.image_url ? `<button class="expandable-image" data-view-exercise="${Number(ex.exercise_id)}" data-exercise-caption="${escapeHtml(ex.name)}" type="button" aria-label="Voir le mouvement de ${escapeHtml(ex.name)}"><img src="${exerciseImageUrl(ex.image_url)}" alt=""></button>` : '<span class="detail-exercise-thumb exercise-thumb-placeholder">GW</span>'}<div><div class="detail-exercise-name">${escapeHtml(ex.name)}</div><small>${escapeHtml(ex.muscle_group || '')}${ex.equipment ? ` · ${escapeHtml(ex.equipment)}` : ''}</small></div></div>
            <div class="detail-sets">
              ${ex.sets.map((set, idx) => `
                <div class="detail-set"><span class="detail-set-num">${idx + 1}</span>
                  <span><b>${set.reps || 0}</b><small>répétitions</small></span>
                  <span><b>${set.weight || 0} kg</b><small>charge</small></span>
                </div>
              `).join('')}
            </div>
          </div>
        `;
        container.insertAdjacentHTML('beforeend', html);
      });
    } else {
      container.innerHTML = emptyState('Données indisponibles', 'Les séries de cette ancienne séance n’ont pas été enregistrées. Les nouvelles séances conserveront bien tous les mouvements.');
    }
    
    // Show modal
    document.getElementById('workout-detail-modal').classList.remove('hidden');
  } catch {}
}

async function showWorkoutsForDay(day) {
  let workouts = dashboardWorkouts.filter(workout => String(workout.date || '').slice(0, 10) === day);
  try { workouts = await apiCall(`/api/workouts?date=${encodeURIComponent(day)}&limit=100`); } catch {}
  currentDetailWorkoutId = null;
  document.getElementById('detail-workout-name').textContent = new Date(`${day}T12:00:00`).toLocaleDateString('fr-FR', { weekday:'long', day:'numeric', month:'long' });
  document.querySelector('.detail-stats')?.classList.add('hidden');
  document.getElementById('reuse-workout-btn')?.classList.add('hidden');
  document.getElementById('detail-exercises').innerHTML = workouts.map(workout => `
    <article class="day-workout-card">
      <button type="button" class="day-workout-main" data-workout-id="${Number(workout.id)}"><strong>${escapeHtml(workout.name || 'Séance')}</strong><small>${Number(workout.duration) > 0 ? `${Number(workout.duration)} min` : 'Durée non renseignée'} · Voir le détail</small></button>
      <button type="button" class="day-workout-reuse" data-reuse-workout="${Number(workout.id)}">↻ Refaire</button>
    </article>`).join('') || emptyState('Aucune séance', 'Aucune séance enregistrée pour cette journée.');
  document.getElementById('workout-detail-modal').classList.remove('hidden');
}

function moveCalendarPeriod(direction) {
  calendarTransitionDirection = direction;
  if (calendarView === 'week') calendarDate.setDate(calendarDate.getDate() + direction * 7);
  else if (calendarView === 'year') calendarDate.setFullYear(calendarDate.getFullYear() + direction);
  else {
    const center = calendarWindowStart ? new Date(calendarWindowStart) : new Date(calendarDate);
    center.setDate(center.getDate() + 20);
    center.setMonth(center.getMonth() + direction, 1);
    calendarDate = center;
    calendarWindowStart = startOfCalendarWeek(new Date(center.getFullYear(), center.getMonth(), 1));
  }
  calendarDate = new Date(calendarDate);
  loadCalendarMonth();
}

function moveCalendarWeek(direction) {
  if (!calendarWindowStart) calendarWindowStart = startOfCalendarWeek(new Date(calendarDate.getFullYear(), calendarDate.getMonth(), 1));
  calendarTransitionDirection = direction;
  calendarWindowStart = new Date(calendarWindowStart);
  calendarWindowStart.setDate(calendarWindowStart.getDate() + direction * 7);
  const center = new Date(calendarWindowStart); center.setDate(center.getDate() + 20);
  calendarDate = center;
  loadCalendarMonth();
}

async function reuseWorkout(id) {
  try {
    const workout = await apiCall(`/api/workouts/${id}`);
    closeWorkoutDetailModal();
    switchNav('workout');
    document.getElementById('workout-name').value = workout.name || 'Séance';
    startWorkout();
    (workout.exercises || []).forEach(exercise => addExerciseToActiveWorkout({
      id:exercise.exercise_id,
      name:exercise.name,
      image_url:exercise.image_url,
      setsData:exercise.sets || []
    }));
    showToast('Séance prête à être refaite');
  } catch (error) { showToast(error.message || 'Impossible de réutiliser cette séance'); }
}

function closeWorkoutDetailModal() {
  document.getElementById('workout-detail-modal').classList.add('hidden');
}

// Exercises
let allExercises = [];
let filteredExercises = [];
let exerciseRenderLimit = 48;
const DATASET_MEDIA_BASE = 'https://raw.githubusercontent.com/hasaneyldrm/exercises-dataset/main/';

function exerciseImageUrl(path) {
  if (!path) return '';
  return `/exercise-images/${encodeURIComponent(String(path).split('/').pop())}`;
}

async function loadExercises() {
  try {
    allExercises = await apiCall('/api/exercises');
    filteredExercises = allExercises;
    renderExerciseList(filteredExercises);
    document.getElementById('exercise-count').textContent = allExercises.length.toLocaleString('fr-FR');
    
    const muscles = await apiCall('/api/muscle-groups');
    const select = document.getElementById('muscle-filter');
    select.innerHTML = '<option value="">Tous les groupes musculaires</option>' + 
      muscles.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
    renderMuscleChips(muscles);
  } catch {}
}

function renderExerciseList(exercises) {
  const container = document.getElementById('exercise-list');
  document.getElementById('load-more-exercises')?.remove();
  const visible = exercises.slice(0, exerciseRenderLimit);
  container.innerHTML = visible.map(e => `
    <div class="card exercise-card${selectedLibraryExercises.has(Number(e.id)) ? ' selected' : ''}" data-exercise-detail="${Number(e.id)}" role="button" tabindex="0">
      ${e.image_url ? `<img class="exercise-thumb exercise-zoomable" data-view-exercise="${Number(e.id)}" data-exercise-caption="${escapeHtml(e.name)}" src="${exerciseImageUrl(e.image_url)}" alt="" loading="lazy">` : '<span class="exercise-thumb exercise-thumb-placeholder">GW</span>'}
      <span class="exercise-card-body"><span class="card-title">${escapeHtml(e.name)}</span><span class="exercise-meta"><span>${escapeHtml(e.muscle_group || 'Autre')}</span>${e.equipment ? `<span>${escapeHtml(e.equipment)}</span>` : ''}</span></span>
      <button class="exercise-select-toggle" data-select-library-exercise="${Number(e.id)}" type="button" aria-label="${selectedLibraryExercises.has(Number(e.id)) ? 'Retirer' : 'Sélectionner'} ${escapeHtml(e.name)}">✓</button>
    </div>
  `).join('') || emptyState('Aucun exercice trouvé', 'Essayez un autre muscle ou une recherche plus courte.');
  if (exercises.length > exerciseRenderLimit) {
    container.insertAdjacentHTML('afterend', `<button id="load-more-exercises" class="btn-secondary load-more" type="button">Afficher ${Math.min(48, exercises.length - exerciseRenderLimit)} exercices de plus</button>`);
  }
  document.querySelector('.results-summary')?.remove();
  container.insertAdjacentHTML('beforebegin', `<p class="results-summary">${exercises.length.toLocaleString('fr-FR')} exercice${exercises.length > 1 ? 's' : ''} trouvé${exercises.length > 1 ? 's' : ''}</p>`);
}

function updateLibrarySelectionBar() {
  const bar = document.getElementById('exercise-selection-bar');
  const count = selectedLibraryExercises.size;
  bar.classList.toggle('hidden', count === 0);
  document.getElementById('exercise-selection-count').textContent = `${count} exercice${count > 1 ? 's' : ''} sélectionné${count > 1 ? 's' : ''}`;
}

async function openAssignTemplateModal() {
  if (!selectedLibraryExercises.size) return;
  try { workoutTemplates = await apiCall('/api/workout-templates'); }
  catch (error) { return showToast(error.message); }
  document.getElementById('assign-template-list').innerHTML = workoutTemplates.map(template => `
    <button type="button" data-assign-template="${Number(template.id)}"><span><strong>${escapeHtml(template.name)}</strong><small>${template.exercise_count} exercice${template.exercise_count > 1 ? 's' : ''}</small></span><b>Ajouter →</b></button>
  `).join('') || '<p class="settings-help">Vous n’avez pas encore de séance enregistrée.</p>';
  document.getElementById('assign-new-template-name').value = '';
  document.getElementById('assign-template-modal').classList.remove('hidden');
}

function finishLibraryAssignment(message) {
  selectedLibraryExercises.clear();
  updateLibrarySelectionBar();
  renderExerciseList(filteredExercises);
  document.getElementById('assign-template-modal').classList.add('hidden');
  showToast(message);
}

async function assignSelectionToTemplate(templateId) {
  try {
    const result = await apiCall(`/api/workout-templates/${templateId}/exercises`, { method:'POST', body:JSON.stringify({ exercise_ids:[...selectedLibraryExercises] }) });
    finishLibraryAssignment(result.added ? `${result.added} exercice${result.added > 1 ? 's ajoutés' : ' ajouté'}` : result.message);
  } catch (error) { showToast(error.message); }
}

async function createTemplateFromLibrarySelection() {
  const name = document.getElementById('assign-new-template-name').value.trim();
  if (!name) return showToast('Donnez un nom à la nouvelle séance');
  try {
    await apiCall('/api/workout-templates', { method:'POST', body:JSON.stringify({ name, exercise_ids:[...selectedLibraryExercises] }) });
    finishLibraryAssignment('Nouvelle séance créée');
  } catch (error) { showToast(error.message); }
}

async function loadWorkoutTemplates() {
  const container = document.getElementById('template-list');
  container.innerHTML = emptyState('Chargement…', 'Récupération de vos séances préparées.');
  try {
    workoutTemplates = await apiCall('/api/workout-templates');
    container.innerHTML = workoutTemplates.map(template => `
      <article class="template-card">
        <div class="template-card-head"><div><span class="eyebrow">${template.exercise_count} exercice${template.exercise_count > 1 ? 's' : ''}</span><h2>${escapeHtml(template.name)}</h2></div><button class="template-delete" data-delete-template="${Number(template.id)}" type="button" aria-label="Supprimer">×</button></div>
        <div class="template-preview">${template.exercises.slice(0, 5).map(exercise => exercise.image_url ? `<img class="exercise-zoomable" data-view-exercise="${Number(exercise.id)}" data-exercise-caption="${escapeHtml(exercise.name)}" src="${exerciseImageUrl(exercise.image_url)}" alt="" title="Voir le mouvement de ${escapeHtml(exercise.name)}">` : '<span>GW</span>').join('')}${template.exercises.length > 5 ? `<b>+${template.exercises.length - 5}</b>` : ''}</div>
        <p>${template.exercises.slice(0, 3).map(exercise => escapeHtml(exercise.name)).join(' · ')}${template.exercises.length > 3 ? '…' : ''}</p>
        <div class="template-card-actions"><button class="btn-secondary" data-view-template="${Number(template.id)}" type="button">Voir la séance</button><button class="btn-primary template-start" data-start-template="${Number(template.id)}" type="button">Lancer <span>→</span></button></div>
      </article>`).join('') || emptyState('Aucune séance préparée', 'Créez votre première séance en choisissant les exercices que vous aimez.');
  } catch (error) { container.innerHTML = emptyState('Impossible de charger vos séances', error.message); }
}

function showWorkoutTemplateDetail(id) {
  const template = workoutTemplates.find(item => Number(item.id) === Number(id));
  if (!template) return;
  const content = document.getElementById('template-detail-content');
  content.innerHTML = `
    <div class="template-detail-header"><span class="eyebrow">Séance préparée</span><h2 id="template-detail-title">${escapeHtml(template.name)}</h2><p>${template.exercises.length} exercice${template.exercises.length > 1 ? 's' : ''}</p></div>
    <div class="template-detail-list">${template.exercises.map((exercise, index) => `
      <article data-template-config="${Number(exercise.id)}"><span class="template-detail-number">${index + 1}</span>${exercise.image_url ? `<img class="exercise-zoomable" data-view-exercise="${Number(exercise.id)}" data-exercise-caption="${escapeHtml(exercise.name)}" src="${exerciseImageUrl(exercise.image_url)}" alt="">` : '<span class="exercise-thumb-placeholder">GW</span>'}<div class="template-detail-info"><strong>${escapeHtml(exercise.name)}</strong><small>${escapeHtml(exercise.muscle_group || '')}${exercise.equipment ? ` · ${escapeHtml(exercise.equipment)}` : ''}</small><div class="template-config-fields"><label>Séries<input class="template-config-sets" type="number" min="1" max="20" value="${Number(exercise.sets) || 3}"></label><label>Répétitions<input class="template-config-reps" type="number" min="1" max="200" value="${Number(exercise.reps) || 10}"></label><label>Charge (kg)<input class="template-config-weight" type="number" min="0" max="2000" step="0.5" value="${Number(exercise.weight) || 0}"></label></div></div></article>
    `).join('')}</div>
    <div class="template-detail-actions"><button class="btn-secondary" data-save-template-config="${Number(template.id)}" type="button">Enregistrer les réglages</button><button class="btn-primary" data-start-template="${Number(template.id)}" type="button">Lancer cette séance <span>→</span></button></div>`;
  document.getElementById('template-detail-modal').classList.remove('hidden');
}

async function saveTemplateConfiguration(templateId) {
  const exercises = [...document.querySelectorAll('[data-template-config]')].map(row => ({
    id:Number(row.dataset.templateConfig), sets:row.querySelector('.template-config-sets').value,
    reps:row.querySelector('.template-config-reps').value, weight:row.querySelector('.template-config-weight').value
  }));
  try {
    await apiCall(`/api/workout-templates/${templateId}`, { method:'PUT', body:JSON.stringify({ exercises }) });
    showToast('Réglages de la séance enregistrés');
    await loadWorkoutTemplates();
    showWorkoutTemplateDetail(templateId);
  } catch (error) { showToast(error.message); }
}

async function openTemplateModal() {
  if (!allExercises.length) await loadWorkoutExercises();
  selectedTemplateExercises = new Set();
  document.getElementById('template-name').value = '';
  document.getElementById('template-exercise-search').value = '';
  document.getElementById('template-modal').classList.remove('hidden');
  renderTemplateExerciseChoices();
}

function renderTemplateExerciseChoices() {
  const query = document.getElementById('template-exercise-search').value.trim().toLocaleLowerCase('fr');
  const matches = allExercises.filter(exercise => !query || `${exercise.name} ${exercise.muscle_group} ${exercise.equipment}`.toLocaleLowerCase('fr').includes(query)).slice(0, 120);
  document.getElementById('template-exercise-list').innerHTML = matches.map(exercise => `
    <button class="template-exercise-choice${selectedTemplateExercises.has(Number(exercise.id)) ? ' selected' : ''}" data-template-exercise="${Number(exercise.id)}" type="button">
      ${exercise.image_url ? `<img class="exercise-zoomable" data-view-exercise="${Number(exercise.id)}" data-exercise-caption="${escapeHtml(exercise.name)}" src="${exerciseImageUrl(exercise.image_url)}" alt="" loading="lazy">` : '<span class="exercise-thumb-placeholder">GW</span>'}
      <span><strong>${escapeHtml(exercise.name)}</strong><small>${escapeHtml(exercise.muscle_group || '')}${exercise.equipment ? ` · ${escapeHtml(exercise.equipment)}` : ''}</small></span><b>✓</b>
    </button>`).join('') || emptyState('Aucun exercice trouvé', 'Essayez une autre recherche.');
  const count = selectedTemplateExercises.size;
  document.getElementById('template-selection-count').textContent = `${count} exercice${count > 1 ? 's' : ''} sélectionné${count > 1 ? 's' : ''}`;
}

async function saveWorkoutTemplate() {
  const name = document.getElementById('template-name').value.trim();
  if (!name) return showToast('Donnez un nom à votre séance');
  if (!selectedTemplateExercises.size) return showToast('Sélectionnez au moins un exercice');
  try {
    await apiCall('/api/workout-templates', { method: 'POST', body: JSON.stringify({ name, exercise_ids: [...selectedTemplateExercises] }) });
    document.getElementById('template-modal').classList.add('hidden');
    showToast('Séance préparée enregistrée');
    loadWorkoutTemplates();
  } catch (error) { showToast(error.message); }
}

function launchWorkoutTemplate(id) {
  const template = workoutTemplates.find(item => Number(item.id) === Number(id));
  if (!template) return;
  switchNav('workout');
  document.getElementById('workout-name').value = template.name;
  startWorkout();
  template.exercises.forEach(exercise => addExerciseToActiveWorkout(exercise));
  showToast(`${template.name} est prête`);
}

function renderMuscleChips(muscles) {
  const active = document.getElementById('muscle-filter')?.value || '';
  document.getElementById('muscle-chips').innerHTML = ['', ...muscles].map(muscle =>
    `<button type="button" class="muscle-chip${muscle === active ? ' active' : ''}" data-muscle="${escapeHtml(muscle)}">${escapeHtml(muscle || 'Tout le corps')}</button>`
  ).join('');
}

function applyExerciseFilters() {
  const query = document.getElementById('exercise-search')?.value.trim().toLocaleLowerCase('fr') || '';
  const muscle = document.getElementById('muscle-filter')?.value || '';
  exerciseRenderLimit = 48;
  filteredExercises = allExercises.filter(exercise =>
    (!query || `${exercise.name} ${exercise.equipment || ''} ${exercise.target || ''}`.toLocaleLowerCase('fr').includes(query)) &&
    (!muscle || exercise.muscle_group === muscle)
  );
  renderExerciseList(filteredExercises);
  document.querySelectorAll('.muscle-chip').forEach(chip => chip.classList.toggle('active', chip.dataset.muscle === muscle));
}

async function showExerciseDetail(id) {
  const modal = document.getElementById('exercise-detail-modal');
  const content = document.getElementById('exercise-detail-content');
  modal.classList.remove('hidden');
  content.innerHTML = '<div class="empty-state"><div><strong>Chargement du mouvement…</strong></div></div>';
  try {
    const exercise = await apiCall(`/api/exercises/${id}`);
    const steps = exercise.instructions ? exercise.instructions.split(/(?<=[.!?])\s+/).filter(Boolean) : [];
    const media = exercise.gif_url || exercise.image_url;
    content.innerHTML = `
      <div class="exercise-detail-hero">
        ${media ? `<img class="exercise-detail-media" data-expand-image="${exercise.gif_url ? DATASET_MEDIA_BASE + escapeHtml(exercise.gif_url) : exerciseImageUrl(exercise.image_url)}" data-image-caption="${escapeHtml(exercise.name)}" src="${exercise.gif_url ? DATASET_MEDIA_BASE + escapeHtml(exercise.gif_url) : exerciseImageUrl(exercise.image_url)}" onerror="this.onerror=null;this.src='${exerciseImageUrl(exercise.image_url)}';this.dataset.expandImage=this.src" alt="Démonstration de ${escapeHtml(exercise.name)}">` : '<div class="exercise-detail-media"></div>'}
        <div class="exercise-detail-head"><span class="eyebrow">${escapeHtml(exercise.muscle_group || 'Exercice')}</span><h2 id="exercise-detail-name">${escapeHtml(exercise.name)}</h2><p>${escapeHtml(exercise.target || '')}${exercise.equipment ? ` · ${escapeHtml(exercise.equipment)}` : ''}</p></div>
      </div>
      <div class="exercise-detail-body"><h3>Comment réaliser le mouvement</h3>
        ${steps.length ? `<ol class="instruction-steps">${steps.map(step => `<li>${escapeHtml(step)}</li>`).join('')}</ol>` : '<p>Instructions non disponibles pour cet exercice.</p>'}
        <p class="dataset-credit">Données : exercises-dataset · ${escapeHtml(exercise.attribution || '')}</p>
      </div>`;
  } catch (error) { content.innerHTML = emptyState('Impossible de charger cet exercice', error.message); }
}

document.getElementById('exercise-search')?.addEventListener('input', applyExerciseFilters);
document.getElementById('muscle-filter')?.addEventListener('change', applyExerciseFilters);

// Records
async function loadRecords() {
  try {
    allRecords = await apiCall('/api/records');
    const muscles = [...new Set(allRecords.map(record => record.muscle_group).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr'));
    document.getElementById('record-muscle-filter').innerHTML = '<option value="">Toutes les catégories</option>' + muscles.map(muscle => `<option value="${escapeHtml(muscle)}">${escapeHtml(muscle)}</option>`).join('');
    renderRecords();
  } catch {}
}

function renderRecords() {
  const query = document.getElementById('record-search')?.value.trim().toLocaleLowerCase('fr') || '';
  const muscle = document.getElementById('record-muscle-filter')?.value || '';
  const records = allRecords.filter(record => (!query || record.exercise_name.toLocaleLowerCase('fr').includes(query)) && (!muscle || record.muscle_group === muscle));
  const container = document.getElementById('records-list');
  document.getElementById('record-results-summary').textContent = `${records.length} record${records.length > 1 ? 's' : ''} affiché${records.length > 1 ? 's' : ''}`;
  container.innerHTML = records.map((r, index) => `
      <div class="list-item record-item" data-record-exercise="${Number(r.exercise_id)}" data-record-name="${escapeHtml(r.exercise_name)}" role="button" tabindex="0" aria-label="Voir la progression de ${escapeHtml(r.exercise_name)}">
        <div class="record-rank">${index + 1}</div>${r.image_url ? `<button class="expandable-image record-image" data-view-exercise="${Number(r.exercise_id)}" data-exercise-caption="${escapeHtml(r.exercise_name)}" type="button" aria-label="Voir le mouvement de ${escapeHtml(r.exercise_name)}"><img src="${exerciseImageUrl(r.image_url)}" alt=""></button>` : '<span class="record-image exercise-thumb-placeholder">GW</span>'}<div><div class="list-item-title">${escapeHtml(r.exercise_name)}</div>
        <div class="list-item-subtitle">Réalisé dans ${Number(r.workout_count)} séance${Number(r.workout_count) > 1 ? 's' : ''} · ${Number(r.set_count)} séries</div><span class="record-chart-hint">Voir la courbe <b>↗</b></span></div>
        <div class="record-performance"><strong>${Number(r.max_weight) || 0} kg</strong><small>${Number(r.reps_at_record) || 0} répétitions</small></div>
      </div>
    `).join('') || emptyState('Aucun record trouvé', allRecords.length ? 'Essayez un autre nom ou une autre catégorie.' : 'Vos performances apparaîtront après vos séances.');
}

async function showRecordProgress(exerciseId, exerciseName) {
  const modal = document.getElementById('record-progress-modal');
  const chart = document.getElementById('record-progress-chart');
  modal.classList.remove('hidden');
  document.getElementById('record-progress-title').textContent = exerciseName;
  document.getElementById('record-progress-summary').innerHTML = '';
  chart.innerHTML = '<div class="empty-state"><div><strong>Chargement de la progression…</strong></div></div>';
  try {
    const history = (await apiCall(`/api/progress/${exerciseId}`)).reverse();
    if (!history.length) { chart.innerHTML = emptyState('Pas encore de courbe', 'Réalisez cet exercice dans plusieurs séances pour suivre son évolution.'); return; }
    const values = history.map(point => Number(point.max_weight) || 0);
    const maxValue = Math.max(...values, 1);
    const minValue = Math.min(...values, 0);
    const range = Math.max(maxValue - minValue, maxValue * .15, 1);
    const width = 640, height = 280, left = 46, right = 18, top = 24, bottom = 44;
    const plotWidth = width - left - right, plotHeight = height - top - bottom;
    const points = history.map((point, index) => ({
      x: history.length === 1 ? left + plotWidth / 2 : left + index * plotWidth / (history.length - 1),
      y: top + (maxValue - (Number(point.max_weight) || 0)) * plotHeight / range,
      ...point
    }));
    const polyline = points.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
    const area = `M ${points[0].x} ${top + plotHeight} L ${polyline.replaceAll(',', ' ')} L ${points.at(-1).x} ${top + plotHeight} Z`;
    const first = values[0], last = values.at(-1), delta = last - first;
    document.getElementById('record-progress-summary').innerHTML = `<div><strong>${last} kg</strong><span>charge actuelle</span></div><div class="${delta > 0 ? 'positive' : ''}"><strong>${delta > 0 ? '+' : ''}${delta.toLocaleString('fr-FR')} kg</strong><span>évolution</span></div><div><strong>${history.length}</strong><span>jour${history.length > 1 ? 's' : ''} suivi${history.length > 1 ? 's' : ''}</span></div>`;
    const grid = [0, .25, .5, .75, 1].map(ratio => { const y = top + ratio * plotHeight; const value = maxValue - ratio * range; return `<line x1="${left}" y1="${y}" x2="${width-right}" y2="${y}"/><text x="${left-8}" y="${y+4}" text-anchor="end">${Math.max(0, value).toFixed(0)}</text>`; }).join('');
    const labels = points.filter((_, index) => index === 0 || index === points.length - 1 || (points.length > 5 && index === Math.floor(points.length / 2))).map(point => `<text x="${point.x}" y="${height-14}" text-anchor="middle">${new Date(`${point.date}T12:00:00`).toLocaleDateString('fr-FR', { day:'2-digit', month:'short' })}</text>`).join('');
    chart.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Courbe de progression de ${escapeHtml(exerciseName)}"><g class="chart-grid">${grid}${labels}</g><path class="chart-area" d="${area}"/><polyline class="chart-line" points="${polyline}"/>${points.map(point => `<circle class="chart-point" cx="${point.x}" cy="${point.y}" r="5"><title>${point.date} : ${Number(point.max_weight) || 0} kg</title></circle>`).join('')}</svg>`;
  } catch (error) { chart.innerHTML = emptyState('Progression indisponible', error.message); }
}

function closeRecordProgress() { document.getElementById('record-progress-modal')?.classList.add('hidden'); }

function openImageViewer(src, caption) {
  document.getElementById('image-viewer-img').src = src;
  document.getElementById('image-viewer-caption').textContent = caption || '';
  document.getElementById('image-viewer-modal').classList.remove('hidden');
}

async function openExerciseViewer(id, caption) {
  const modal = document.getElementById('image-viewer-modal');
  const image = document.getElementById('image-viewer-img');
  modal.classList.remove('hidden');
  image.removeAttribute('src');
  document.getElementById('image-viewer-caption').textContent = `Chargement de ${caption || 'l’exercice'}…`;
  try {
    const exercise = await apiCall(`/api/exercises/${id}`);
    const fallback = exerciseImageUrl(exercise.image_url);
    image.onerror = () => { image.onerror = null; image.src = fallback; };
    image.src = exercise.gif_url ? DATASET_MEDIA_BASE + exercise.gif_url : fallback;
    document.getElementById('image-viewer-caption').textContent = exercise.name;
  } catch (error) {
    document.getElementById('image-viewer-caption').textContent = error.message;
  }
}

// Timer
let timerInterval = null;
let timerDialAnimationFrame = null;

// Workout
let workoutExercises = [];

function addExerciseToWorkout() {
  const container = document.getElementById('workout-exercises');
  const id = Date.now();
  
  if (!allExercises || allExercises.length === 0) {
    showToast('Chargement des exercices…');
    loadWorkoutExercises().then(() => addExerciseToWorkout());
    return;
  }
  
  const html = `
    <div class="workout-exercise-card" data-id="${id}">
      <div class="form-group">
        <label>Rechercher un exercice</label>
        <input type="text" class="exercise-search-input" placeholder="Tapez pour chercher...">
        <div class="exercise-results"></div>
      </div>
      <div class="form-group exercise-fields" style="display:none;">
        <label>Exercice sélectionné</label>
        <div class="selected-exercise-name"></div>
      </div>
      <div class="form-group exercise-fields" style="display:none;">
        <label>Séries</label>
        <input type="number" class="sets-input" value="3" min="1">
      </div>
      <div class="form-group exercise-fields" style="display:none;">
        <label>Reps</label>
        <input type="number" class="reps-input" value="10" min="1">
      </div>
      <div class="form-group exercise-fields" style="display:none;">
        <label>Poids (kg)</label>
        <input type="number" class="weight-input" value="0" step="0.5">
      </div>
      <button class="btn-remove-exercise" data-action="remove-exercise">✕ Supprimer</button>
    </div>
  `;
  
  container.insertAdjacentHTML('beforeend', html);
  updateExerciseResults(container.querySelector('.workout-exercise-card:last-child'));
}

function updateExerciseResults(card) {
  const searchInput = card.querySelector('.exercise-search-input');
  const resultsContainer = card.querySelector('.exercise-results');
  const search = searchInput.value.toLowerCase();
  
  const filtered = (search 
    ? allExercises.filter(ex => `${ex.name} ${ex.muscle_group || ''} ${ex.target || ''} ${ex.equipment || ''}`.toLocaleLowerCase('fr').includes(search.toLocaleLowerCase('fr')))
    : allExercises).slice(0, 30);
  
  resultsContainer.innerHTML = filtered.map(ex => `
    <div class="exercise-result-item" data-id="${Number(ex.id)}" data-name="${escapeHtml(ex.name)}" data-image="${escapeHtml(ex.image_url || '')}" data-action="select-exercise">
      ${ex.image_url ? `<img class="exercise-result-thumb exercise-zoomable" data-view-exercise="${Number(ex.id)}" data-exercise-caption="${escapeHtml(ex.name)}" src="${exerciseImageUrl(ex.image_url)}" alt="" loading="lazy">` : '<span class="exercise-result-thumb exercise-thumb-placeholder">GW</span>'}
      <span><strong>${escapeHtml(ex.name)}</strong><small>${escapeHtml(ex.muscle_group || '')}${ex.equipment ? ` · ${escapeHtml(ex.equipment)}` : ''}</small></span>
    </div>
  `).join('');
}

function filterExerciseResults(input) {
  const card = input.closest('.workout-exercise-card');
  updateExerciseResults(card);
}

function selectExercise(item) {
  const card = item.closest('.workout-exercise-card');
  const id = item.dataset.id;
  const name = item.dataset.name;
  const image = item.dataset.image;
  
  card.dataset.exerciseId = id;
  const selected = card.querySelector('.selected-exercise-name');
  selected.innerHTML = image
    ? `<img class="selected-exercise-thumb exercise-zoomable" data-view-exercise="${Number(id)}" data-exercise-caption="${escapeHtml(name)}" src="${exerciseImageUrl(image)}" alt=""><span>${escapeHtml(name)}</span>`
    : `<span>${escapeHtml(name)}</span>`;
  card.querySelector('.exercise-search-input').value = name;
  card.querySelector('.exercise-results').innerHTML = '';
  card.querySelectorAll('.exercise-fields').forEach(f => f.style.display = 'block');
}

let previousWorkoutsCache = null;

async function loadPreviousWorkout(exerciseId, card) {
  try {
    // Cache workouts for session
    if (!previousWorkoutsCache) {
      previousWorkoutsCache = await apiCall('/api/workouts?limit=10');
    }
    
    for (const w of previousWorkoutsCache) {
      const detail = await apiCall(`/api/workouts/${w.id}`);
      const ex = detail.exercises?.find(e => e.exercise_id == exerciseId);
      if (ex && ex.sets && ex.sets.length > 0) {
        const container = card.querySelector('.sets-container');
        container.innerHTML = '';
        
        ex.sets.forEach((set, idx) => {
          const html = `
            <div class="set-row">
              <span class="set-number">${idx + 1}</span>
              <span class="set-value" data-edit-type="reps">${set.reps}</span>
              <span class="set-x">×</span>
              <span class="set-value" data-edit-type="weight">${set.weight}</span>
              <span class="set-kg">kg</span>
              <button class="btn-remove-set" data-action="remove-set">✕</button>
            </div>
          `;
          container.insertAdjacentHTML('beforeend', html);
        });
        
        updateWorkoutStats();
        return;
      }
    }
  } catch (err) {
    console.warn('Aucune séance précédente disponible:', err.message);
  }
}

// ============ ACTIVE WORKOUT FUNCTIONS ============

function startWorkout() {
  const name = document.getElementById('workout-name').value || 'Séance';
  
  // Show active workout section
  document.getElementById('start-workout-section').classList.add('hidden');
  document.getElementById('active-workout-section').classList.remove('hidden');
  
  // Initialize workout state
  workoutStartTime = Date.now();
  activeExercises = [];
  totalKg = 0;
  totalSets = 0;
  previousWorkoutsData = null;
  
  // Start timer
  workoutTimerInterval = setInterval(updateWorkoutTimer, 1000);
  
  // Reset display
  document.getElementById('workout-timer').textContent = '00:00';
  document.getElementById('workout-total-kg').textContent = '0';
  document.getElementById('workout-total-sets').textContent = '0';
  document.getElementById('active-workout-exercises').innerHTML = '';
  if (normalizeSecretName(name) === 'one punch man') prepareOnePunchChallenge();
}

function updateWorkoutTimer() {
  if (!workoutStartTime) return;
  
  const elapsed = Math.floor((Date.now() - workoutStartTime) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  
  document.getElementById('workout-timer').textContent = 
    `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function updateWorkoutStats() {
  let kg = 0;
  let sets = 0;
  
  document.querySelectorAll('.active-exercise-card').forEach(card => {
    const exerciseId = card.dataset.exerciseId;
    if (!exerciseId) return;
    
    card.querySelectorAll('.set-row').forEach(setRow => {
      const spans = setRow.querySelectorAll('.set-value');
      const reps = parseInt(spans[0]?.textContent) || 0;
      const weight = parseFloat(spans[1]?.textContent) || 0;
      
      if (weight > 0 && reps > 0) {
        kg += weight * reps;
        sets++;
      }
    });
  });
  
  document.getElementById('workout-total-kg').textContent = kg;
  document.getElementById('workout-total-sets').textContent = sets;
}

async function finishWorkout() {
  const name = document.getElementById('workout-name').value || 'Séance';
  const duration = workoutStartTime ? Math.max(1, Math.round((Date.now() - workoutStartTime) / 60000)) : 0;
  
  const exercises = [];
  document.querySelectorAll('.active-exercise-card').forEach(card => {
    const exerciseId = card.dataset.exerciseId;
    const exerciseName = card.querySelector('.selected-exercise-name')?.textContent;
    
    if (!exerciseId) {
      return;
    }
    
    const sets = [];
    card.querySelectorAll('.set-row').forEach(setRow => {
      const spans = setRow.querySelectorAll('.set-value');
      const reps = parseInt(spans[0]?.textContent) || 0;
      const weight = parseFloat(spans[1]?.textContent) || 0;
      
      if (reps > 0) {
        sets.push({ reps, weight });
      }
    });
    
    if (sets.length > 0) {
      exercises.push({ exercise_id: exerciseId, sets });
    }
  });
  
  
  if (exercises.length === 0) {
    if (!await goodwaterConfirm('Aucun exercice ajouté. Voulez-vous vraiment terminer ?')) return;
  }
  
  if (!await goodwaterConfirm('Terminer la séance ?')) return;
  
  clearInterval(workoutTimerInterval);
  
  if (exercises.length > 0) {
    try {
      await apiCall('/api/workouts', { method:'POST', body:JSON.stringify({ name, notes:'', duration, exercises }) });
      const nightBadgeUnlocked = unlockNightCreature();
      showToast(nightBadgeUnlocked ? 'Badge secret débloqué : Créature de la nuit' : 'Séance enregistrée !');
      resetWorkout();
      switchNav('dashboard');
    } catch (err) {
      showToast(`Erreur : ${err.message}`);
    }
  } else {
    resetWorkout();
    switchNav('dashboard');
  }
}

async function abandonWorkout() {
  if (!await goodwaterConfirm('Abandonner la séance ? Les données seront perdues.')) return;
  
  clearInterval(workoutTimerInterval);
  resetWorkout();
  switchNav('dashboard');
}

function resetWorkout() {
  workoutStartTime = null;
  clearInterval(workoutTimerInterval);
  activeExercises = [];
  totalKg = 0;
  totalSets = 0;
  
  document.getElementById('start-workout-section').classList.remove('hidden');
  document.getElementById('active-workout-section').classList.add('hidden');
  document.getElementById('workout-name').value = '';
  document.getElementById('active-workout-exercises').innerHTML = '';
}

function addExerciseToActiveWorkout(preselectedExercise = null) {
  const container = document.getElementById('active-workout-exercises');
  const exerciseId = Date.now();
  
  const html = `
    <div class="active-exercise-card workout-exercise-card" data-exercise-id="${exerciseId}">
      <div class="form-group">
        <label>Exercice</label>
        <input type="text" class="exercise-search-input" placeholder="Nom, muscle ou équipement…">
        <div class="exercise-results"></div>
        <div class="selected-exercise-name"></div>
      </div>
      <div class="sets-container"></div>
      <button class="btn-add-set" data-action="add-set">+ Ajouter une série</button>
      <button class="btn-remove-exercise" data-action="remove-active-exercise">✕ Supprimer</button>
    </div>
  `;
  
  container.insertAdjacentHTML('beforeend', html);
  const card = container.querySelector('.active-exercise-card:last-child');
  if (preselectedExercise) {
    card.dataset.exerciseId = preselectedExercise.id;
    card.querySelector('.exercise-search-input').value = preselectedExercise.name;
    card.querySelector('.selected-exercise-name').innerHTML = preselectedExercise.image_url
      ? `<img class="selected-exercise-thumb exercise-zoomable" data-view-exercise="${Number(preselectedExercise.id)}" data-exercise-caption="${escapeHtml(preselectedExercise.name)}" src="${exerciseImageUrl(preselectedExercise.image_url)}" alt=""><span>${escapeHtml(preselectedExercise.name)}</span>`
      : `<span>${escapeHtml(preselectedExercise.name)}</span>`;
  } else updateExerciseResults(card);
  
  // Add initial 3 sets
  const setCount = preselectedExercise?.setsData?.length || (preselectedExercise ? Number(preselectedExercise.sets) || 3 : 3);
  for (let i = 0; i < setCount; i++) {
    const savedSet = preselectedExercise?.setsData?.[i];
    addSetToExercise(card.querySelector('.btn-add-set'), savedSet || (preselectedExercise ? { reps:preselectedExercise.reps, weight:preselectedExercise.weight } : undefined));
  }
}

function addSetToExercise(btn, defaults = {}) {
  const card = btn.closest('.active-exercise-card');
  const container = card.querySelector('.sets-container');
  const setNum = container.querySelectorAll('.set-row').length + 1;
  
  const html = `
    <div class="set-row">
      <span class="set-number">${setNum}</span>
      <span class="set-value" data-edit-type="reps">${Number(defaults.reps) || 10}</span>
      <span class="set-x">×</span>
      <span class="set-value" data-edit-type="weight">${Number(defaults.weight) || 0}</span>
      <span class="set-kg">kg</span>
      <button class="btn-remove-set" data-action="remove-set">✕</button>
    </div>
  `;
  
  container.insertAdjacentHTML('beforeend', html);
  updateWorkoutStats();
}

function editSetValue(span, type) {
  const row = span.parentElement;
  const currentValue = span.textContent;
  
  // Create input
  const input = document.createElement('input');
  input.type = type === 'reps' ? 'number' : 'number';
  input.className = 'set-edit-input';
  input.value = currentValue;
  input.min = type === 'reps' ? '1' : '0';
  input.step = type === 'weight' ? '0.5' : '1';
  
  // Replace span with input
  span.replaceWith(input);
  input.focus();
  input.select();
  
  // Handle blur/enter
  const finishEdit = () => {
    const newValue = input.value || '0';
    const newSpan = document.createElement('span');
    newSpan.className = 'set-value';
    newSpan.textContent = newValue;
    newSpan.onclick = () => editSetValue(newSpan, type);
    input.replaceWith(newSpan);
    updateWorkoutStats();
  };
  
  input.onblur = finishEdit;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') finishEdit();
  };
}

function updateSetNumbers(btn) {
  const container = btn.closest('.sets-container');
  container.querySelectorAll('.set-number').forEach((num, i) => {
    num.textContent = i + 1;
  });
}

// ============ TIMER FUNCTIONS ============

function startTimer(seconds) {
  clearInterval(timerInterval);
  let remaining = seconds;
  const total = seconds;
  const currentDialSeconds = Number(document.getElementById('timer-dial-handle')?.getAttribute('aria-valuenow')) || 0;
  document.getElementById('rest-timer')?.classList.add('is-running');
  document.getElementById('timer-status').textContent = 'En cours';
  document.querySelectorAll('.timer-btn').forEach(button => button.classList.toggle('active', Number(button.dataset.time) === seconds));
  updateTimerDisplay(remaining, total, false);
  animateTimerDial(currentDialSeconds, remaining);
  
  timerInterval = setInterval(() => {
    remaining--;
    updateTimerDisplay(remaining, total);
    if (remaining <= 0) {
      clearInterval(timerInterval);
      document.getElementById('rest-timer')?.classList.remove('is-running');
      document.getElementById('timer-status').textContent = 'Terminé';
      document.querySelectorAll('.timer-btn').forEach(button => button.classList.remove('active'));
      showToast('Repos terminé !');
    }
  }, 1000);
}

function positionTimerDial(seconds) {
  const progress = Math.max(0, Math.min(1, seconds / 600));
  const angle = progress * Math.PI * 2;
  const ring = document.getElementById('timer-ring');
  ring?.style.setProperty('--timer-handle-x', `${50 + Math.sin(angle) * 47.5}%`);
  ring?.style.setProperty('--timer-handle-y', `${50 - Math.cos(angle) * 47.5}%`);
}

function animateTimerDial(fromSeconds, toSeconds) {
  cancelAnimationFrame(timerDialAnimationFrame);
  const handle = document.getElementById('timer-dial-handle');
  if (!handle || fromSeconds === toSeconds) return positionTimerDial(toSeconds);
  const startedAt = performance.now();
  const duration = 950;
  handle.classList.add('is-orbiting');
  const frame = now => {
    const progress = Math.min(1, (now - startedAt) / duration);
    positionTimerDial(fromSeconds + (toSeconds - fromSeconds) * progress);
    if (progress < 1) timerDialAnimationFrame = requestAnimationFrame(frame);
    else handle.classList.remove('is-orbiting');
  };
  timerDialAnimationFrame = requestAnimationFrame(frame);
}

function updateTimerDisplay(seconds, total = 0, updateDial = true) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  document.getElementById('timer-display').textContent = 
    `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  const progress = Math.max(0, Math.min(1, seconds / 600));
  const ring = document.getElementById('timer-ring');
  ring?.style.setProperty('--timer-progress', `${progress * 100}%`);
  if (updateDial) positionTimerDial(seconds);
  const handle = document.getElementById('timer-dial-handle');
  handle?.setAttribute('aria-valuenow', String(seconds));
  handle?.setAttribute('aria-valuetext', `${mins} minute${mins > 1 ? 's' : ''} ${secs} seconde${secs > 1 ? 's' : ''}`);
  document.getElementById('rest-timer')?.classList.toggle('is-ending', seconds > 0 && seconds <= 10);
}

function stopTimer() {
  clearInterval(timerInterval);
  cancelAnimationFrame(timerDialAnimationFrame);
  document.getElementById('timer-dial-handle')?.classList.remove('is-orbiting');
  updateTimerDisplay(0);
  document.getElementById('rest-timer')?.classList.remove('is-running');
  document.getElementById('rest-timer')?.classList.remove('is-ending');
  document.getElementById('timer-status').textContent = 'Prêt';
  document.querySelectorAll('.timer-btn').forEach(button => button.classList.remove('active'));
}

// Init
document.addEventListener('DOMContentLoaded', async () => {
  loadTheme();
  updateThemeControls();

  if (await restoreSharedSession()) {
    showMainApp();
  } else {
    token = null;
    localStorage.removeItem('token');
    showPage('login-page');
  }

  // Close workout detail modal
  document.getElementById('close-detail-modal-btn')?.addEventListener('click', closeWorkoutDetailModal);
  document.getElementById('reuse-workout-btn')?.addEventListener('click', () => currentDetailWorkoutId && reuseWorkout(currentDetailWorkoutId));
  document.getElementById('workout-detail-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'workout-detail-modal') closeWorkoutDetailModal();
  });
  document.getElementById('cancel-delete-workout')?.addEventListener('click', () => closeWorkoutDeleteConfirmation(false));
  document.getElementById('confirm-delete-workout')?.addEventListener('click', () => closeWorkoutDeleteConfirmation(true));
  document.getElementById('delete-workout-modal')?.addEventListener('click', event => {
    if (event.target.id === 'delete-workout-modal') closeWorkoutDeleteConfirmation(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !document.getElementById('delete-workout-modal')?.classList.contains('hidden')) closeWorkoutDeleteConfirmation(false);
  });

  // Login
  document.getElementById('login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;
    const errorEl = document.getElementById('login-error');
    const btn = e.target.querySelector('button');

    btn.disabled = true;
    btn.textContent = 'Connexion...';
    errorEl.textContent = '';

    try {
      await login(username, password);
    } catch (err) {
      errorEl.textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Se connecter';
    }
  });

  // Register
  document.getElementById('register-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('register-username').value;
    const password = document.getElementById('register-password').value;
    const errorEl = document.getElementById('register-error');
    const successEl = document.getElementById('register-success');
    const btn = e.target.querySelector('button');

    btn.disabled = true;
    errorEl.textContent = '';
    successEl.textContent = '';

    try {
      await register(username, password);
      successEl.textContent = 'Demande envoyée. Un administrateur doit valider votre compte.';
      setTimeout(() => showPage('login-page'), 2000);
    } catch (err) {
      errorEl.textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = "S'inscrire";
    }
  });

  // Navigation
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchNav(btn.dataset.nav));
  });

  document.querySelectorAll('[data-go-workout]').forEach(button => button.addEventListener('click', () => switchNav('workout')));
  document.querySelectorAll('[data-go-history]').forEach(button => button.addEventListener('click', () => switchNav('history')));
  document.querySelector('[data-go-exercises]')?.addEventListener('click', () => switchNav('exercises'));
  document.querySelectorAll('[data-go-programs]').forEach(button => button.addEventListener('click', () => switchNav('programs')));
  document.getElementById('settings-btn')?.addEventListener('click', openSettings);
  document.getElementById('close-settings-btn')?.addEventListener('click', closeSettings);
  document.getElementById('settings-modal')?.addEventListener('click', event => {
    if (event.target.id === 'settings-modal') closeSettings();
  });
  document.getElementById('settings-theme-btn')?.addEventListener('click', toggleTheme);
  document.getElementById('passkey-login-btn')?.addEventListener('click', loginWithPasskey);
  document.getElementById('register-passkey-btn')?.addEventListener('click', registerPasskey);
  document.getElementById('profile-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const message = document.getElementById('profile-message');
    const button = event.currentTarget.querySelector('button[type="submit"]');
    message.textContent = '';
    button.disabled = true;
    try {
      const profile = await apiCall('/api/profile', { method:'PUT', body:JSON.stringify({
        firstName:document.getElementById('profile-first-name').value,
        lastName:document.getElementById('profile-last-name').value,
        description:document.getElementById('profile-description').value
      }) });
      document.getElementById('settings-avatar').textContent = (profile.firstName || profile.username || '?').slice(0, 1).toUpperCase();
      message.textContent = 'Profil enregistré sur tous les services.';
      message.className = 'form-message message-success';
    } catch (error) { message.textContent = error.message; message.className = 'form-message message-error'; }
    finally { button.disabled = false; }
  });
  document.getElementById('change-password-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const message = document.getElementById('password-change-message');
    const button = event.currentTarget.querySelector('button[type="submit"]');
    message.textContent = '';
    button.disabled = true;
    try {
      await apiCall('/api/profile/password', { method:'PUT', body:JSON.stringify({
        currentPassword:document.getElementById('current-password').value,
        newPassword:document.getElementById('new-password-profile').value,
        confirmPassword:document.getElementById('confirm-password').value
      }) });
      event.currentTarget.reset();
      message.textContent = 'Mot de passe modifié sur tous les services.';
      message.className = 'form-message message-success';
    } catch (error) { message.textContent = error.message; message.className = 'form-message message-error'; }
    finally { button.disabled = false; }
  });
  document.getElementById('calendar-prev')?.addEventListener('click', () => calendarView === 'month' ? moveCalendarWeek(-1) : moveCalendarPeriod(-1));
  document.getElementById('calendar-next')?.addEventListener('click', () => calendarView === 'month' ? moveCalendarWeek(1) : moveCalendarPeriod(1));
  document.querySelectorAll('[data-calendar-view]').forEach(button => button.addEventListener('click', () => {
    calendarView = button.dataset.calendarView;
    if (calendarView === 'month') calendarWindowStart = startOfCalendarWeek(new Date(calendarDate.getFullYear(), calendarDate.getMonth(), 1));
    loadCalendarMonth();
  }));
  document.querySelector('.calendar-card')?.addEventListener('wheel', event => {
    if (calendarView !== 'month' || Math.abs(event.deltaY) < 8) return;
    event.preventDefault();
    if (calendarWheelLocked) return;
    calendarWheelLocked = true;
    moveCalendarWeek(event.deltaY > 0 ? 1 : -1);
    window.setTimeout(() => { calendarWheelLocked = false; }, 450);
  }, { passive:false });
  document.querySelectorAll('[data-password-toggle]').forEach(button => button.addEventListener('click', () => {
    const input = document.getElementById(button.dataset.passwordToggle);
    const visible = input.type === 'text';
    input.type = visible ? 'password' : 'text';
    button.textContent = visible ? 'Afficher' : 'Masquer';
    button.setAttribute('aria-pressed', String(!visible));
  }));

  // Logout
  document.getElementById('logout-btn')?.addEventListener('click', logout);
  document.getElementById('theme-btn')?.addEventListener('click', toggleTheme);

  // Timer
  document.querySelectorAll('.timer-btn').forEach(btn => {
    btn.addEventListener('click', () => startTimer(parseInt(btn.dataset.time)));
  });
  document.getElementById('stop-timer-btn')?.addEventListener('click', stopTimer);
  const timerRing = document.getElementById('timer-ring');
  const timerDialHandle = document.getElementById('timer-dial-handle');
  let dialSeconds = 0;
  let previousDialSeconds = 0;

  const selectDialTime = event => {
    const bounds = timerRing.getBoundingClientRect();
    const dx = event.clientX - (bounds.left + bounds.width / 2);
    const dy = event.clientY - (bounds.top + bounds.height / 2);
    let angle = Math.atan2(dx, -dy);
    if (angle < 0) angle += Math.PI * 2;
    let selected = Math.round((angle / (Math.PI * 2) * 600) / 5) * 5;
    if (previousDialSeconds >= 570 && selected <= 30) selected = 600;
    dialSeconds = Math.max(0, Math.min(600, selected));
    previousDialSeconds = dialSeconds;
    updateTimerDisplay(dialSeconds, 600);
    document.getElementById('timer-status').textContent = 'Réglage';
  };

  timerDialHandle?.addEventListener('pointerdown', event => {
    clearInterval(timerInterval);
    document.getElementById('rest-timer')?.classList.remove('is-running', 'is-ending');
    previousDialSeconds = Number(timerDialHandle.getAttribute('aria-valuenow')) || 0;
    timerDialHandle.setPointerCapture(event.pointerId);
    timerDialHandle.classList.add('is-dragging');
    timerRing.classList.add('is-adjusting');
    selectDialTime(event);
  });
  timerDialHandle?.addEventListener('pointermove', event => {
    if (timerDialHandle.hasPointerCapture(event.pointerId)) selectDialTime(event);
  });
  const finishDialSelection = event => {
    if (!timerDialHandle?.hasPointerCapture(event.pointerId)) return;
    timerDialHandle.releasePointerCapture(event.pointerId);
    timerDialHandle.classList.remove('is-dragging');
    timerRing.classList.remove('is-adjusting');
    if (dialSeconds > 0) startTimer(dialSeconds);
    else stopTimer();
  };
  timerDialHandle?.addEventListener('pointerup', finishDialSelection);
  timerDialHandle?.addEventListener('pointercancel', finishDialSelection);
  timerDialHandle?.addEventListener('keydown', event => {
    const current = Number(timerDialHandle.getAttribute('aria-valuenow')) || 0;
    const step = event.shiftKey ? 60 : 5;
    let selected = current;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') selected += step;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') selected -= step;
    else if (event.key === 'Home') selected = 0;
    else if (event.key === 'End') selected = 600;
    else if (event.key === 'Enter' && current > 0) return startTimer(current);
    else return;
    event.preventDefault();
    dialSeconds = Math.max(0, Math.min(600, selected));
    updateTimerDisplay(dialSeconds, 600);
    document.getElementById('timer-status').textContent = 'Réglage';
  });
  document.getElementById('custom-timer-form')?.addEventListener('submit', event => {
    event.preventDefault();
    const input = document.getElementById('custom-timer-minutes');
    const match = input.value.trim().match(/^(\d{1,2})(?:[.,](\d{1,2}))?$/);
    const minutes = match ? Number.parseInt(match[1], 10) : NaN;
    const secondsText = match?.[2] || '';
    const seconds = secondsText ? Number.parseInt(secondsText.padEnd(2, '0'), 10) : 0;
    const totalSeconds = minutes * 60 + seconds;
    if (!match || seconds >= 60 || totalSeconds <= 0 || totalSeconds > 600) {
      input.setCustomValidity('Utilisez le format minutes.secondes (ex. 4.5 = 4 min 50 s). Les secondes doivent rester entre 00 et 59, avec un maximum total de 10 minutes.');
      input.reportValidity();
      return;
    }
    input.setCustomValidity('');
    startTimer(totalSeconds);
    input.blur();
  });
  document.getElementById('custom-timer-minutes')?.addEventListener('input', event => event.currentTarget.setCustomValidity(''));

  // Workout buttons
  document.getElementById('start-workout-btn')?.addEventListener('click', startWorkout);
  document.getElementById('finish-workout-btn')?.addEventListener('click', finishWorkout);
  document.getElementById('abandon-workout-btn')?.addEventListener('click', abandonWorkout);
  document.getElementById('add-exercise-btn')?.addEventListener('click', () => addExerciseToActiveWorkout());
  document.getElementById('create-template-btn')?.addEventListener('click', openTemplateModal);
  document.getElementById('close-template-modal')?.addEventListener('click', () => document.getElementById('template-modal').classList.add('hidden'));
  document.getElementById('template-modal')?.addEventListener('click', event => { if (event.target.id === 'template-modal') event.currentTarget.classList.add('hidden'); });
  document.getElementById('template-exercise-search')?.addEventListener('input', renderTemplateExerciseChoices);
  document.getElementById('clear-template-selection')?.addEventListener('click', () => { selectedTemplateExercises.clear(); renderTemplateExerciseChoices(); });
  document.getElementById('save-template-btn')?.addEventListener('click', saveWorkoutTemplate);
  document.getElementById('clear-exercise-selection')?.addEventListener('click', () => { selectedLibraryExercises.clear(); updateLibrarySelectionBar(); renderExerciseList(filteredExercises); });
  document.getElementById('add-selection-to-template')?.addEventListener('click', openAssignTemplateModal);
  document.getElementById('close-assign-template')?.addEventListener('click', () => document.getElementById('assign-template-modal').classList.add('hidden'));
  document.getElementById('assign-template-modal')?.addEventListener('click', event => { if (event.target.id === 'assign-template-modal') event.currentTarget.classList.add('hidden'); });
  document.getElementById('create-template-from-selection')?.addEventListener('click', createTemplateFromLibrarySelection);
  document.getElementById('close-template-detail')?.addEventListener('click', () => document.getElementById('template-detail-modal').classList.add('hidden'));
  document.getElementById('template-detail-modal')?.addEventListener('click', event => { if (event.target.id === 'template-detail-modal') event.currentTarget.classList.add('hidden'); });
  document.getElementById('record-search')?.addEventListener('input', renderRecords);
  document.getElementById('record-muscle-filter')?.addEventListener('change', renderRecords);
  document.getElementById('close-image-viewer')?.addEventListener('click', () => document.getElementById('image-viewer-modal').classList.add('hidden'));
  document.getElementById('image-viewer-modal')?.addEventListener('click', event => { if (event.target.id === 'image-viewer-modal') event.currentTarget.classList.add('hidden'); });
  document.getElementById('add-custom-exercise-btn')?.addEventListener('click', () => document.getElementById('custom-exercise-modal').classList.remove('hidden'));
  document.getElementById('close-custom-modal-btn')?.addEventListener('click', () => document.getElementById('custom-exercise-modal').classList.add('hidden'));
  document.getElementById('custom-exercise-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await apiCall('/api/exercises', { method: 'POST', body: JSON.stringify({
        name: document.getElementById('custom-exercise-name').value,
        muscle_group: document.getElementById('custom-exercise-muscle').value,
        equipment: document.getElementById('custom-exercise-equipment').value
      }) });
      form.reset();
      document.getElementById('custom-exercise-modal').classList.add('hidden');
      showToast('Exercice personnel créé');
      loadExercises();
    } catch (error) { showToast(error.message); }
  });
  document.getElementById('close-exercise-detail-btn')?.addEventListener('click', () => document.getElementById('exercise-detail-modal').classList.add('hidden'));
  document.getElementById('exercise-detail-modal')?.addEventListener('click', event => {
    if (event.target.id === 'exercise-detail-modal') event.currentTarget.classList.add('hidden');
  });
  document.getElementById('close-record-progress')?.addEventListener('click', closeRecordProgress);
  document.getElementById('record-progress-modal')?.addEventListener('click', event => { if (event.target.id === 'record-progress-modal') closeRecordProgress(); });

  // Switch pages
  document.getElementById('show-register')?.addEventListener('click', e => {
    e.preventDefault();
    showPage('register-page');
  });
  document.getElementById('show-login')?.addEventListener('click', e => {
    e.preventDefault();
    showPage('login-page');
  });
});

document.addEventListener('input', event => {
  if (event.target.matches('.exercise-search-input')) filterExerciseResults(event.target);
});

document.addEventListener('keydown', event => {
  const record = event.target.closest?.('[data-record-exercise]');
  if (record && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    showRecordProgress(Number(record.dataset.recordExercise), record.dataset.recordName);
  }
  if (event.key === 'Escape' && !document.getElementById('record-progress-modal')?.classList.contains('hidden')) closeRecordProgress();
});

document.addEventListener('click', async event => {
  const deleteWorkout = event.target.closest('[data-delete-workout]');
  if (deleteWorkout) return deleteCompletedWorkout(Number(deleteWorkout.dataset.deleteWorkout), deleteWorkout);
  const biometricDelete = event.target.closest('[data-biometric-id]');
  if (biometricDelete) {
    if (!await goodwaterConfirm('Supprimer cette connexion biométrique ?')) return;
    biometricDelete.disabled = true;
    return apiCall(`/api/passkeys/${Number(biometricDelete.dataset.biometricId)}`, { method:'DELETE' })
      .then(() => { showToast('Connexion biométrique supprimée'); loadBiometricCredentials(); })
      .catch(error => { showToast(error.message); biometricDelete.disabled = false; });
  }
  const exerciseViewer = event.target.closest('[data-view-exercise]');
  if (exerciseViewer) return openExerciseViewer(Number(exerciseViewer.dataset.viewExercise), exerciseViewer.dataset.exerciseCaption);
  const expandableImage = event.target.closest('[data-expand-image]');
  if (expandableImage) return openImageViewer(expandableImage.dataset.expandImage, expandableImage.dataset.imageCaption);
  const calendarEvent = event.target.closest('[data-calendar-event]');
  if (calendarEvent) return showWorkoutDetail(Number(calendarEvent.dataset.calendarEvent));
  const calendarDay = event.target.closest('[data-calendar-day]');
  if (calendarDay) return showWorkoutsForDay(calendarDay.dataset.calendarDay);
  const reuseButton = event.target.closest('[data-reuse-workout]');
  if (reuseButton) return reuseWorkout(Number(reuseButton.dataset.reuseWorkout));
  const saveTemplateConfig = event.target.closest('[data-save-template-config]');
  if (saveTemplateConfig) return saveTemplateConfiguration(Number(saveTemplateConfig.dataset.saveTemplateConfig));
  const librarySelect = event.target.closest('[data-select-library-exercise]');
  if (librarySelect) {
    const id = Number(librarySelect.dataset.selectLibraryExercise);
    selectedLibraryExercises.has(id) ? selectedLibraryExercises.delete(id) : selectedLibraryExercises.add(id);
    updateLibrarySelectionBar();
    return renderExerciseList(filteredExercises);
  }
  const assignTemplate = event.target.closest('[data-assign-template]');
  if (assignTemplate) return assignSelectionToTemplate(Number(assignTemplate.dataset.assignTemplate));
  const templateExercise = event.target.closest('[data-template-exercise]');
  if (templateExercise) {
    const id = Number(templateExercise.dataset.templateExercise);
    selectedTemplateExercises.has(id) ? selectedTemplateExercises.delete(id) : selectedTemplateExercises.add(id);
    return renderTemplateExerciseChoices();
  }
  const startTemplate = event.target.closest('[data-start-template]');
  if (startTemplate) {
    document.getElementById('template-detail-modal')?.classList.add('hidden');
    return launchWorkoutTemplate(Number(startTemplate.dataset.startTemplate));
  }
  const viewTemplate = event.target.closest('[data-view-template]');
  if (viewTemplate) return showWorkoutTemplateDetail(Number(viewTemplate.dataset.viewTemplate));
  const deleteTemplate = event.target.closest('[data-delete-template]');
  if (deleteTemplate) {
    if (!await goodwaterConfirm('Supprimer cette séance préparée ?')) return;
    return apiCall(`/api/workout-templates/${Number(deleteTemplate.dataset.deleteTemplate)}`, { method:'DELETE' })
      .then(() => { showToast('Séance supprimée'); loadWorkoutTemplates(); })
      .catch(error => showToast(error.message));
  }
  const detail = event.target.closest('[data-exercise-detail]');
  if (detail) return showExerciseDetail(Number(detail.dataset.exerciseDetail));
  const record = event.target.closest('[data-record-exercise]');
  if (record) return showRecordProgress(Number(record.dataset.recordExercise), record.dataset.recordName);
  const muscleChip = event.target.closest('.muscle-chip');
  if (muscleChip) {
    document.getElementById('muscle-filter').value = muscleChip.dataset.muscle;
    return applyExerciseFilters();
  }
  if (event.target.closest('#load-more-exercises')) {
    exerciseRenderLimit += 48;
    return renderExerciseList(filteredExercises);
  }
  const workout = event.target.closest('[data-workout-id]');
  if (workout) return showWorkoutDetail(Number(workout.dataset.workoutId));

  const actionTarget = event.target.closest('[data-action]');
  if (!actionTarget) return;
  const action = actionTarget.dataset.action;
  if (action === 'select-exercise') return selectExercise(actionTarget);
  if (action === 'add-set') return addSetToExercise(actionTarget);
  if (action === 'remove-set') {
    const exercise = actionTarget.closest('.active-exercise-card');
    actionTarget.closest('.set-row')?.remove();
    exercise?.querySelectorAll('.set-number').forEach((number, index) => { number.textContent = index + 1; });
    return updateWorkoutStats();
  }
  if (action === 'remove-exercise' || action === 'remove-active-exercise') {
    actionTarget.closest('.workout-exercise-card')?.remove();
    if (action === 'remove-active-exercise') updateWorkoutStats();
  }
});

document.addEventListener('click', event => {
  const editableValue = event.target.closest('[data-edit-type]');
  if (editableValue) editSetValue(editableValue, editableValue.dataset.editType);
});

let logoClickCount = 0;
let logoClickResetTimer = null;
document.addEventListener('click', event => {
  const logo = event.target.closest('.login-logo,.banner-logo');
  if (!logo) return;
  logoClickCount++;
  clearTimeout(logoClickResetTimer);
  logoClickResetTimer = setTimeout(() => { logoClickCount = 0; }, 1600);
  if (logoClickCount < 5) return;
  logoClickCount = 0;
  logo.classList.remove('logo-lifting');
  requestAnimationFrame(() => logo.classList.add('logo-lifting'));
  setTimeout(() => logo.classList.remove('logo-lifting'), 2200);
  showToast('Le logo fait aussi ses répétitions !');
});

const gymKonamiCode = ['ArrowUp','ArrowUp','ArrowDown','ArrowDown','ArrowLeft','ArrowRight','ArrowLeft','ArrowRight'];
let gymKonamiPosition = 0;
let retroGymTimer = null;
document.addEventListener('keydown', event => {
  if (event.key === gymKonamiCode[gymKonamiPosition]) gymKonamiPosition++;
  else gymKonamiPosition = event.key === gymKonamiCode[0] ? 1 : 0;
  if (gymKonamiPosition !== gymKonamiCode.length) return;
  gymKonamiPosition = 0;
  clearTimeout(retroGymTimer);
  document.body.classList.add('retro-gym');
  showToast('SALLE RÉTRO DÉBLOQUÉE');
  retroGymTimer = setTimeout(() => document.body.classList.remove('retro-gym'), 5000);
});
