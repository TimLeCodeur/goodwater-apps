// Contrôleur principal de l'interface Goodwater Recipes.
'use strict';

const TOKEN_KEY = 'goodwater-recipes-token';
const USER_KEY = 'goodwater-user';

let recipes = [];
let editingRecipeId = null;
let nutritionEstimated = false;
let nutritionDatasetPromise = null;
let activeCategory = null;
let recipeSort = 'recent';
let personalLibrary = { favorites: [] };
let adminLogLimit = 20;
let adminLogs = [];
let adminJournalView = 'logins';
let shoppingItems = [];
let weeklyMenuItems = [];
let selectedMenuRecipeId = null;
const expandedMenuCategories = new Set();
let cookingRecipeId = null;
let cookingServings = 1;
let cookingStepIndex = 0;
let pendingRecipePhotoBlob = null;
const splashStartedAt = performance.now();

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
    const finish = accepted => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeydown);
      overlay.remove();
      previousFocus?.focus?.();
      resolve(accepted);
    };
    const onKeydown = event => { if (event.key === 'Escape') finish(false); if (event.key === 'Enter') finish(true); };
    overlay.addEventListener('click', event => {
      if (event.target === overlay || event.target.closest('[data-confirm-cancel]')) finish(false);
      else if (event.target.closest('[data-confirm-accept]')) finish(true);
    });
    document.addEventListener('keydown', onKeydown);
    overlay.querySelector('[data-confirm-accept]').focus();
  });
}

async function hideAppSplash() {
  const minimumDisplayTime = 600;
  const remainingTime = Math.max(0, minimumDisplayTime - (performance.now() - splashStartedAt));
  if (remainingTime) await new Promise(resolve => setTimeout(resolve, remainingTime));
  const splash = document.getElementById('app-splash');
  if (!splash) return;
  splash.classList.add('is-hidden');
  setTimeout(() => splash.remove(), 350);
}

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function getStoredUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
  } catch {
    return null;
  }
}

function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

async function apiRequest(url, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = getToken();
  const requiresAuth = options.auth !== false;
  if (requiresAuth && token) headers.set('Authorization', `Bearer ${token}`);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const { auth: _auth, ...fetchOptions } = options;
  const response = await fetch(url, { ...fetchOptions, headers });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : null;

  if (response.status === 401 && requiresAuth) {
    clearSession();
    showAuthPage('login');
    throw new Error('Votre session a expiré. Reconnectez-vous.');
  }
  if (!response.ok) throw new Error(data?.error || `Erreur HTTP ${response.status}`);
  return data;
}

function showAuthPage(page = 'login') {
  document.getElementById('main-page').classList.add('hidden');
  document.getElementById('login-page').classList.toggle('hidden', page !== 'login');
  document.getElementById('register-page').classList.toggle('hidden', page !== 'register');
}

async function showMainPage(user) {
  document.querySelectorAll('.modal').forEach(modal => {
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
  });
  editingRecipeId = null;
  document.getElementById('login-page').classList.add('hidden');
  document.getElementById('register-page').classList.add('hidden');
  document.getElementById('main-page').classList.remove('hidden');
  document.getElementById('header-username').textContent = user.username;
  document.getElementById('recipes-greeting').textContent = `Bonjour ${user.username}, explorez vos recettes ou trouvez une nouvelle idée.`;
  document.querySelectorAll('.nav-btn').forEach(button => {
    button.hidden = user.role === 'admin'
      ? button.dataset.nav !== 'admin'
      : button.dataset.nav === 'admin';
  });
  document.querySelectorAll('.launcher-recipes, .launcher-shopping, .launcher-menu, .launcher-trash').forEach(item => {
    item.hidden = user.role === 'admin';
  });
  document.getElementById('add-recipe-btn').hidden = !['editor', 'grand_chef'].includes(user.role);
  if (user.role === 'admin') {
    switchNav('admin');
    await loadAdminDashboard();
  } else {
    switchNav('recipes');
    await loadRecipes();
    await loadPersonalLibrary();
  }
}

async function restoreSession() {
  const token = getToken();
  let user = getStoredUser();
  if (!token || !user?.username) {
    try {
      user = await apiRequest('/api/session', { auth: false });
      localStorage.setItem(USER_KEY, JSON.stringify(user));
    } catch {
      clearSession();
      showAuthPage();
      return;
    }
  }

  try {
    await showMainPage(user);
  } catch (error) {
    showListMessage(error.message, true);
  }
}

async function loadRecipes() {
  const list = document.getElementById('recipes-list');
  list.replaceChildren(createMessage('Chargement des recettes…'));
  try {
    recipes = await apiRequest('/api/recipes');
    renderRecipes();
  } catch (error) {
    showListMessage(error.message, true);
    throw error;
  }
}

function createMessage(text, isError = false) {
  const paragraph = document.createElement('p');
  paragraph.className = isError ? 'error empty-state' : 'empty-state';
  paragraph.textContent = text;
  return paragraph;
}

function showListMessage(text, isError = false) {
  document.getElementById('recipes-list').replaceChildren(createMessage(text, isError));
}

function normalizeRecipeSearch(value = '') {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('fr').trim();
}

function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

function fuzzyRecipeMatch(recipe, query) {
  if (!query) return true;
  const haystack = normalizeRecipeSearch([recipe.title, recipe.content, recipe.category, recipe.author].join(' '));
  if (haystack.includes(query)) return true;
  const words = haystack.split(/[^a-z0-9]+/).filter(Boolean);
  return query.split(/\s+/).every(term => words.some(word =>
    word.includes(term) || term.includes(word) || (term.length >= 4 && editDistance(term, word) <= Math.max(1, Math.floor(term.length / 4)))
  ));
}

function recipeCategory(recipe) {
  return recipe.category?.trim() || 'Non classée';
}

function renderRecipes() {
  const list = document.getElementById('recipes-list');
  const query = normalizeRecipeSearch(document.getElementById('recipe-search').value);
  const categories = [...new Set(recipes.map(recipeCategory))].sort((a, b) => a.localeCompare(b, 'fr'));
  if (activeCategory && activeCategory !== '__favorites__' && !categories.includes(activeCategory)) activeCategory = null;

  document.getElementById('recipes-total-count').textContent = recipes.length;
  document.getElementById('recipes-category-count').textContent = categories.length;

  const categoryFilters = document.getElementById('recipe-category-filters');
  categoryFilters.replaceChildren();
  const createFilter = (label, value, count) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'recipe-filter-chip';
    button.classList.toggle('active', activeCategory === value);
    button.setAttribute('aria-pressed', String(activeCategory === value));
    button.textContent = `${label} · ${count}`;
    button.addEventListener('click', () => {
      activeCategory = value;
      renderRecipes();
    });
    return button;
  };
  categoryFilters.append(createFilter('Toutes', null, recipes.length));
  categoryFilters.append(createFilter('★ Favoris', '__favorites__', personalLibrary.favorites.length));
  categories.forEach(category => categoryFilters.append(
    createFilter(category, category, recipes.filter(recipe => recipeCategory(recipe) === category).length)
  ));

  const filtered = recipes.filter(recipe => {
    if (activeCategory === '__favorites__' && !personalLibrary.favorites.includes(recipe.id)) return false;
    if (activeCategory && activeCategory !== '__favorites__' && recipeCategory(recipe) !== activeCategory) return false;
    if (!query) return true;
    return fuzzyRecipeMatch(recipe, query);
  });

  filtered.sort((a, b) => {
    if (recipeSort === 'alphabetical') return a.title.localeCompare(b.title, 'fr');
    if (recipeSort === 'category') return recipeCategory(a).localeCompare(recipeCategory(b), 'fr') || a.title.localeCompare(b.title, 'fr');
    return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
  });

  const hasFilters = Boolean(query || activeCategory);
  document.getElementById('recipes-results-title').textContent = activeCategory === '__favorites__'
    ? 'Favoris'
    : activeCategory || (query ? 'Résultats de recherche' : 'Toutes les recettes');
  document.getElementById('recipes-results-count').textContent = `${filtered.length} recette${filtered.length > 1 ? 's' : ''} affichée${filtered.length > 1 ? 's' : ''}`;
  document.getElementById('clear-recipe-filters').classList.toggle('hidden', !hasFilters);
  list.replaceChildren();

  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'recipes-empty-state';
    const icon = document.createElement('span');
    icon.textContent = activeCategory === '__favorites__' ? '☆' : (query || activeCategory ? '⌕' : '🍲');
    icon.setAttribute('aria-hidden', 'true');
    const title = document.createElement('strong');
    title.textContent = activeCategory === '__favorites__' ? 'Aucune recette favorite' : (query || activeCategory ? 'Aucune recette trouvée' : 'Votre bibliothèque est vide');
    const copy = document.createElement('p');
    copy.textContent = activeCategory === '__favorites__' ? 'Touchez l’étoile d’une recette pour la retrouver ici.' : (query || activeCategory ? 'Essayez un autre mot-clé ou effacez les filtres.' : 'Ajoutez votre première recette pour commencer.');
    empty.append(icon, title, copy);
    list.append(empty);
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'recipe-category-grid';
  filtered.forEach(recipe => grid.append(createRecipeCard(recipe)));
  list.append(grid);
}

async function loadPersonalLibrary() {
  try {
    const library = await apiRequest('/api/library');
    personalLibrary = { favorites: Array.isArray(library.favorites) ? library.favorites : [] };
    renderRecipes();
  } catch (error) {
    personalLibrary = { favorites: [] };
    console.warn('Impossible de charger les favoris :', error.message);
  }
}

async function toggleRecipeFavorite(recipeId, button) {
  const favorite = !personalLibrary.favorites.includes(recipeId);
  button.disabled = true;
  try {
    await apiRequest(`/api/recipes/${encodeURIComponent(recipeId)}/favorite`, { method: 'PUT', body: JSON.stringify({ favorite }) });
    personalLibrary.favorites = favorite
      ? [recipeId, ...personalLibrary.favorites.filter(id => id !== recipeId)]
      : personalLibrary.favorites.filter(id => id !== recipeId);
    renderRecipes();
  } catch (error) { window.alert(error.message); }
}

async function shareRecipe(recipeId, button) {
  const previousContent = [...button.childNodes].map(node => node.cloneNode(true));
  button.disabled = true;
  try {
    const share = await apiRequest(`/api/recipes/${encodeURIComponent(recipeId)}/share`, { method: 'POST' });
    if (navigator.share) {
      await navigator.share({ title: 'Recette Goodwater', url: share.url });
      button.textContent = '✓';
    } else {
      await navigator.clipboard.writeText(share.url);
      button.textContent = '✓ Copié';
    }
    window.setTimeout(() => button.replaceChildren(...previousContent), 1800);
  } catch (error) {
    if (error.name !== 'AbortError') window.alert(`Impossible de partager la recette : ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

function createRecipeCard(recipe) {
  const card = document.createElement('article');
  card.className = 'recipe-card';
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `Ouvrir ${recipe.title}`);

  const image = recipe.imageUrl ? document.createElement('img') : null;
  if (image) {
    image.className = 'recipe-card-image';
    image.src = recipe.imageUrl;
    image.alt = `Illustration de ${recipe.title}`;
    image.loading = 'lazy';
  }
  const visual = document.createElement('div');
  visual.className = 'recipe-card-visual';
  if (image) visual.append(image);
  else {
    const placeholder = document.createElement('span');
    placeholder.className = 'recipe-card-placeholder';
    placeholder.textContent = '🍽️';
    placeholder.setAttribute('aria-hidden', 'true');
    visual.append(placeholder);
  }
  const category = document.createElement('span');
  category.className = 'recipe-card-category';
  category.textContent = recipeCategory(recipe);
  visual.append(category);
  const favorite = document.createElement('button');
  favorite.type = 'button';
  favorite.className = 'recipe-favorite-btn';
  favorite.classList.toggle('active', personalLibrary.favorites.includes(recipe.id));
  favorite.textContent = personalLibrary.favorites.includes(recipe.id) ? '★' : '☆';
  favorite.setAttribute('aria-label', personalLibrary.favorites.includes(recipe.id) ? 'Retirer des favoris' : 'Ajouter aux favoris');
  favorite.addEventListener('click', event => {
    event.stopPropagation();
    toggleRecipeFavorite(recipe.id, favorite);
  });
  visual.append(favorite);
  const body = document.createElement('div');
  body.className = 'recipe-card-body';
  const title = document.createElement('h3');
  title.textContent = recipe.title;
  const preview = document.createElement('p');
  preview.className = 'recipe-card-preview';
  preview.textContent = getRecipePreview(recipe.content) || 'Recette sans description';
  const author = document.createElement('p');
  author.className = 'recipe-card-author';
  author.textContent = `Par ${recipe.author || 'inconnu'}`;
  body.append(title, preview, author);
  card.append(visual);
  card.append(body);
  card.addEventListener('click', () => openRecipe(recipe.id));
  card.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openRecipe(recipe.id);
    }
  });
  return card;
}

function parseRecipeDisplay(content) {
  const ingredients = [];
  const steps = [];
  let section = '';

  content.split(/\r?\n/).forEach(rawLine => {
    const line = rawLine.trim();
    if (!line) return;
    if (/^>>\s*ingredients?\s*<<$/i.test(line)) {
      section = 'ingredients';
      return;
    }
    if (/^>>\s*(preparation|préparation|steps?|instructions?)\s*<<$/i.test(line)) {
      section = 'steps';
      return;
    }
    if (/^>>.*<<$/.test(line)) return;

    const ingredient = line.match(/^@([^{}]+)(?:\{([^}]*)\})?/);
    if (ingredient) {
      ingredients.push({ name: ingredient[1].trim(), quantity: ingredient[2]?.trim() || '' });
      return;
    }
    if (section === 'ingredients' && !/^\d+[.)]\s/.test(line)) {
      ingredients.push({ name: line.replace(/^[-*]\s*/, ''), quantity: '' });
      return;
    }
    section = 'steps';
    steps.push(line.replace(/^\d+[.)]\s*/, '').replace(/^[-*]\s*/, ''));
  });

  return { ingredients, steps };
}

function scaleIngredientQuantity(quantity, factor) {
  if (!quantity || factor === 1) return quantity;
  const match = quantity.match(/^(\s*)(?:(\d+)\s*\/\s*(\d+)|(\d+(?:[.,]\d+)?))(.*)$/);
  if (!match) return quantity;
  const value = match[2]
    ? Number(match[2]) / Number(match[3])
    : Number(match[4].replace(',', '.'));
  if (!Number.isFinite(value)) return quantity;
  const scaled = value * factor;
  const rounded = Math.round(scaled * 100) / 100;
  const formatted = Number.isInteger(rounded)
    ? String(rounded)
    : rounded.toLocaleString('fr-FR', { maximumFractionDigits: 2 });
  return `${match[1]}${formatted}${match[5]}`;
}

function withRecipeMetadata(content, category, servings, nutrition = {}, nutritionFoods = [], nutritionStatus = 'manual', nutritionMessage = '') {
  const cleanCategory = category.replace(/[<>\r\n]/g, '').trim() || 'Non classée';
  const cleanServings = Math.max(1, Number.parseInt(servings, 10) || 1);
  const lines = content.replace(/\r\n/g, '\n').split('\n').filter(line =>
    !/^\s*>>\s*(category|servings|calories|protein|carbs|fat|fiber|nutrition_status|nutrition_message|nutrition_foods|nutrition_dataset)\s*:.*<<\s*$/i.test(line)
  );
  const insertAt = lines.findIndex(line => /^\s*>>\s*ingredients?\s*<<\s*$/i.test(line));
  const nutritionLines = [
    ['calories', nutrition.calories], ['protein', nutrition.protein], ['carbs', nutrition.carbs],
    ['fat', nutrition.fat], ['fiber', nutrition.fiber]
  ].filter(([, value]) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0)
    .map(([key, value]) => `>> ${key}: ${Math.round(Number(value) * 10) / 10} <<`);
  const cleanMessage = nutritionMessage.replace(/[<>\r\n]/g, ' ').trim();
  const cleanFoodCodes = nutritionFoods.map(code => /^\d+$/.test(String(code)) ? String(code) : '').join(',');
  const metadata = [
    `>> category: ${cleanCategory} <<`,
    '',
    `>> servings: ${cleanServings} <<`,
    ...nutritionLines,
    `>> nutrition_status: ${nutritionStatus} <<`,
    ...(cleanMessage ? [`>> nutrition_message: ${cleanMessage} <<`] : []),
    ...(cleanFoodCodes ? [`>> nutrition_foods: ${cleanFoodCodes} <<`] : []),
    ...(nutritionStatus === 'ciqual' ? ['>> nutrition_dataset: CIQUAL 2025 <<'] : []),
    ''
  ];
  lines.splice(insertAt >= 0 ? insertAt : 0, 0, ...metadata);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function renderCooklangText(text) {
  const fragment = document.createDocumentFragment();
  const tokenPattern = /~([^{}\n]*)\{([^}]*)\}|@([^{}\n]+?)\{([^}]*)\}|@([\p{L}\p{N}_'-]+)/gu;
  let cursor = 0;
  let match;

  while ((match = tokenPattern.exec(text)) !== null) {
    fragment.append(document.createTextNode(text.slice(cursor, match.index)));
    const token = document.createElement('span');
    if (match[1] !== undefined) {
      const timerName = match[1].trim();
      const duration = match[2].trim().replace(/%/g, ' ');
      const durationParts = duration.match(/^(\d+(?:[.,]\d+)?)(.*)$/);
      token.className = 'cooklang-timer';
      if (timerName) token.append(document.createTextNode(`${timerName} · `));
      token.append(document.createTextNode(durationParts?.[1] || duration));
      if (durationParts?.[2]) {
        const timerUnit = document.createElement('span');
        timerUnit.className = 'cooklang-timer-unit';
        timerUnit.textContent = durationParts[2];
        token.append(timerUnit);
      }
      token.title = 'Temps de cuisson';
    } else {
      const ingredientName = (match[3] || match[5]).trim();
      token.className = 'cooklang-ingredient';
      token.append(document.createTextNode(ingredientName));
      token.title = 'Ingrédient';
    }
    fragment.append(token);
    cursor = tokenPattern.lastIndex;
  }
  fragment.append(document.createTextNode(text.slice(cursor)));
  return fragment;
}

function getStepIngredientReferences(text) {
  const references = [];
  const seen = new Set();
  const ingredientPattern = /@([^{}\n]+?)\{([^}]*)\}|@([\p{L}\p{N}_'-]+)/gu;
  let match;
  while ((match = ingredientPattern.exec(text)) !== null) {
    const name = (match[1] || match[3]).trim();
    const key = name.toLocaleLowerCase('fr');
    if (seen.has(key)) continue;
    seen.add(key);
    references.push({ name, quantity: match[2]?.trim() || '' });
  }
  return references;
}

function formatIngredientQuantity(quantity) {
  return quantity
    .replace(/%/g, ' ')
    .replace(/^(\d+(?:[.,]\d+)?)(?=[a-zA-ZÀ-ÿ])/u, '$1 ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getRecipePreview(content) {
  const { ingredients, steps } = parseRecipeDisplay(content);
  if (steps.length) return cooklangToPlainText(steps.join(' ')).slice(0, 150);
  return ingredients.map(item => `${item.name}${item.quantity ? ` (${formatIngredientQuantity(item.quantity)})` : ''}`).join(', ').slice(0, 150);
}

function cooklangToPlainText(text) {
  return text
    .replace(/~([^{}\n]*)\{([^}]*)\}/gu, (_, name, duration) => {
      const cleanName = name.trim();
      const cleanDuration = duration.trim().replace(/%/g, ' ');
      return [cleanName, cleanDuration].filter(Boolean).join(' · ');
    })
    .replace(/@([^{}\n]+?)\{[^}]*\}/gu, (_, name) => name.trim())
    .replace(/@([\p{L}\p{N}_'-]+)/gu, '$1')
    .replace(/#([^{}\n]+?)\{[^}]*\}/gu, (_, name) => name.trim())
    .replace(/\s+/g, ' ')
    .trim();
}

function createRecipeDetailBody(recipe, selectedServings = recipe.servings || 1) {
  const { ingredients, steps } = parseRecipeDisplay(recipe.content);
  const factor = selectedServings / (recipe.servings || 1);
  const body = document.createElement('div');
  body.className = 'recipe-detail-body';

  const ingredientsPanel = document.createElement('section');
  ingredientsPanel.className = 'recipe-ings-panel';
  const ingredientsTitle = document.createElement('h3');
  ingredientsTitle.textContent = 'Ingrédients';
  const ingredientList = document.createElement('ul');
  ingredientList.className = 'ing-list';
  ingredients.forEach(ingredient => {
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'cooklang-ingredient-name';
    name.textContent = ingredient.name;
    item.append(name);
    if (ingredient.quantity) {
      const quantity = document.createElement('strong');
      quantity.textContent = formatIngredientQuantity(scaleIngredientQuantity(ingredient.quantity, factor));
      item.append(quantity);
    }
    ingredientList.append(item);
  });
  if (!ingredients.length) ingredientList.append(createMessage('Aucun ingrédient renseigné.'));
  ingredientsPanel.append(ingredientsTitle, ingredientList);

  const stepsPanel = document.createElement('section');
  stepsPanel.className = 'recipe-steps-panel';
  const stepsTitle = document.createElement('h3');
  stepsTitle.textContent = 'Préparation';
  const stepList = document.createElement('ol');
  stepList.className = 'recipe-step-list';
  steps.forEach(step => {
    const item = document.createElement('li');
    const instruction = document.createElement('div');
    instruction.className = 'recipe-step-instruction';
    instruction.append(renderCooklangText(step));
    item.append(instruction);

    const quantities = document.createElement('div');
    quantities.className = 'recipe-step-ingredients';
    getStepIngredientReferences(step).forEach(reference => {
      const listedIngredient = ingredients.find(ingredient =>
        ingredient.name.toLocaleLowerCase('fr') === reference.name.toLocaleLowerCase('fr')
      );
      const baseQuantity = reference.quantity || listedIngredient?.quantity || '';
      if (!baseQuantity) return;
      const badge = document.createElement('span');
      badge.className = 'recipe-step-ingredient';
      const badgeName = document.createElement('span');
      badgeName.textContent = reference.name;
      const badgeQuantity = document.createElement('strong');
      badgeQuantity.textContent = formatIngredientQuantity(scaleIngredientQuantity(baseQuantity, factor));
      badge.append(badgeName, badgeQuantity);
      quantities.append(badge);
    });
    if (quantities.childElementCount) item.append(quantities);
    stepList.append(item);
  });
  if (!steps.length) stepList.append(createMessage('Aucune étape renseignée.'));
  stepsPanel.append(stepsTitle, stepList);
  body.append(ingredientsPanel, stepsPanel);
  return body;
}

function openRecipe(id, selectedServings) {
  const recipe = recipes.find(item => item.id === id);
  if (!recipe) return;
  const baseServings = recipe.servings || 1;
  const currentServings = Math.max(1, selectedServings || baseServings);
  const detail = document.getElementById('recipe-detail');
  detail.replaceChildren();

  const header = document.createElement('div');
  header.className = 'recipe-detail-header';
  const title = document.createElement('h2');
  title.textContent = recipe.title;
  const badges = document.createElement('div');
  badges.className = 'recipe-detail-badges';
  const category = document.createElement('span');
  category.className = 'recipe-badge ing-badge';
  category.textContent = recipe.category || 'Non classée';
  const servings = document.createElement('span');
  servings.className = 'recipe-badge timer-badge';
  servings.textContent = `${currentServings} portion${currentServings > 1 ? 's' : ''}`;
  badges.append(category, servings);
  const author = document.createElement('span');
  author.className = 'recipe-badge';
  author.textContent = `Créateur : ${recipe.author || 'inconnu'}`;
  badges.append(author);
  header.append(title, badges);

  const servingsControl = document.createElement('div');
  servingsControl.className = 'recipe-servings-ctrl';
  const servingsLabel = document.createElement('span');
  servingsLabel.className = 'servings-label';
  servingsLabel.textContent = 'Adapter les portions :';
  const decrease = document.createElement('button');
  decrease.type = 'button';
  decrease.className = 'servings-btn';
  decrease.setAttribute('aria-label', 'Retirer une portion');
  decrease.textContent = '−';
  decrease.disabled = currentServings <= 1;
  decrease.addEventListener('click', () => openRecipe(id, currentServings - 1));
  const count = document.createElement('span');
  count.className = 'servings-count';
  count.textContent = String(currentServings);
  const increase = document.createElement('button');
  increase.type = 'button';
  increase.className = 'servings-btn';
  increase.setAttribute('aria-label', 'Ajouter une portion');
  increase.textContent = '+';
  increase.addEventListener('click', () => openRecipe(id, currentServings + 1));
  servingsControl.append(servingsLabel, decrease, count, increase);
  header.append(servingsControl);

  const body = createRecipeDetailBody(recipe, currentServings);

  const nutritionValues = recipe.nutrition || {};
  const nutritionItems = [
    ['Calories', nutritionValues.calories, 'kcal'], ['Protéines', nutritionValues.protein, 'g'],
    ['Glucides', nutritionValues.carbs, 'g'], ['Lipides', nutritionValues.fat, 'g'], ['Fibres', nutritionValues.fiber, 'g']
  ].filter(([, value]) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)));
  const nutritionPanel = document.createElement('section');
  nutritionPanel.className = 'nutrition-panel';
  if (recipe.nutritionStatus === 'incomplete') {
    const notice = document.createElement('p');
    notice.className = 'nutrition-estimate-message';
    notice.textContent = recipe.nutritionMessage || 'À compléter : choisissez les aliments CIQUAL et renseignez les quantités en grammes.';
    nutritionPanel.append(notice);
  } else if (nutritionItems.length) {
    const nutritionHeading = document.createElement('div');
    nutritionHeading.className = 'nutrition-heading';
    const nutritionTitle = document.createElement('h3');
    nutritionTitle.textContent = 'Nutrition estimée';
    const nutritionHint = document.createElement('span');
    nutritionHint.textContent = 'par portion';
    nutritionHeading.append(nutritionTitle, nutritionHint);
    const nutritionGrid = document.createElement('div');
    nutritionGrid.className = 'nutrition-values';
    nutritionItems.forEach(([label, value, unit]) => {
      const item = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = `${value} ${unit}`;
      const span = document.createElement('span');
      span.textContent = label;
      item.append(strong, span);
      nutritionGrid.append(item);
    });
    const disclaimer = document.createElement('small');
    disclaimer.textContent = 'Valeurs indicatives, variables selon les produits et la préparation.';
    nutritionPanel.append(nutritionHeading, nutritionGrid, disclaimer);
  }

  if (recipe.imageUrl) {
    const image = document.createElement('img');
    image.className = 'recipe-detail-image';
    image.src = recipe.imageUrl;
    image.alt = `Illustration de ${recipe.title}`;
    detail.append(header, image, body);
  } else {
    detail.append(header, body);
  }
  if (recipe.nutritionStatus === 'incomplete' || nutritionItems.length) detail.append(nutritionPanel);
  const actions = document.createElement('div');
  actions.className = 'recipe-actions';
  const share = document.createElement('button');
  share.className = 'secondary-btn recipe-detail-share-btn';
  share.setAttribute('aria-label', 'Partager cette recette pendant 24 heures');
  const shareIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  shareIcon.setAttribute('viewBox', '0 0 24 24');
  shareIcon.setAttribute('aria-hidden', 'true');
  shareIcon.classList.add('ios-share-icon');
  const shareArrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shareArrow.setAttribute('d', 'M12 15V3m0 0L7.5 7.5M12 3l4.5 4.5M6.5 11H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1.5');
  shareIcon.append(shareArrow);
  const shareLabel = document.createElement('span');
  shareLabel.textContent = 'Partager';
  share.append(shareIcon, shareLabel);
  share.addEventListener('click', () => shareRecipe(id, share));
  actions.append(share);
  const play = document.createElement('button');
  play.className = 'success-btn cooking-start-btn';
  play.textContent = '▶ Démarrer';
  play.addEventListener('click', () => openCookingMode(id, currentServings));
  actions.append(play);
  const addToShopping = document.createElement('button');
  addToShopping.className = 'secondary-btn';
  addToShopping.textContent = '🛒 Courses';
  addToShopping.addEventListener('click', () => addRecipeToShoppingList(recipe, currentServings, addToShopping));
  actions.append(addToShopping);
  if (recipe.canEdit) {
    const edit = document.createElement('button');
    edit.className = 'primary-btn';
    edit.textContent = 'Modifier';
    edit.addEventListener('click', () => showEditRecipeForm(id));
    const remove = document.createElement('button');
    remove.className = 'danger-btn';
    remove.textContent = 'Supprimer';
    remove.addEventListener('click', () => deleteRecipe(id));
    actions.append(edit, remove);
  }
  detail.append(actions);
  openModal('recipe-modal');
}

async function showSharedRecipe(token) {
  document.getElementById('login-page').classList.add('hidden');
  document.getElementById('register-page').classList.add('hidden');
  document.getElementById('main-page').classList.add('hidden');
  const page = document.getElementById('shared-recipe-page');
  const content = document.getElementById('shared-recipe-content');
  page.classList.remove('hidden');
  content.replaceChildren(createMessage('Chargement de la recette…'));
  try {
    const recipe = await apiRequest(`/api/shared-recipes/${encodeURIComponent(token)}`, { auth: false });
    document.title = `${recipe.title} – Goodwater Recipes`;
    const header = document.createElement('div');
    header.className = 'recipe-detail-header';
    const title = document.createElement('h1');
    title.textContent = recipe.title;
    const badges = document.createElement('div');
    badges.className = 'recipe-detail-badges';
    [recipe.category || 'Non classée', `${recipe.servings || 1} portion${recipe.servings > 1 ? 's' : ''}`, `Par ${recipe.author || 'inconnu'}`].forEach(text => {
      const badge = document.createElement('span');
      badge.className = 'recipe-badge';
      badge.textContent = text;
      badges.append(badge);
    });
    const expiry = document.createElement('p');
    expiry.className = 'shared-recipe-expiry';
    expiry.textContent = `Lien valable jusqu’au ${new Date(recipe.expiresAt).toLocaleString('fr-FR')}`;
    header.append(title, badges, expiry);
    const parts = [header];
    if (recipe.imageUrl) {
      const image = document.createElement('img');
      image.className = 'recipe-detail-image';
      image.src = recipe.imageUrl;
      image.alt = `Illustration de ${recipe.title}`;
      parts.push(image);
    }
    parts.push(createRecipeDetailBody(recipe));
    content.replaceChildren(...parts);
  } catch (error) {
    content.replaceChildren(createMessage(error.message, true));
  }
}

function openCookingMode(id, servings) {
  const recipe = recipes.find(item => item.id === id);
  if (!recipe) return;
  const steps = getCookingSteps(recipe.content);
  if (!steps.length) return window.alert('Cette recette ne contient aucune étape.');
  cookingRecipeId = id;
  cookingServings = Math.max(1, servings || recipe.servings || 1);
  cookingStepIndex = 0;
  document.getElementById('cooking-recipe-title').textContent = recipe.title;
  renderCookingStep();
  openModal('cooking-mode-modal');
}

function getCookingSteps(content) {
  return parseRecipeDisplay(content).steps.filter(step =>
    !/^bon\s+app[ée]tit\s*!*\s*$/i.test(step.trim())
  );
}

function renderCookingStep() {
  const recipe = recipes.find(item => item.id === cookingRecipeId);
  if (!recipe) return;
  const { ingredients } = parseRecipeDisplay(recipe.content);
  const steps = getCookingSteps(recipe.content);
  const factor = cookingServings / (recipe.servings || 1);
  const ingredientsBlock = document.getElementById('cooking-ingredients-block');
  const stepCard = document.querySelector('.cooking-step-card');
  const previous = document.getElementById('cooking-prev-btn');
  const next = document.getElementById('cooking-next-btn');

  if (cookingStepIndex >= steps.length) {
    stepCard.classList.add('cooking-complete');
    document.getElementById('cooking-progress-label').textContent = 'Recette terminée';
    document.getElementById('cooking-progress-bar').style.width = '100%';
    document.getElementById('cooking-step-number').textContent = '✓';
    document.getElementById('cooking-step-text').textContent = 'Bon appétit !!';
    ingredientsBlock.classList.add('hidden');
    previous.disabled = false;
    next.textContent = 'Fermer';
    return;
  }

  const step = steps[cookingStepIndex];
  const position = cookingStepIndex + 1;
  stepCard.classList.remove('cooking-complete');
  ingredientsBlock.classList.remove('hidden');
  document.getElementById('cooking-progress-label').textContent = `Étape ${position} sur ${steps.length}`;
  document.getElementById('cooking-progress-bar').style.width = `${position / steps.length * 100}%`;
  document.getElementById('cooking-step-number').textContent = String(position).padStart(2, '0');
  document.getElementById('cooking-step-text').replaceChildren(renderCooklangText(step));

  const ingredientContainer = document.getElementById('cooking-step-ingredients');
  ingredientContainer.replaceChildren();
  getStepIngredientReferences(step).forEach(reference => {
    const listedIngredient = ingredients.find(ingredient =>
      ingredient.name.toLocaleLowerCase('fr') === reference.name.toLocaleLowerCase('fr')
    );
    const baseQuantity = reference.quantity || listedIngredient?.quantity || '';
    const row = document.createElement('div');
    row.className = 'cooking-ingredient-row';
    const name = document.createElement('span');
    name.textContent = reference.name;
    const quantity = document.createElement('strong');
    quantity.textContent = baseQuantity
      ? formatIngredientQuantity(scaleIngredientQuantity(baseQuantity, factor))
      : 'selon votre goût';
    row.append(name, quantity);
    ingredientContainer.append(row);
  });
  if (!ingredientContainer.childElementCount) {
    ingredientContainer.append(createMessage('Aucun ingrédient nécessaire pour cette étape.'));
  }
  previous.disabled = cookingStepIndex === 0;
  next.textContent = cookingStepIndex === steps.length - 1 ? 'Terminer la recette ✓' : 'Étape suivante →';
}

function changeCookingStep(direction) {
  const recipe = recipes.find(item => item.id === cookingRecipeId);
  if (!recipe) return;
  const steps = getCookingSteps(recipe.content);
  if (direction > 0 && cookingStepIndex >= steps.length) {
    closeModal(document.getElementById('cooking-mode-modal'));
    return;
  }
  cookingStepIndex = Math.min(steps.length, Math.max(0, cookingStepIndex + direction));
  renderCookingStep();
}

function openModal(id) {
  const modal = document.getElementById(id);
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  if (id === 'recipe-form-modal') requestAnimationFrame(resizeAllRecipeSteps);
}

function closeModal(modal) {
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}

const NUTRITION_REFERENCE = [
  // Valeurs moyennes pour 100 g. Les aliments précis précèdent leurs familles génériques.
  { terms: ['beurre de cacahuete'], kcal: 588, protein: 25, carbs: 20, fat: 50, fiber: 6 },
  { terms: ['lait de coco'], kcal: 197, protein: 2, carbs: 2.8, fat: 21, fiber: 0 },
  { terms: ['farine de pois chiche'], kcal: 387, protein: 22, carbs: 58, fat: 6.7, fiber: 11 },
  { terms: ['farine complete'], kcal: 340, protein: 13, carbs: 62, fat: 2.5, fiber: 11 },
  { terms: ['riz complet'], kcal: 350, protein: 7.5, carbs: 72, fat: 2.7, fiber: 3.5 },
  { terms: ['pates completes', 'pate complete'], kcal: 348, protein: 13, carbs: 65, fat: 2.5, fiber: 8 },
  { terms: ['fromage blanc'], kcal: 75, protein: 8, carbs: 4, fat: 3.2, fiber: 0 },
  { terms: ['creme fraiche', 'creme liquide'], kcal: 292, protein: 2.1, carbs: 3, fat: 30, fiber: 0 },
  { terms: ['huile d olive', 'huille d olive'], kcal: 884, protein: 0, carbs: 0, fat: 100, fiber: 0 },
  { terms: ['huile de coco'], kcal: 892, protein: 0, carbs: 0, fat: 100, fiber: 0 },
  { terms: ['cuisse de poulet'], kcal: 209, protein: 26, carbs: 0, fat: 11, fiber: 0, pieceWeight: 200 },
  { terms: ['blanc de poulet', 'escalope de poulet'], kcal: 120, protein: 23, carbs: 0, fat: 2.6, fiber: 0 },
  { terms: ['echine de porc'], kcal: 263, protein: 17, carbs: 0, fat: 22, fiber: 0 },
  { terms: ['boeuf hache', 'steak hache'], kcal: 250, protein: 26, carbs: 0, fat: 17, fiber: 0, pieceWeight: 125 },
  { terms: ['saumon fume'], kcal: 184, protein: 22, carbs: 0, fat: 10, fiber: 0 },
  { terms: ['thon en boite', 'thon au naturel'], kcal: 116, protein: 26, carbs: 0, fat: 1, fiber: 0 },
  { terms: ['pois chiche', 'houmous'], kcal: 164, protein: 8.9, carbs: 27, fat: 2.6, fiber: 7.6 },
  { terms: ['haricot rouge'], kcal: 127, protein: 8.7, carbs: 23, fat: 0.5, fiber: 6.4 },
  { terms: ['haricot blanc'], kcal: 139, protein: 9.7, carbs: 25, fat: 0.4, fiber: 6.3 },
  { terms: ['lentille corail'], kcal: 352, protein: 25, carbs: 63, fat: 1.1, fiber: 11 },
  { terms: ['flocon d avoine', 'flocons d avoine'], kcal: 372, protein: 13, carbs: 60, fat: 7, fiber: 10 },
  { terms: ['cereales muesli', 'muesli'], kcal: 370, protein: 10, carbs: 64, fat: 7, fiber: 8 },
  { terms: ['noix de cajou'], kcal: 553, protein: 18, carbs: 30, fat: 44, fiber: 3.3 },
  { terms: ['noix de coco'], kcal: 354, protein: 3.3, carbs: 15, fat: 33, fiber: 9 },
  { terms: ['raisins secs'], kcal: 299, protein: 3.1, carbs: 79, fat: 0.5, fiber: 3.7 },
  { terms: ['tomate sechee'], kcal: 258, protein: 14, carbs: 56, fat: 3, fiber: 12 },
  { terms: ['pomme de terre', 'pommes de terre'], kcal: 77, protein: 2, carbs: 17, fat: 0.1, fiber: 2.2, pieceWeight: 170 },
  { terms: ['patate douce'], kcal: 86, protein: 1.6, carbs: 20, fat: 0.1, fiber: 3, pieceWeight: 200 },

  // Féculents, céréales et produits de boulangerie
  { terms: ['riz basmati', 'riz thai', 'riz'], kcal: 360, protein: 7, carbs: 79, fat: 0.7, fiber: 1.3 },
  { terms: ['pates', 'pate', 'spaghetti', 'macaroni', 'tagliatelle', 'penne'], kcal: 350, protein: 12, carbs: 72, fat: 1.5, fiber: 3 },
  { terms: ['semoule', 'couscous'], kcal: 360, protein: 12, carbs: 73, fat: 1.5, fiber: 4 },
  { terms: ['quinoa'], kcal: 368, protein: 14, carbs: 64, fat: 6.1, fiber: 7 },
  { terms: ['boulgour'], kcal: 342, protein: 12, carbs: 76, fat: 1.3, fiber: 18 },
  { terms: ['orge'], kcal: 354, protein: 12, carbs: 74, fat: 2.3, fiber: 17 },
  { terms: ['mais'], kcal: 86, protein: 3.3, carbs: 19, fat: 1.4, fiber: 2.7 },
  { terms: ['farine'], kcal: 364, protein: 10, carbs: 76, fat: 1, fiber: 2.7 },
  { terms: ['maizena', 'fecule de mais'], kcal: 381, protein: 0.3, carbs: 91, fat: 0.1, fiber: 0.9 },
  { terms: ['pain complet'], kcal: 247, protein: 13, carbs: 41, fat: 4.2, fiber: 7 },
  { terms: ['pain de mie'], kcal: 266, protein: 9, carbs: 49, fat: 3.3, fiber: 2.7 },
  { terms: ['pain', 'baguette'], kcal: 270, protein: 9, carbs: 57, fat: 1, fiber: 3 },
  { terms: ['chapelure', 'panure'], kcal: 395, protein: 13, carbs: 72, fat: 5.3, fiber: 4.5 },

  // Viandes, poissons et œufs
  { terms: ['poulet', 'dinde'], kcal: 165, protein: 31, carbs: 0, fat: 3.6, fiber: 0 },
  { terms: ['porc'], kcal: 242, protein: 27, carbs: 0, fat: 14, fiber: 0 },
  { terms: ['boeuf'], kcal: 250, protein: 26, carbs: 0, fat: 17, fiber: 0 },
  { terms: ['agneau'], kcal: 294, protein: 25, carbs: 0, fat: 21, fiber: 0 },
  { terms: ['veau'], kcal: 172, protein: 24, carbs: 0, fat: 8, fiber: 0 },
  { terms: ['jambon'], kcal: 145, protein: 21, carbs: 1.5, fat: 6, fiber: 0 },
  { terms: ['lardon', 'bacon'], kcal: 320, protein: 17, carbs: 1, fat: 28, fiber: 0 },
  { terms: ['saucisse', 'merguez'], kcal: 300, protein: 16, carbs: 2, fat: 26, fiber: 0 },
  { terms: ['saumon'], kcal: 208, protein: 20, carbs: 0, fat: 13, fiber: 0 },
  { terms: ['thon'], kcal: 144, protein: 23, carbs: 0, fat: 5, fiber: 0 },
  { terms: ['cabillaud', 'colin'], kcal: 82, protein: 18, carbs: 0, fat: 0.7, fiber: 0 },
  { terms: ['sardine'], kcal: 208, protein: 25, carbs: 0, fat: 11, fiber: 0 },
  { terms: ['crevette'], kcal: 99, protein: 24, carbs: 0.2, fat: 0.3, fiber: 0 },
  { terms: ['oeuf'], kcal: 143, protein: 13, carbs: 0.7, fat: 9.5, fiber: 0, pieceWeight: 55 },

  // Légumineuses, tofu, laitages et fromages
  { terms: ['lentille'], kcal: 116, protein: 9, carbs: 20, fat: 0.4, fiber: 7.9 },
  { terms: ['petit pois'], kcal: 81, protein: 5.4, carbs: 14, fat: 0.4, fiber: 5.7 },
  { terms: ['tofu'], kcal: 144, protein: 17, carbs: 2.8, fat: 8.7, fiber: 2.3 },
  { terms: ['lait'], kcal: 47, protein: 3.3, carbs: 4.8, fat: 1.6, fiber: 0 },
  { terms: ['yaourt grec'], kcal: 97, protein: 9, carbs: 3.9, fat: 5, fiber: 0 },
  { terms: ['yaourt'], kcal: 61, protein: 3.5, carbs: 4.7, fat: 3.3, fiber: 0 },
  { terms: ['mascarpone'], kcal: 429, protein: 4.6, carbs: 4, fat: 44, fiber: 0 },
  { terms: ['mozzarella'], kcal: 280, protein: 28, carbs: 3.1, fat: 17, fiber: 0 },
  { terms: ['parmesan'], kcal: 431, protein: 38, carbs: 4.1, fat: 29, fiber: 0 },
  { terms: ['emmental', 'gruyere'], kcal: 395, protein: 29, carbs: 0.4, fat: 31, fiber: 0 },
  { terms: ['feta'], kcal: 264, protein: 14, carbs: 4.1, fat: 21, fiber: 0 },
  { terms: ['chevre'], kcal: 330, protein: 22, carbs: 2, fat: 27, fiber: 0 },
  { terms: ['fromage'], kcal: 350, protein: 24, carbs: 2, fat: 28, fiber: 0 },

  // Légumes et champignons
  { terms: ['tomate'], kcal: 18, protein: 0.9, carbs: 3.9, fat: 0.2, fiber: 1.2, pieceWeight: 120 },
  { terms: ['oignon'], kcal: 40, protein: 1.1, carbs: 9.3, fat: 0.1, fiber: 1.7, pieceWeight: 100 },
  { terms: ['echalote'], kcal: 72, protein: 2.5, carbs: 17, fat: 0.1, fiber: 3.2, pieceWeight: 30 },
  { terms: ['ail', 'gousse d ail'], kcal: 149, protein: 6.4, carbs: 33, fat: 0.5, fiber: 2.1, pieceWeight: 5 },
  { terms: ['carotte'], kcal: 41, protein: 0.9, carbs: 10, fat: 0.2, fiber: 2.8, pieceWeight: 100 },
  { terms: ['courgette'], kcal: 17, protein: 1.2, carbs: 3.1, fat: 0.3, fiber: 1, pieceWeight: 200 },
  { terms: ['aubergine'], kcal: 25, protein: 1, carbs: 6, fat: 0.2, fiber: 3, pieceWeight: 250 },
  { terms: ['poivron'], kcal: 31, protein: 1, carbs: 6, fat: 0.3, fiber: 2.1, pieceWeight: 150 },
  { terms: ['brocoli'], kcal: 34, protein: 2.8, carbs: 7, fat: 0.4, fiber: 2.6 },
  { terms: ['chou fleur'], kcal: 25, protein: 1.9, carbs: 5, fat: 0.3, fiber: 2 },
  { terms: ['chou'], kcal: 25, protein: 1.3, carbs: 5.8, fat: 0.1, fiber: 2.5 },
  { terms: ['epinard'], kcal: 23, protein: 2.9, carbs: 3.6, fat: 0.4, fiber: 2.2 },
  { terms: ['salade', 'laitue'], kcal: 15, protein: 1.4, carbs: 2.9, fat: 0.2, fiber: 1.3 },
  { terms: ['concombre'], kcal: 15, protein: 0.7, carbs: 3.6, fat: 0.1, fiber: 0.5, pieceWeight: 300 },
  { terms: ['champignon'], kcal: 22, protein: 3.1, carbs: 3.3, fat: 0.3, fiber: 1 },
  { terms: ['poireau'], kcal: 61, protein: 1.5, carbs: 14, fat: 0.3, fiber: 1.8, pieceWeight: 150 },
  { terms: ['celeri'], kcal: 16, protein: 0.7, carbs: 3, fat: 0.2, fiber: 1.6 },
  { terms: ['avocat'], kcal: 160, protein: 2, carbs: 8.5, fat: 15, fiber: 6.7, pieceWeight: 150 },
  { terms: ['olive'], kcal: 145, protein: 1, carbs: 3.8, fat: 15, fiber: 3.3, pieceWeight: 4 },

  // Fruits
  { terms: ['pomme'], kcal: 52, protein: 0.3, carbs: 14, fat: 0.2, fiber: 2.4, pieceWeight: 150 },
  { terms: ['banane'], kcal: 89, protein: 1.1, carbs: 23, fat: 0.3, fiber: 2.6, pieceWeight: 120 },
  { terms: ['poire'], kcal: 57, protein: 0.4, carbs: 15, fat: 0.1, fiber: 3.1, pieceWeight: 160 },
  { terms: ['orange'], kcal: 47, protein: 0.9, carbs: 12, fat: 0.1, fiber: 2.4, pieceWeight: 150 },
  { terms: ['citron'], kcal: 29, protein: 1.1, carbs: 9, fat: 0.3, fiber: 2.8, pieceWeight: 80 },
  { terms: ['fraise'], kcal: 32, protein: 0.7, carbs: 7.7, fat: 0.3, fiber: 2 },
  { terms: ['framboise'], kcal: 52, protein: 1.2, carbs: 12, fat: 0.7, fiber: 6.5 },
  { terms: ['myrtille'], kcal: 57, protein: 0.7, carbs: 14, fat: 0.3, fiber: 2.4 },
  { terms: ['mangue'], kcal: 60, protein: 0.8, carbs: 15, fat: 0.4, fiber: 1.6, pieceWeight: 200 },
  { terms: ['ananas'], kcal: 50, protein: 0.5, carbs: 13, fat: 0.1, fiber: 1.4 },
  { terms: ['peche', 'nectarine'], kcal: 39, protein: 0.9, carbs: 10, fat: 0.3, fiber: 1.5, pieceWeight: 140 },
  { terms: ['abricot'], kcal: 48, protein: 1.4, carbs: 11, fat: 0.4, fiber: 2, pieceWeight: 45 },
  { terms: ['raisin'], kcal: 69, protein: 0.7, carbs: 18, fat: 0.2, fiber: 0.9 },

  // Matières grasses, graines, condiments et pâtisserie
  { terms: ['beurre'], kcal: 717, protein: 0.9, carbs: 0.1, fat: 81, fiber: 0 },
  { terms: ['margarine'], kcal: 717, protein: 0.2, carbs: 0.7, fat: 80, fiber: 0 },
  { terms: ['huile', 'huille'], kcal: 884, protein: 0, carbs: 0, fat: 100, fiber: 0 },
  { terms: ['amande'], kcal: 579, protein: 21, carbs: 22, fat: 50, fiber: 12.5 },
  { terms: ['noisette'], kcal: 628, protein: 15, carbs: 17, fat: 61, fiber: 9.7 },
  { terms: ['noix'], kcal: 654, protein: 15, carbs: 14, fat: 65, fiber: 6.7 },
  { terms: ['cacahuete'], kcal: 567, protein: 26, carbs: 16, fat: 49, fiber: 8.5 },
  { terms: ['graine de chia'], kcal: 486, protein: 17, carbs: 42, fat: 31, fiber: 34 },
  { terms: ['graine de sesame', 'sesame'], kcal: 573, protein: 18, carbs: 23, fat: 50, fiber: 12 },
  { terms: ['sucre roux', 'cassonade', 'sucre'], kcal: 400, protein: 0, carbs: 100, fat: 0, fiber: 0 },
  { terms: ['miel'], kcal: 304, protein: 0.3, carbs: 82, fat: 0, fiber: 0 },
  { terms: ['chocolat noir'], kcal: 598, protein: 7.8, carbs: 46, fat: 43, fiber: 11 },
  { terms: ['chocolat au lait'], kcal: 535, protein: 7.7, carbs: 59, fat: 30, fiber: 3.4 },
  { terms: ['cacao'], kcal: 228, protein: 20, carbs: 58, fat: 14, fiber: 33 },
  { terms: ['confiture'], kcal: 250, protein: 0.4, carbs: 65, fat: 0.1, fiber: 1 },
  { terms: ['moutarde'], kcal: 66, protein: 4.4, carbs: 5.8, fat: 3.3, fiber: 4 },
  { terms: ['mayonnaise'], kcal: 680, protein: 1, carbs: 1, fat: 75, fiber: 0 },
  { terms: ['ketchup'], kcal: 112, protein: 1.3, carbs: 26, fat: 0.2, fiber: 0.3 },
  { terms: ['sauce soja'], kcal: 53, protein: 8, carbs: 4.9, fat: 0.6, fiber: 0.8 },
  { terms: ['fond de veau en poudre', 'fond de veau'], kcal: 250, protein: 16, carbs: 18, fat: 13, fiber: 0 },
  { terms: ['bouillon'], kcal: 250, protein: 16, carbs: 18, fat: 13, fiber: 0, pieceWeight: 10 },
  { terms: ['levure'], kcal: 325, protein: 40, carbs: 41, fat: 7.6, fiber: 27 },
  { terms: ['sel', 'eau'], kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 },
  { terms: ['poivre'], kcal: 251, protein: 10, carbs: 64, fat: 3.3, fiber: 25 },
  { terms: ['cumin'], kcal: 375, protein: 18, carbs: 44, fat: 22, fiber: 10.5 },
  { terms: ['curcuma'], kcal: 312, protein: 9.7, carbs: 67, fat: 3.3, fiber: 22.7 },
  { terms: ['curry'], kcal: 325, protein: 14, carbs: 56, fat: 14, fiber: 53 },
  { terms: ['gingembre'], kcal: 80, protein: 1.8, carbs: 18, fat: 0.8, fiber: 2 },
  { terms: ['piment'], kcal: 40, protein: 1.9, carbs: 8.8, fat: 0.4, fiber: 1.5 },
  { terms: ['epices mexicaines', 'melange d epices', 'persil', 'basilic', 'coriandre', 'thym'], kcal: 36, protein: 3, carbs: 6, fat: 0.8, fiber: 3 }
];

function findNutritionReference(ingredientName) {
  const name = normalizeRecipeSearch(ingredientName);
  if (!name) return null;
  return NUTRITION_REFERENCE
    .flatMap(item => item.terms.map(term => ({ item, term })))
    .filter(({ term }) => {
      const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?:^|\\s)${escapedTerm}(?:s|x)?(?:$|\\s)`).test(name);
    })
    .sort((a, b) => b.term.length - a.term.length)[0] || null;
}

function parseNutritionMeasure(quantity, unit = '') {
  const rawQuantity = normalizeRecipeSearch(String(quantity).replace(',', '.'));
  const match = rawQuantity.match(/^\s*(\d+(?:\.\d+)?)\s*([a-z]+)?\s*$/);
  if (!match) return null;
  const amount = Number.parseFloat(match[1]);
  const normalizedUnit = normalizeRecipeSearch(unit || match[2] || '')
    .replace(/^(grammes?|gr)$/, 'g')
    .replace(/^(kilogrammes?|kilos?)$/, 'kg')
    .replace(/^(millilitres?)$/, 'ml')
    .replace(/^(centilitres?)$/, 'cl')
    .replace(/^(litres?)$/, 'l')
    .replace(/^(cuilleres? a soupe|c\.?(?:a|à)\.?s\.?|cas|tbsp)$/, 'càs')
    .replace(/^(cuilleres? a cafe|c\.?(?:a|à)\.?c\.?|cac|tsp)$/, 'càc')
    .replace(/^(pieces?|unites?)$/, 'piece');
  return { amount, unit: normalizedUnit };
}

function getNutritionForm() {
  const read = id => {
    const value = Number.parseFloat(document.getElementById(id).value);
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  return {
    calories: read('nutrition-calories'), protein: read('nutrition-protein'), carbs: read('nutrition-carbs'),
    fat: read('nutrition-fat'), fiber: read('nutrition-fiber')
  };
}

function setNutritionForm(nutrition = {}) {
  for (const [key, id] of Object.entries({ calories: 'nutrition-calories', protein: 'nutrition-protein', carbs: 'nutrition-carbs', fat: 'nutrition-fat', fiber: 'nutrition-fiber' })) {
    document.getElementById(id).value = nutrition[key] ?? '';
  }
}

function loadCiqualDataset() {
  if (!nutritionDatasetPromise) {
    nutritionDatasetPromise = fetch('/data/ciqual-2025.json')
      .then(response => {
        if (!response.ok) throw new Error(`Impossible de charger la base CIQUAL (${response.status}).`);
        return response.json();
      })
      .then(data => {
        if (!Array.isArray(data.foods) || !data.foods.length) throw new Error('La base CIQUAL est vide ou invalide.');
        return data.foods;
      })
      .catch(error => {
        nutritionDatasetPromise = null;
        throw error;
      });
  }
  return nutritionDatasetPromise;
}

async function updateCiqualOptions(row, selectedCode = '') {
  const select = row.querySelector('.recipe-ingredient-food');
  const name = row.querySelector('.recipe-ingredient-food-query').value.trim();
  if (!name && !selectedCode) {
    select.replaceChildren(new Option('Choisir une fiche CIQUAL…', ''));
    updateNutritionRecognition(row);
    return;
  }
  const foods = await loadCiqualDataset();
  if (!row.isConnected) return;

  const matches = GoodwaterNutrition.searchFoods(name, foods);
  select.replaceChildren(new Option('Choisir une fiche CIQUAL…', ''));
  matches.forEach(food => {
    const option = new Option(`${food.name} — ${food.kcal} kcal/100 g`, food.code);
    select.add(option);
  });
  if (selectedCode && !matches.some(food => String(food.code) === String(selectedCode))) {
    const savedFood = foods.find(food => String(food.code) === String(selectedCode));
    if (savedFood) select.add(new Option(`${savedFood.name} — ${savedFood.kcal} kcal/100 g`, savedFood.code));
  }
  select.value = String(selectedCode || '');
  updateNutritionRecognition(row);
}

function updateNutritionRecognition(row) {
  const select = row.querySelector('.recipe-ingredient-food');
  const recognition = row.querySelector('.recipe-ingredient-recognition');
  const selected = select.value;
  recognition.classList.toggle('is-recognized', Boolean(selected));
  recognition.classList.toggle('is-unrecognized', !selected);
  recognition.textContent = selected ? '✓' : '?';
  const message = selected
    ? `Aliment CIQUAL sélectionné : ${select.selectedOptions[0]?.textContent || ''}`
    : 'Choisissez explicitement l’aliment correspondant dans la liste CIQUAL';
  recognition.title = message;
  recognition.setAttribute('aria-label', message);
}

function markNutritionEstimateStale() {
  if (!nutritionEstimated) return;
  nutritionEstimated = false;
  setNutritionForm({});
  document.getElementById('nutrition-estimate-message').textContent =
    'Les ingrédients ou quantités ont changé. Relancez le calcul nutritionnel.';
}

async function estimateRecipeNutrition() {
  const message = document.getElementById('nutrition-estimate-message');
  message.textContent = '';
  try {
    const foods = await loadCiqualDataset();
    const result = GoodwaterNutrition.estimate(
      collectRecipeIngredients(),
      foods,
      Number(document.getElementById('recipe-form-servings').value)
    );
    if (!result.complete) {
      message.textContent = `Calcul non effectué :\n${result.issues.join('\n')}`;
      nutritionEstimated = false;
      return;
    }

    setNutritionForm({
      calories: result.perServing.kcal,
      protein: result.perServing.protein,
      carbs: result.perServing.carbs,
      fat: result.perServing.fat,
      fiber: result.perServing.fiber
    });
    nutritionEstimated = true;
    message.textContent = 'Estimation calculée à partir de la table Ciqual 2025, par portion.';
  } catch (error) {
    message.textContent = error.message;
    nutritionEstimated = false;
  }
}

function showAddRecipeForm() {
  editingRecipeId = null;
  nutritionEstimated = false;
  document.getElementById('recipe-form-title').textContent = 'Nouvelle recette';
  document.getElementById('recipe-form').reset();
  document.getElementById('recipe-form-servings').value = '1';
  document.getElementById('nutrition-estimate-message').textContent = '';
  setNutritionForm({});
  resetRecipeIngredientBuilder();
  resetRecipeStepsBuilder();
  resetRecipePhotoEditor();
  openModal('recipe-form-modal');
  document.getElementById('recipe-form-title-input').focus();
}

function showEditRecipeForm(id) {
  const recipe = recipes.find(item => item.id === id);
  if (!recipe) return;
  editingRecipeId = id;
  nutritionEstimated = recipe.nutritionStatus === 'ciqual';
  closeModal(document.getElementById('recipe-modal'));
  document.getElementById('recipe-form-title').textContent = 'Modifier la recette';
  document.getElementById('recipe-form-title-input').value = recipe.title;
  const parsed = parseRecipeDisplay(recipe.content);
  resetRecipeIngredientBuilder(parsed.ingredients, recipe.nutritionFoods || []);
  resetRecipeStepsBuilder(parsed.steps.map(cooklangToPlainText));
  document.getElementById('recipe-form-category').value = recipe.category || '';
  document.getElementById('recipe-form-servings').value = recipe.servings || 1;
  setNutritionForm(recipe.nutrition || {});
  document.getElementById('nutrition-estimate-message').textContent = recipe.nutritionStatus === 'incomplete'
    ? recipe.nutritionMessage || 'À compléter : choisissez les aliments CIQUAL et renseignez les quantités en grammes.'
    : '';
  resetRecipePhotoEditor(recipe.imageUrl);
  openModal('recipe-form-modal');
}

function hideRecipeForm() {
  closeModal(document.getElementById('recipe-form-modal'));
  editingRecipeId = null;
}

async function saveRecipe(event) {
  event.preventDefault();
  const title = document.getElementById('recipe-form-title-input').value.trim();
  const steps = collectRecipeSteps();
  const ingredients = collectRecipeIngredients();
  const category = document.getElementById('recipe-form-category').value;
  const servings = document.getElementById('recipe-form-servings').value;
  const nutrition = getNutritionForm();
  if (!title || !steps.length || !ingredients.length) {
    return window.alert('Ajoutez au moins un ingrédient et la préparation.');
  }
  const nutritionStatus = nutritionEstimated ? 'ciqual' : Object.values(nutrition).some(value => value !== null) ? 'manual' : 'incomplete';
  const nutritionMessage = nutritionStatus === 'incomplete'
    ? 'À compléter : choisissez un aliment CIQUAL et renseignez une quantité en grammes pour chaque ingrédient.'
    : nutritionStatus === 'manual' ? 'Valeurs saisies manuellement, non vérifiées par CIQUAL.' : '';
  const content = withRecipeMetadata(
    buildGuidedRecipeContent(ingredients, steps),
    category,
    servings,
    nutrition,
    ingredients.map(ingredient => ingredient.ciqualCode),
    nutritionStatus,
    nutritionMessage
  );

  const url = editingRecipeId ? `/api/recipes/${encodeURIComponent(editingRecipeId)}` : '/api/recipes';
  const method = editingRecipeId ? 'PUT' : 'POST';
  const photo = pendingRecipePhotoBlob || document.getElementById('recipe-form-photo').files[0];
  const submitButton = event.submitter || event.currentTarget.querySelector('[type="submit"]');
  try {
    submitButton.disabled = true;
    const savedRecipe = await apiRequest(url, { method, body: JSON.stringify({ title, content }) });
    const recipeId = editingRecipeId || savedRecipe.id;
    if (!editingRecipeId) {
      editingRecipeId = recipeId;
      document.getElementById('recipe-form-title').textContent = 'Modifier la recette';
    }
    if (photo) {
      setRecipePhotoStatus('Enregistrement de la photo…');
      const image = await cropRecipePhoto(photo);
      await uploadRecipePhoto(recipeId, image);
    }
    hideRecipeForm();
    await loadRecipes();
  } catch (error) {
    window.alert(error.message);
    setRecipePhotoStatus(error.message, true);
  } finally {
    submitButton.disabled = false;
  }
}

function resetRecipePhotoEditor(imageUrl = null) {
  const input = document.getElementById('recipe-form-photo');
  input.value = '';
  pendingRecipePhotoBlob = null;
  showRecipePhoto(imageUrl);
  document.getElementById('remove-recipe-photo-btn').classList.toggle('hidden', !imageUrl);
  document.getElementById('illustrate-recipe-photo-btn').classList.toggle('hidden', !imageUrl || !editingRecipeId);
  setRecipePhotoStatus('La photo sera recadrée automatiquement au format 4:3.');
}

function showRecipePhoto(imageUrl = null) {
  const preview = document.getElementById('recipe-photo-preview');
  preview.replaceChildren();
  if (imageUrl) {
    const image = document.createElement('img');
    image.src = imageUrl;
    image.alt = 'Photo actuelle de la recette';
    preview.append(image);
  } else {
    const placeholder = document.createElement('span');
    placeholder.textContent = 'Ajoutez une photo du plat';
    preview.append(placeholder);
  }
}

function setRecipePhotoStatus(message, isError = false) {
  const status = document.getElementById('recipe-photo-status');
  status.textContent = message;
  status.classList.toggle('error', isError);
}

async function previewSelectedRecipePhoto() {
  const file = document.getElementById('recipe-form-photo').files[0];
  if (!file) return resetRecipePhotoEditor(editingRecipeId
    ? recipes.find(recipe => recipe.id === editingRecipeId)?.imageUrl
    : null);
  if (file.size > 12 * 1024 * 1024) {
    document.getElementById('recipe-form-photo').value = '';
    setRecipePhotoStatus('La photo source ne doit pas dépasser 12 Mo.', true);
    return;
  }
  try {
    setRecipePhotoStatus('Préparation de l’aperçu…');
    pendingRecipePhotoBlob = await cropRecipePhoto(file);
    showRecipePhotoBlob(pendingRecipePhotoBlob);
    document.getElementById('remove-recipe-photo-btn').classList.remove('hidden');
    document.getElementById('illustrate-recipe-photo-btn').classList.remove('hidden');
  } catch (error) {
    pendingRecipePhotoBlob = null;
    setRecipePhotoStatus('Ce format d’image ne peut pas être prévisualisé. Essayez une photo JPEG, PNG ou WebP.', true);
    return;
  }
  if (!editingRecipeId) {
    setRecipePhotoStatus('Aperçu prêt. Vous pouvez uniformiser la photo avec l’IA avant d’enregistrer.');
    return;
  }
  try {
    setRecipePhotoStatus('Téléchargement de la photo…');
    const result = await uploadRecipePhoto(editingRecipeId, pendingRecipePhotoBlob);
    const recipe = recipes.find(item => item.id === editingRecipeId);
    if (recipe) recipe.imageUrl = result.imageUrl;
    document.getElementById('recipe-form-photo').value = '';
    pendingRecipePhotoBlob = null;
    showRecipePhoto(result.imageUrl);
    document.getElementById('illustrate-recipe-photo-btn').classList.remove('hidden');
    setRecipePhotoStatus('Photo enregistrée. Vous pouvez maintenant l’uniformiser avec l’IA.');
  } catch (error) {
    setRecipePhotoStatus(error.message, true);
    window.alert(error.message);
  }
}

function showRecipePhotoBlob(blob) {
  const imageUrl = URL.createObjectURL(blob);
  showRecipePhoto(imageUrl);
  const image = document.querySelector('#recipe-photo-preview img');
  if (image) image.onload = () => URL.revokeObjectURL(imageUrl);
}

function loadRecipePhotoInImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Format d’image non pris en charge')); };
    image.src = url;
  });
}

async function cropRecipePhoto(file) {
  let source;
  if (typeof createImageBitmap === 'function') {
    try {
      source = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      try { source = await createImageBitmap(file); } catch { /* Repli compatible ci-dessous. */ }
    }
  }
  if (!source) source = await loadRecipePhotoInImageElement(file);
  const targetWidth = 508;
  const targetHeight = 381;
  const sourceRatio = source.width / source.height;
  const targetRatio = targetWidth / targetHeight;
  const sourceWidth = sourceRatio > targetRatio ? source.height * targetRatio : source.width;
  const sourceHeight = sourceRatio > targetRatio ? source.height : source.width / targetRatio;
  const sourceX = (source.width - sourceWidth) / 2;
  const sourceY = (source.height - sourceHeight) / 2;
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  canvas.getContext('2d').drawImage(source, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, targetWidth, targetHeight);
  if (typeof source.close === 'function') source.close();
  return new Promise((resolve, reject) => canvas.toBlob(
    blob => blob ? resolve(blob) : reject(new Error('Impossible de préparer la photo.')),
    'image/jpeg',
    0.86
  ));
}

async function uploadRecipePhoto(recipeId, image) {
  const response = await fetch(`/api/recipes/${encodeURIComponent(recipeId)}/image?ai=false`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${getToken()}`,
      'Content-Type': image.type
    },
    body: image
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Impossible d’enregistrer la photo.');
  return result;
}

async function illustrateCurrentRecipePhoto() {
  const button = document.getElementById('illustrate-recipe-photo-btn');
  const label = button.querySelector('.recipe-ai-button-label');
  const spinner = button.querySelector('.recipe-ai-spinner');
  try {
    button.disabled = true;
    label.textContent = 'Transformation en cours…';
    spinner.classList.remove('hidden');
    setRecipePhotoStatus('L’IA uniformise la photo, cela peut prendre quelques secondes…');
    if (!editingRecipeId) {
      const title = document.getElementById('recipe-form-title-input').value.trim();
      if (!title) throw new Error('Indiquez d’abord le titre de la recette.');
      if (!pendingRecipePhotoBlob) throw new Error('Sélectionnez d’abord une photo.');
      const response = await fetch(`/api/recipe-image-preview/illustrate?title=${encodeURIComponent(title)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': pendingRecipePhotoBlob.type || 'image/jpeg' },
        body: pendingRecipePhotoBlob
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || 'Impossible d’uniformiser cette photo.');
      }
      pendingRecipePhotoBlob = await response.blob();
      showRecipePhotoBlob(pendingRecipePhotoBlob);
    } else {
      const result = await apiRequest(`/api/recipes/${encodeURIComponent(editingRecipeId)}/image/illustrate`, { method: 'POST' });
      const recipe = recipes.find(item => item.id === editingRecipeId);
      if (recipe) recipe.imageUrl = result.imageUrl;
      showRecipePhoto(result.imageUrl);
    }
    setRecipePhotoStatus(editingRecipeId
      ? 'Illustration créée et enregistrée.'
      : 'Illustration prête. Elle sera enregistrée avec la nouvelle recette.');
  } catch (error) {
    setRecipePhotoStatus(error.message, true);
    window.alert(error.message);
  } finally {
    button.disabled = false;
    label.textContent = '✨ Uniformiser avec l’IA';
    spinner.classList.add('hidden');
  }
}

async function removeCurrentRecipePhoto() {
  const input = document.getElementById('recipe-form-photo');
  if (!editingRecipeId) {
    input.value = '';
    resetRecipePhotoEditor();
    return;
  }
  if (!await goodwaterConfirm('Supprimer la photo de cette recette ?')) return;
  try {
    await apiRequest(`/api/recipes/${encodeURIComponent(editingRecipeId)}/image`, { method: 'DELETE' });
    const recipe = recipes.find(item => item.id === editingRecipeId);
    if (recipe) recipe.imageUrl = null;
    resetRecipePhotoEditor();
  } catch (error) {
    window.alert(error.message);
  }
}

function resetRecipeIngredientBuilder(ingredients = [], nutritionFoods = []) {
  const container = document.getElementById('recipe-ingredients-builder');
  container.replaceChildren();
  const rows = ingredients.length ? ingredients : [{ name: '', quantity: '', unit: '' }];
  rows.forEach((ingredient, index) => {
    const rawMeasure = String(ingredient.quantity || '');
    const [quantityPart = '', ...unitParts] = rawMeasure.split('%');
    const compactMeasure = quantityPart.match(/^\s*(\d+(?:[.,]\d+)?)\s*([a-zA-ZÀ-ÿ]+)\s*$/);
    addRecipeIngredientRow({
      name: ingredient.name || '',
      quantity: compactMeasure?.[1] || quantityPart,
      unit: ingredient.unit || unitParts.join(' ') || compactMeasure?.[2] || '',
      ciqualCode: nutritionFoods[index] || ''
    });
  });
}

function addRecipeIngredientRow(ingredient = {}) {
  const container = document.getElementById('recipe-ingredients-builder');
  const row = document.createElement('div');
  row.className = 'recipe-ingredient-row';
  row.innerHTML = `
    <input class="recipe-ingredient-name" type="text" placeholder="Nom (ex. oignon)" aria-label="Nom de l’ingrédient">
    <span class="recipe-ingredient-recognition" role="img" aria-label="Saisissez un ingrédient" title="Saisissez un ingrédient">•</span>
    <input class="recipe-ingredient-food-query" type="search" placeholder="Rechercher dans CIQUAL" aria-label="Rechercher un aliment dans CIQUAL">
    <select class="recipe-ingredient-food" aria-label="Aliment de référence CIQUAL"><option value="">Choisir une fiche CIQUAL…</option></select>
    <input class="recipe-ingredient-quantity" type="text" placeholder="Quantité" aria-label="Quantité">
    <input class="recipe-ingredient-unit" type="text" placeholder="Unité (facultatif)" aria-label="Unité">
    <button type="button" class="recipe-ingredient-remove" aria-label="Supprimer cet ingrédient">×</button>`;
  const nameInput = row.querySelector('.recipe-ingredient-name');
  const recognition = row.querySelector('.recipe-ingredient-recognition');
  const foodQuery = row.querySelector('.recipe-ingredient-food-query');
  const foodSelect = row.querySelector('.recipe-ingredient-food');
  nameInput.value = ingredient.name || '';
  foodQuery.value = ingredient.name || '';
  nameInput.addEventListener('input', () => {
    markNutritionEstimateStale();
    if (foodQuery.dataset.manuallyEdited !== 'true') foodQuery.value = nameInput.value;
    foodSelect.replaceChildren(new Option('Choisir une fiche CIQUAL…', ''));
    updateNutritionRecognition(row);
    updateCiqualOptions(row).catch(error => {
      recognition.title = error.message;
      recognition.setAttribute('aria-label', error.message);
    });
  });
  foodQuery.addEventListener('input', () => {
    foodQuery.dataset.manuallyEdited = 'true';
    markNutritionEstimateStale();
    foodSelect.replaceChildren(new Option('Choisir une fiche CIQUAL…', ''));
    updateNutritionRecognition(row);
    updateCiqualOptions(row).catch(error => {
      recognition.title = error.message;
      recognition.setAttribute('aria-label', error.message);
    });
  });
  foodSelect.addEventListener('change', () => {
    markNutritionEstimateStale();
    updateNutritionRecognition(row);
  });
  const quantityInput = row.querySelector('.recipe-ingredient-quantity');
  const unitInput = row.querySelector('.recipe-ingredient-unit');
  quantityInput.value = ingredient.quantity || '';
  unitInput.value = ingredient.unit || '';
  quantityInput.addEventListener('input', markNutritionEstimateStale);
  unitInput.addEventListener('input', markNutritionEstimateStale);
  row.querySelector('.recipe-ingredient-remove').addEventListener('click', () => {
    row.remove();
    if (!container.children.length) addRecipeIngredientRow();
  });
  container.append(row);
  updateCiqualOptions(row, ingredient.ciqualCode || '').catch(error => {
    recognition.title = error.message;
    recognition.setAttribute('aria-label', error.message);
  });
}

function collectRecipeIngredients() {
  return [...document.querySelectorAll('.recipe-ingredient-row')]
    .map(row => ({
      name: row.querySelector('.recipe-ingredient-name').value.trim(),
      quantity: row.querySelector('.recipe-ingredient-quantity').value.trim(),
      unit: row.querySelector('.recipe-ingredient-unit').value.trim(),
      ciqualCode: row.querySelector('.recipe-ingredient-food').value
    }))
    .filter(ingredient => ingredient.name);
}

function resetRecipeStepsBuilder(steps = []) {
  const container = document.getElementById('recipe-steps-builder');
  container.replaceChildren();
  (steps.length ? steps : ['']).forEach(step => addRecipeStepRow(step));
}

function addRecipeStepRow(value = '') {
  const container = document.getElementById('recipe-steps-builder');
  const row = document.createElement('div');
  row.className = 'recipe-step-row';
  row.innerHTML = `
    <span class="recipe-step-index" aria-hidden="true"></span>
    <div class="recipe-step-input-wrap">
      <textarea class="recipe-step-input" rows="1" required placeholder="Décrivez cette étape…" aria-label="Étape de préparation"></textarea>
      <div class="recipe-step-suggestions hidden" role="listbox"></div>
    </div>
    <button type="button" class="recipe-step-remove" aria-label="Supprimer cette étape">×</button>`;
  const input = row.querySelector('.recipe-step-input');
  input.value = value;
  input.addEventListener('input', () => {
    autoResizeRecipeStep(input);
    showIngredientSuggestions(input);
  });
  input.addEventListener('keydown', handleIngredientSuggestionKeys);
  input.addEventListener('blur', () => setTimeout(() => closeIngredientSuggestions(input), 120));
  row.querySelector('.recipe-step-remove').addEventListener('click', () => {
    if (container.children.length === 1) {
      input.value = '';
      input.focus();
      return;
    }
    row.remove();
    updateRecipeStepNumbers();
  });
  container.append(row);
  updateRecipeStepNumbers();
  autoResizeRecipeStep(input);
  return input;
}

function autoResizeRecipeStep(input) {
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
}

function resizeAllRecipeSteps() {
  document.querySelectorAll('.recipe-step-input').forEach(autoResizeRecipeStep);
}

function updateRecipeStepNumbers() {
  document.querySelectorAll('.recipe-step-row').forEach((row, index) => {
    row.querySelector('.recipe-step-index').textContent = index + 1;
    row.querySelector('.recipe-step-input').setAttribute('aria-label', `Étape ${index + 1}`);
  });
}

function collectRecipeSteps() {
  return [...document.querySelectorAll('.recipe-step-input')]
    .map(input => input.value.trim())
    .filter(Boolean);
}

function normalizeAutocompleteText(value) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('fr');
}

function getIngredientFragment(input) {
  const cursor = input.selectionStart;
  const beforeCursor = input.value.slice(0, cursor);
  const match = beforeCursor.match(/([\p{L}\p{N}'’-]{1,60})$/u);
  return match ? { text: match[1], start: cursor - match[1].length, end: cursor } : null;
}

function showIngredientSuggestions(input) {
  const fragment = getIngredientFragment(input);
  const list = input.parentElement.querySelector('.recipe-step-suggestions');
  list.replaceChildren();
  if (!fragment?.text) return list.classList.add('hidden');
  const query = normalizeAutocompleteText(fragment.text);
  const matches = collectRecipeIngredients().filter(ingredient =>
    normalizeAutocompleteText(ingredient.name).startsWith(query) && normalizeAutocompleteText(ingredient.name) !== query
  ).slice(0, 5);
  matches.forEach(ingredient => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'recipe-step-suggestion';
    button.setAttribute('role', 'option');
    button.textContent = ingredient.name;
    button.addEventListener('mousedown', event => {
      event.preventDefault();
      applyIngredientSuggestion(input, ingredient.name);
    });
    list.append(button);
  });
  list.classList.toggle('hidden', !matches.length);
}

function applyIngredientSuggestion(input, ingredientName) {
  const fragment = getIngredientFragment(input);
  if (!fragment) return;
  input.setRangeText(ingredientName, fragment.start, fragment.end, 'end');
  closeIngredientSuggestions(input);
  input.focus();
}

function closeIngredientSuggestions(input) {
  input.parentElement.querySelector('.recipe-step-suggestions').classList.add('hidden');
}

function handleIngredientSuggestionKeys(event) {
  const input = event.currentTarget;
  const suggestions = [...input.parentElement.querySelectorAll('.recipe-step-suggestion')];
  if (!suggestions.length || !['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) return;
  if (event.key === 'Tab' && event.shiftKey) return;
  event.preventDefault();
  if (event.key === 'Escape') return closeIngredientSuggestions(input);
  let index = suggestions.findIndex(item => item.classList.contains('active'));
  if (event.key === 'Enter' || event.key === 'Tab') {
    return applyIngredientSuggestion(input, suggestions[Math.max(0, index)].textContent);
  }
  suggestions.forEach(item => item.classList.remove('active'));
  index = event.key === 'ArrowDown' ? (index + 1) % suggestions.length : (index - 1 + suggestions.length) % suggestions.length;
  suggestions[index].classList.add('active');
}

function buildGuidedRecipeContent(ingredients, steps) {
  const ingredientLines = ingredients.map(({ name, quantity, unit }) => {
    const details = [quantity, unit].filter(Boolean).join('%');
    return `@${name}{${details}}`;
  });
  const preparation = steps.map(step => autoFormatCooklang(step, ingredients)).join('\n');
  return `>> Ingredients <<\n${ingredientLines.join('\n')}\n\n>> Préparation <<\n${preparation}`;
}

function autoFormatCooklang(preparation, ingredients) {
  const tokens = [];
  let formatted = preparation;
  [...ingredients].sort((a, b) => b.name.length - a.name.length).forEach(ingredient => {
    const escaped = ingredient.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])(${escaped})(?=$|[^\\p{L}\\p{N}_])`, 'giu');
    formatted = formatted.replace(pattern, (match, prefix) => {
      const placeholder = `§INGREDIENT${tokens.length}§`;
      tokens.push(`@${ingredient.name}{}`);
      return prefix + placeholder;
    });
  });
  formatted = formatted.replace(
    /\b(\d+(?:[.,]\d+)?)\s*(secondes?|secs?|minutes?|mins?|mn|heures?|hrs?|[sh])\b/giu,
    (_, value, unit) => `~{${value}%${unit}}`
  );
  tokens.forEach((token, index) => { formatted = formatted.replaceAll(`§INGREDIENT${index}§`, token); });
  return formatted;
}

async function deleteRecipe(id) {
  if (!await goodwaterConfirm('Placer cette recette dans la corbeille ?')) return;
  try {
    await apiRequest(`/api/recipes/${encodeURIComponent(id)}`, { method: 'DELETE' });
    closeModal(document.getElementById('recipe-modal'));
    await loadRecipes();
  } catch (error) {
    window.alert(error.message);
  }
}

function splitShoppingQuantity(rawQuantity) {
  const value = rawQuantity.replace(/%/g, ' ').replace(/\s+/g, ' ').trim();
  if (!value) return { quantity: 1, unit: '' };
  const match = value.match(/^(?:(\d+)\s*\/\s*(\d+)|(\d+(?:[.,]\d+)?))\s*(.*)$/);
  if (!match) return { quantity: 1, unit: value };
  const quantity = match[1]
    ? Number(match[1]) / Number(match[2])
    : Number(match[3].replace(',', '.'));
  return { quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1, unit: match[4].trim() };
}

function formatShoppingNumber(value) {
  return Number(value).toLocaleString('fr-FR', { maximumFractionDigits: 2 });
}

function setShoppingMessage(message, isError = false) {
  const element = document.getElementById('shopping-message');
  element.textContent = message;
  element.classList.toggle('error', isError);
}

async function loadShoppingList() {
  const list = document.getElementById('shopping-list');
  list.replaceChildren(createMessage('Chargement de la liste…'));
  try {
    shoppingItems = await apiRequest('/api/shopping-list');
    renderShoppingList();
  } catch (error) {
    list.replaceChildren(createMessage(error.message, true));
  }
}

function renderShoppingList() {
  const list = document.getElementById('shopping-list');
  list.replaceChildren();
  if (!shoppingItems.length) {
    document.getElementById('delete-checked-shopping-btn').disabled = true;
    return;
  }
  document.getElementById('delete-checked-shopping-btn').disabled = !shoppingItems.some(item => Number(item.checked) === 1);
  shoppingItems.forEach(item => {
    const row = document.createElement('li');
    row.classList.toggle('checked', Number(item.checked) === 1);
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = Number(item.checked) === 1;
    checkbox.setAttribute('aria-label', `Barrer ${item.name}`);
    checkbox.addEventListener('change', () => updateShoppingItem(item.id, checkbox.checked));
    const info = document.createElement('div');
    info.className = 'item-info';
    const name = document.createElement('strong');
    name.textContent = item.name;
    const quantity = document.createElement('span');
    quantity.className = 'item-quantity';
    quantity.textContent = `${formatShoppingNumber(item.quantity)}${item.unit ? ` ${item.unit}` : ''}`;
    info.append(name, quantity);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'delete-item';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Supprimer ${item.name}`);
    remove.addEventListener('click', () => deleteShoppingItem(item.id));
    row.append(checkbox, info, remove);
    list.append(row);
  });
}

async function addShoppingItem(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await apiRequest('/api/shopping-list', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('shopping-item-name').value.trim(),
        quantity: Number(document.getElementById('shopping-item-quantity').value),
        unit: document.getElementById('shopping-item-unit').value.trim()
      })
    });
    form.reset();
    document.getElementById('shopping-item-quantity').value = '1';
    await loadShoppingList();
    setShoppingMessage('Ingrédient ajouté. Les quantités identiques sont cumulées.');
  } catch (error) {
    setShoppingMessage(error.message, true);
  }
}

async function addRecipeToShoppingList(recipe, selectedServings, button) {
  const { ingredients } = parseRecipeDisplay(recipe.content);
  if (!ingredients.length) return window.alert('Cette recette ne contient aucun ingrédient.');
  const factor = selectedServings / (recipe.servings || 1);
  const items = ingredients.map(ingredient => {
    const scaled = scaleIngredientQuantity(ingredient.quantity || '1', factor);
    const parsed = splitShoppingQuantity(scaled);
    return { name: ingredient.name, quantity: parsed.quantity, unit: parsed.unit };
  });
  button.disabled = true;
  const originalLabel = button.textContent;
  try {
    await apiRequest('/api/shopping-list/batch', {
      method: 'POST', body: JSON.stringify({ items })
    });
    button.textContent = '✓ Ajoutés à la liste';
    if (document.getElementById('nav-shopping').classList.contains('active')) await loadShoppingList();
    window.setTimeout(() => { button.textContent = originalLabel; button.disabled = false; }, 1800);
  } catch (error) {
    button.disabled = false;
    window.alert(error.message);
  }
}

async function updateShoppingItem(id, checked) {
  try {
    await apiRequest(`/api/shopping-list/${id}`, {
      method: 'PUT', body: JSON.stringify({ checked })
    });
    const item = shoppingItems.find(entry => entry.id === id);
    if (item) item.checked = checked ? 1 : 0;
    renderShoppingList();
  } catch (error) {
    setShoppingMessage(error.message, true);
    await loadShoppingList();
  }
}

async function deleteShoppingItem(id) {
  try {
    await apiRequest(`/api/shopping-list/${id}`, { method: 'DELETE' });
    shoppingItems = shoppingItems.filter(item => item.id !== id);
    renderShoppingList();
  } catch (error) {
    setShoppingMessage(error.message, true);
  }
}

async function deleteCheckedShoppingItems() {
  if (!await goodwaterConfirm('Supprimer tous les éléments barrés ?')) return;
  try {
    await apiRequest('/api/shopping-list/checked', { method: 'DELETE' });
    await loadShoppingList();
    setShoppingMessage('Les éléments barrés ont été supprimés.');
  } catch (error) {
    setShoppingMessage(error.message, true);
  }
}

async function openShoppingPage() {
  switchNav('shopping');
  await loadShoppingList();
}

function toggleAppLauncher() {
  const menu = document.getElementById('app-launcher-menu');
  const button = document.getElementById('app-launcher-btn');
  const willOpen = menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !willOpen);
  button.setAttribute('aria-expanded', String(willOpen));
}

function closeAppLauncher() {
  document.getElementById('app-launcher-menu').classList.add('hidden');
  document.getElementById('app-launcher-btn').setAttribute('aria-expanded', 'false');
}

async function openLauncherTarget(target) {
  closeAppLauncher();
  if (target === 'profile') return openSettingsModal();
  if (target === 'gym') return openGym();
  if (target === 'shopping') return openShoppingPage();
  if (target === 'menu') {
    switchNav('menu');
    return loadWeeklyMenu();
  }
  if (target === 'trash') {
    switchNav('trash');
    return loadRecipeTrash();
  }
  if (target === 'recipes') {
    switchNav('recipes');
    if (!recipes.length) await loadRecipes();
  }
}

const MENU_DAYS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
const MENU_MEALS = [
  ['breakfast', 'Petit déjeuner'],
  ['lunch', 'Déjeuner'],
  ['dinner', 'Dîner'],
  ['extra', 'Extra']
];

function setMenuMessage(message, isError = false) {
  const element = document.getElementById('menu-message');
  element.textContent = message;
  element.classList.toggle('error', isError);
}

async function loadWeeklyMenu() {
  setMenuMessage('Chargement…');
  try {
    if (!recipes.length) await loadRecipes();
    weeklyMenuItems = await apiRequest('/api/weekly-menu');
    renderMenuRecipes();
    renderWeeklyMenu();
    setMenuMessage('');
  } catch (error) {
    setMenuMessage(error.message, true);
  }
}

function renderMenuRecipes() {
  const container = document.getElementById('menu-recipes-list');
  const query = document.getElementById('menu-recipe-search').value.trim().toLocaleLowerCase('fr');
  container.replaceChildren();
  const filtered = recipes
    .filter(recipe => !query || recipe.title.toLocaleLowerCase('fr').includes(query))
    .sort((a, b) => a.title.localeCompare(b.title, 'fr'));

  const categories = new Map();
  filtered.forEach(recipe => {
    const category = recipe.category?.trim() || 'Non classée';
    if (!categories.has(category)) categories.set(category, []);
    categories.get(category).push(recipe);
  });

  [...categories.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'fr'))
    .forEach(([category, categoryRecipes]) => {
      const group = document.createElement('section');
      group.className = 'menu-category-group';
      const isExpanded = query || expandedMenuCategories.has(category);
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'menu-category-label';
      toggle.setAttribute('aria-expanded', String(Boolean(isExpanded)));
      const arrow = document.createElement('span');
      arrow.className = 'menu-cat-arrow';
      arrow.textContent = isExpanded ? '▼' : '▶';
      const label = document.createElement('span');
      label.textContent = `${category} (${categoryRecipes.length})`;
      toggle.append(arrow, label);
      const content = document.createElement('div');
      content.className = 'menu-category-content';
      content.hidden = !isExpanded;
      toggle.addEventListener('click', () => {
        if (expandedMenuCategories.has(category)) expandedMenuCategories.delete(category);
        else expandedMenuCategories.add(category);
        renderMenuRecipes();
      });
      categoryRecipes.forEach(recipe => content.append(createMenuRecipeItem(recipe)));
      group.append(toggle, content);
      container.append(group);
    });
  if (!filtered.length) container.append(createMessage('Aucune recette trouvée.'));
}

function createMenuRecipeItem(recipe) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'menu-recipe-item';
    item.style.setProperty('--menu-recipe-hue', menuRecipeHue(recipe.category));
    item.classList.toggle('selected', selectedMenuRecipeId === recipe.id);
    item.draggable = true;
    item.dataset.recipeId = recipe.id;
    item.setAttribute('aria-pressed', String(selectedMenuRecipeId === recipe.id));
    item.title = 'Glisser vers un repas ou toucher pour sélectionner';
    const drag = document.createElement('span');
    drag.className = 'menu-drag-icon';
    drag.textContent = '⠿';
    drag.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'menu-recipe-name';
    name.textContent = recipe.title;
    item.append(drag, name);
    item.addEventListener('click', () => {
      selectedMenuRecipeId = selectedMenuRecipeId === recipe.id ? null : recipe.id;
      renderMenuRecipes();
      renderWeeklyMenu();
    });
    item.addEventListener('dragstart', event => {
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData('text/plain', JSON.stringify({ type: 'recipe', recipeId: recipe.id }));
      item.classList.add('dragging');
      document.getElementById('nav-menu').classList.add('menu-drag-active');
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      document.getElementById('nav-menu').classList.remove('menu-drag-active');
    });
    return item;
}

function menuRecipeHue(category = '') {
  let hash = 0;
  for (const character of category) hash = ((hash * 31) + character.charCodeAt(0)) % 360;
  return String(hash || 28);
}

function renderWeeklyMenu() {
  const container = document.getElementById('menu-days-container');
  container.replaceChildren();
  MENU_DAYS.forEach((dayLabel, day) => {
    const group = document.createElement('section');
    group.className = 'menu-day-group';
    const header = document.createElement('h3');
    header.className = 'menu-day-header';
    header.textContent = dayLabel;
    group.append(header);
    MENU_MEALS.forEach(([meal, mealLabel]) => {
      const label = document.createElement('div');
      label.className = 'menu-meal-label';
      label.textContent = mealLabel;
      const zone = document.createElement('div');
      zone.className = 'menu-drop-zone';
      zone.classList.toggle('ready-to-drop', Boolean(selectedMenuRecipeId));
      zone.dataset.day = String(day);
      zone.dataset.meal = meal;
      const items = weeklyMenuItems.filter(item => Number(item.day) === day && item.meal === meal);
      zone.classList.toggle('empty', !items.length);
      const hint = document.createElement('span');
      hint.className = 'menu-drop-hint';
      hint.textContent = selectedMenuRecipeId ? 'Touchez pour ajouter' : 'Déposer ici';
      zone.append(hint);
      items.forEach(menuItem => zone.append(createMenuChip(menuItem)));
      zone.addEventListener('dragover', event => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        zone.classList.add('drag-over');
      });
      zone.addEventListener('dragleave', event => {
        if (!zone.contains(event.relatedTarget)) zone.classList.remove('drag-over');
      });
      zone.addEventListener('drop', event => handleMenuDrop(event, day, meal));
      zone.addEventListener('click', event => {
        if (event.target.closest('.menu-chip')) return;
        if (selectedMenuRecipeId) addRecipeToWeeklyMenu(selectedMenuRecipeId, day, meal);
      });
      group.append(label, zone);
    });
    container.append(group);
  });
}

function createMenuChip(menuItem) {
  const chip = document.createElement('div');
  chip.className = 'menu-chip';
  chip.draggable = true;
  const recipe = recipes.find(item => item.id === menuItem.recipeId);
  chip.style.setProperty('--menu-recipe-hue', menuRecipeHue(recipe?.category));
  chip.title = 'Glisser pour déplacer vers un autre repas';
  const handle = document.createElement('span');
  handle.className = 'menu-chip-drag-handle';
  handle.textContent = '⠿';
  handle.setAttribute('aria-hidden', 'true');
  const title = document.createElement('span');
  title.className = 'menu-chip-title';
  title.textContent = recipe?.title || 'Recette indisponible';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'menu-chip-remove';
  remove.textContent = '×';
  remove.setAttribute('aria-label', `Retirer ${title.textContent}`);
  remove.addEventListener('click', event => {
    event.stopPropagation();
    removeWeeklyMenuItem(menuItem.id);
  });
  chip.addEventListener('dragstart', event => {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', JSON.stringify({ type: 'menuItem', id: menuItem.id }));
    chip.classList.add('dragging');
    document.getElementById('nav-menu').classList.add('menu-drag-active');
  });
  chip.addEventListener('dragend', () => {
    chip.classList.remove('dragging');
    document.getElementById('nav-menu').classList.remove('menu-drag-active');
  });
  chip.append(handle, title, remove);
  return chip;
}

async function handleMenuDrop(event, day, meal) {
  event.preventDefault();
  event.currentTarget.classList.remove('drag-over');
  document.getElementById('nav-menu').classList.remove('menu-drag-active');
  try {
    const payload = JSON.parse(event.dataTransfer.getData('text/plain'));
    if (payload.type === 'recipe') await addRecipeToWeeklyMenu(payload.recipeId, day, meal);
    if (payload.type === 'menuItem') await moveWeeklyMenuItem(payload.id, day, meal);
  } catch {
    setMenuMessage('Impossible de déplacer cette recette.', true);
  }
}

async function addRecipeToWeeklyMenu(recipeId, day, meal) {
  try {
    await apiRequest('/api/weekly-menu', {
      method: 'POST', body: JSON.stringify({ recipeId, day, meal })
    });
    selectedMenuRecipeId = null;
    weeklyMenuItems = await apiRequest('/api/weekly-menu');
    renderMenuRecipes();
    renderWeeklyMenu();
  } catch (error) {
    setMenuMessage(error.message, true);
  }
}

async function moveWeeklyMenuItem(id, day, meal) {
  try {
    await apiRequest(`/api/weekly-menu/${id}`, {
      method: 'PUT', body: JSON.stringify({ day, meal })
    });
    const item = weeklyMenuItems.find(entry => entry.id === id);
    if (item) Object.assign(item, { day, meal });
    renderWeeklyMenu();
  } catch (error) {
    setMenuMessage(error.message, true);
  }
}

async function removeWeeklyMenuItem(id) {
  try {
    await apiRequest(`/api/weekly-menu/${id}`, { method: 'DELETE' });
    weeklyMenuItems = weeklyMenuItems.filter(item => item.id !== id);
    renderWeeklyMenu();
  } catch (error) {
    setMenuMessage(error.message, true);
  }
}

async function clearWeeklyMenu() {
  if (!weeklyMenuItems.length || !await goodwaterConfirm('Vider entièrement le menu de la semaine ?')) return;
  try {
    await apiRequest('/api/weekly-menu/all', { method: 'DELETE' });
    weeklyMenuItems = [];
    renderWeeklyMenu();
    setMenuMessage('Le menu a été vidé.');
  } catch (error) {
    setMenuMessage(error.message, true);
  }
}

async function addWeeklyMenuToShoppingList() {
  if (!weeklyMenuItems.length) return setMenuMessage('Le menu est vide.', true);
  const combined = new Map();
  weeklyMenuItems.forEach(menuItem => {
    const recipe = recipes.find(item => item.id === menuItem.recipeId);
    if (!recipe) return;
    parseRecipeDisplay(recipe.content).ingredients.forEach(ingredient => {
      const parsed = splitShoppingQuantity(ingredient.quantity || '1');
      const key = `${ingredient.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('fr')}|${parsed.unit.toLocaleLowerCase('fr')}`;
      const current = combined.get(key);
      if (current) current.quantity += parsed.quantity;
      else combined.set(key, { name: ingredient.name, quantity: parsed.quantity, unit: parsed.unit });
    });
  });
  const items = [...combined.values()];
  if (!items.length) return setMenuMessage('Aucun ingrédient à ajouter.', true);
  const button = document.getElementById('menu-add-shopping-btn');
  button.disabled = true;
  try {
    for (let index = 0; index < items.length; index += 100) {
      await apiRequest('/api/shopping-list/batch', {
        method: 'POST', body: JSON.stringify({ items: items.slice(index, index + 100) })
      });
    }
    setMenuMessage(`${items.length} ingrédient(s) ajouté(s) à la liste de courses.`);
  } catch (error) {
    setMenuMessage(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function handleLogout(revokeServer = true) {
  if (revokeServer) {
    try { await apiRequest('/api/logout', { method: 'POST' }); } catch { /* Clear locally even if already expired. */ }
  }
  document.querySelectorAll('.modal').forEach(modal => {
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
  });
  clearSession();
  recipes = [];
  shoppingItems = [];
  weeklyMenuItems = [];
  selectedMenuRecipeId = null;
  editingRecipeId = null;
  activeCategory = null;
  showAuthPage();
  document.getElementById('login-form').reset();
}

function switchNav(name) {
  document.querySelectorAll('.nav-content').forEach(section => {
    section.classList.toggle('active', section.id === `nav-${name}`);
    section.classList.toggle('hidden', section.id !== `nav-${name}`);
  });
  document.querySelectorAll('.nav-btn').forEach(button => {
    button.classList.toggle('active', button.dataset.nav === name);
  });
  document.querySelector('.banner-center').classList.remove('mobile-open');
}

function setAdminMessage(message, isError = false) {
  const element = document.getElementById('admin-message');
  element.textContent = message;
  element.classList.toggle('error', isError);
}

function formatAdminDate(value) {
  if (!value) return '—';
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('fr-FR');
}

function isUserBlocked(user) {
  return Boolean(user.blockedUntil && new Date(user.blockedUntil).getTime() > Date.now());
}

async function loadAdminDashboard() {
  if (getStoredUser()?.role !== 'admin') return;
  setAdminMessage('Chargement…');
  try {
    const [users, logs, pendingUsers, stats] = await Promise.all([
      apiRequest('/api/admin/users'),
      apiRequest(`/api/admin/login-logs?limit=${adminLogLimit}`),
      apiRequest('/api/admin/pending-users'),
      apiRequest('/api/admin/stats')
    ]);
    renderAdminUsers(users);
    adminLogs = logs;
    renderAdminLogs(logs);
    renderPendingUsers(pendingUsers);
    renderAdminStats(stats);
    setAdminMessage('');
  } catch (error) {
    setAdminMessage(error.message, true);
  }
}

function renderAdminStats(stats) {
  const labels = [
    ['users', 'Utilisateurs'], ['blocked', 'Comptes bloqués'], ['pending', 'Demandes en attente'],
    ['successfulLogins', 'Connexions réussies · 24 h'], ['failedLogins', 'Échecs · 24 h'], ['trashedRecipes', 'Recettes dans la corbeille']
  ];
  const container = document.getElementById('admin-stats');
  container.replaceChildren(...labels.map(([key, label]) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'admin-stat-card';
    card.dataset.statKey = key;
    card.setAttribute('aria-label', `${label} : ${stats[key] ?? 0}. Afficher le détail`);
    const value = document.createElement('strong');
    value.textContent = stats[key] ?? 0;
    const caption = document.createElement('span');
    caption.textContent = label;
    card.append(value, caption);
    card.addEventListener('click', () => showAdminStatDetails(key, label, card));
    return card;
  }));
}

async function showAdminStatDetails(key, label, card) {
  const panel = document.getElementById('admin-stat-details');
  const title = document.getElementById('admin-stat-details-title');
  const list = document.getElementById('admin-stat-details-list');
  document.querySelectorAll('.admin-stat-card').forEach(item => item.classList.toggle('active', item === card));
  panel.classList.remove('hidden');
  title.textContent = label;
  list.replaceChildren(createMessage('Chargement…'));
  try {
    const rows = await apiRequest(`/api/admin/stats/${encodeURIComponent(key)}/details`);
    if (!rows.length) return list.replaceChildren(createMessage('Aucun élément concerné.'));
    list.replaceChildren(...rows.map(row => {
      const item = document.createElement('article');
      item.className = 'admin-stat-detail-item';
      const name = document.createElement('strong');
      name.textContent = row.username || 'Inconnu';
      const detail = document.createElement('small');
      detail.textContent = [row.detail, row.timestamp ? formatAdminDate(row.timestamp) : ''].filter(Boolean).join(' · ');
      item.append(name, detail);
      if (key === 'trashedRecipes' && row.id) {
        const actions = document.createElement('div');
        actions.className = 'admin-stat-trash-actions';
        const restore = document.createElement('button');
        restore.type = 'button';
        restore.className = 'success-btn admin-stat-trash-action';
        restore.textContent = 'Restaurer';
        restore.addEventListener('click', () => restoreRecipeFromAdminStats(row.id));
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'danger-btn admin-stat-trash-action';
        remove.textContent = 'Supprimer définitivement';
        remove.addEventListener('click', () => permanentlyDeleteRecipeFromAdminStats(row.id, row.username));
        actions.append(restore, remove);
        item.append(actions);
      }
      return item;
    }));
  } catch (error) {
    list.replaceChildren(createMessage(error.message));
  }
}

async function restoreRecipeFromAdminStats(id) {
  const list = document.getElementById('admin-stat-details-list');
  try {
    await apiRequest(`/api/recipe-trash/${encodeURIComponent(id)}/restore`, { method: 'POST' });
    await loadAdminDashboard();
    const card = document.querySelector('[data-stat-key="trashedRecipes"]');
    if (card) await showAdminStatDetails('trashedRecipes', 'Recettes dans la corbeille', card);
  } catch (error) {
    list.prepend(createMessage(error.message));
  }
}

async function permanentlyDeleteRecipeFromAdminStats(id, title) {
  if (!await goodwaterConfirm(`Supprimer définitivement « ${title} » ? Cette action est irréversible.`)) return;
  const list = document.getElementById('admin-stat-details-list');
  try {
    await apiRequest(`/api/recipe-trash/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await loadAdminDashboard();
    const card = document.querySelector('[data-stat-key="trashedRecipes"]');
    if (card) await showAdminStatDetails('trashedRecipes', 'Recettes dans la corbeille', card);
  } catch (error) {
    list.prepend(createMessage(error.message));
  }
}

function closeAdminStatDetails() {
  document.getElementById('admin-stat-details').classList.add('hidden');
  document.querySelectorAll('.admin-stat-card').forEach(card => card.classList.remove('active'));
}

function renderAdminUsers(users) {
  const tbody = document.getElementById('admin-users-body');
  tbody.replaceChildren();
  users.forEach(user => {
    const row = document.createElement('tr');
    const identity = document.createElement('td');
    const username = document.createElement('strong');
    username.textContent = user.username;
    const fullName = document.createElement('small');
    fullName.textContent = [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Profil non renseigné';
    identity.append(username, fullName);

    const role = document.createElement('td');
    const roleSelect = document.createElement('select');
    roleSelect.className = 'admin-role-select';
    const availableRoles = user.role === 'admin'
      ? [['admin', 'Admin']]
      : [['viewer', 'Lecture'], ['editor', 'Lecture / écriture'], ['grand_chef', 'Grand chef']];
    availableRoles.forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      option.selected = user.role === value;
      roleSelect.append(option);
    });
    roleSelect.disabled = user.username === getStoredUser()?.username;
    roleSelect.addEventListener('change', () => updateUserRole(user.username, roleSelect.value));
    role.append(roleSelect);
    const status = document.createElement('td');
    const badge = document.createElement('span');
    const blocked = isUserBlocked(user);
    badge.className = blocked ? 'status-badge status-blocked' : 'status-badge status-active';
    badge.textContent = blocked ? `Bloqué jusqu’au ${formatAdminDate(user.blockedUntil)}` : 'Actif';
    status.append(badge);

    const blockCell = document.createElement('td');
    if (user.role === 'admin') {
      blockCell.textContent = '—';
    } else {
      const select = document.createElement('select');
      select.className = 'admin-duration-select';
      [[30, '30 min'], [60, '1 heure'], [1440, '1 jour'], [10080, '7 jours'], [43200, '30 jours']].forEach(([value, label]) => {
        const option = document.createElement('option');
        option.value = String(value);
        option.textContent = label;
        select.append(option);
      });
      const button = document.createElement('button');
      button.type = 'button';
      button.className = blocked ? 'secondary-btn admin-action-btn' : 'danger-btn admin-action-btn';
      button.textContent = blocked ? 'Débloquer' : 'Bloquer';
      button.addEventListener('click', () => updateUserBlock(user.username, blocked ? 0 : Number(select.value)));
      if (blocked) {
        select.disabled = true;
        select.classList.add('admin-control-placeholder');
      }
      blockCell.append(select, button);
    }

    const passwordCell = document.createElement('td');
    const resetButton = document.createElement('button');
    resetButton.type = 'button';
    resetButton.className = 'secondary-btn admin-action-btn';
    resetButton.textContent = 'Réinitialiser';
    resetButton.addEventListener('click', () => resetUserPassword(user.username));
    passwordCell.append(resetButton);
    const actionsCell = document.createElement('td');
    if (user.role === 'admin') {
      actionsCell.textContent = '—';
    } else {
      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'danger-btn admin-action-btn';
      deleteButton.textContent = 'Supprimer';
      deleteButton.addEventListener('click', () => deleteUser(user.username));
      actionsCell.append(deleteButton);
    }
    row.append(identity, role, status, blockCell, passwordCell, actionsCell);
    tbody.append(row);
  });
}

function renderAdminLogs(logs) {
  const filtered = filterAdminLogs(logs);
  const loginLogs = filtered.filter(log => log.action === 'login');
  const passwordLogs = filtered.filter(log => log.action.startsWith('password_'));
  const actionLogs = filtered.filter(log => log.action !== 'login' && !log.action.startsWith('password_'));
  renderAdminLogRows(document.getElementById('admin-login-logs-body'), loginLogs, false);
  renderAdminLogRows(document.getElementById('admin-password-logs-body'), passwordLogs, true);
  renderAdminLogRows(document.getElementById('admin-action-logs-body'), actionLogs, true);
  document.getElementById('admin-load-more-btn').hidden = logs.length < adminLogLimit || adminLogLimit >= 200;
}

function filterAdminLogs(logs) {
  const search = document.getElementById('admin-log-search')?.value.trim().toLocaleLowerCase('fr') || '';
  const result = document.getElementById('admin-log-result')?.value || 'all';
  const from = document.getElementById('admin-log-from')?.value;
  const to = document.getElementById('admin-log-to')?.value;
  return logs.filter(log => {
    const haystack = [log.username, log.actorUsername, log.targetUsername, log.ip, log.reason].join(' ').toLocaleLowerCase('fr');
    const date = new Date(log.timestamp.includes('T') ? log.timestamp : `${log.timestamp.replace(' ', 'T')}Z`);
    if (search && !haystack.includes(search)) return false;
    if (result === 'success' && Number(log.success) !== 1) return false;
    if (result === 'failed' && Number(log.success) === 1) return false;
    if (from && date < new Date(`${from}T00:00:00`)) return false;
    if (to && date > new Date(`${to}T23:59:59.999`)) return false;
    return true;
  });
}

function renderAdminLogRows(tbody, logs, showTarget) {
  tbody.replaceChildren();
  if (!logs.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.className = 'admin-empty-cell';
    cell.textContent = showTarget ? 'Aucune opération sur les mots de passe.' : 'Aucune tentative de connexion.';
    row.append(cell);
    tbody.append(row);
    return;
  }
  logs.forEach(log => {
    const row = document.createElement('tr');
    const identityValues = showTarget
      ? [formatAdminDate(log.timestamp), log.actorUsername || log.username, log.targetUsername || log.username]
      : [formatAdminDate(log.timestamp), log.username, log.ip];
    identityValues.forEach(value => {
      const cell = document.createElement('td');
      cell.textContent = value || '—';
      row.append(cell);
    });
    const result = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = Number(log.success) === 1 ? 'status-badge status-success' : 'status-badge status-failed';
    badge.textContent = Number(log.success) === 1 ? 'Succès' : 'Échec';
    result.append(badge);
    const reason = document.createElement('td');
    reason.textContent = log.reason || '—';
    row.append(result, reason);
    tbody.append(row);
  });
}

function switchAdminJournalView(view) {
  const showPasswords = view === 'passwords';
  const showActions = view === 'actions';
  adminJournalView = view;
  [['logins', view === 'logins'], ['passwords', showPasswords], ['actions', showActions]].forEach(([name, active]) => {
    document.getElementById(`admin-${name}-view`).classList.toggle('hidden', !active);
    document.getElementById(`admin-${name}-tab`).classList.toggle('active', active);
    document.getElementById(`admin-${name}-tab`).setAttribute('aria-selected', String(active));
  });
}

function resetAdminLogFilters() {
  ['admin-log-search', 'admin-log-from', 'admin-log-to'].forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('admin-log-result').value = 'all';
  renderAdminLogs(adminLogs);
}

async function exportAdminLogsCsv() {
  let exportLogs = adminLogs;
  try {
    exportLogs = await apiRequest('/api/admin/login-logs?limit=200');
  } catch (error) {
    return setAdminMessage(error.message, true);
  }
  const typeFilter = adminJournalView === 'logins'
    ? log => log.action === 'login'
    : adminJournalView === 'passwords'
      ? log => log.action.startsWith('password_')
      : log => log.action !== 'login' && !log.action.startsWith('password_');
  const rows = filterAdminLogs(exportLogs).filter(typeFilter);
  const escapeCsv = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const csv = [['Date', 'Effectué par', 'Cible', 'Adresse IP', 'Résultat', 'Détail'], ...rows.map(log => [
    formatAdminDate(log.timestamp), log.actorUsername || log.username, log.targetUsername || log.username,
    log.ip, Number(log.success) === 1 ? 'Succès' : 'Échec', log.reason || ''
  ])].map(row => row.map(escapeCsv).join(';')).join('\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
  link.download = `journal-${adminJournalView}-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function renderPendingUsers(pendingUsers) {
  const container = document.getElementById('admin-pending-list');
  container.replaceChildren();
  if (!pendingUsers.length) {
    container.append(createMessage('Aucune demande en attente.'));
    return;
  }
  pendingUsers.forEach(pending => {
    const item = document.createElement('div');
    item.className = 'admin-pending-item';
    const info = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = pending.username;
    const details = document.createElement('small');
    details.textContent = `${formatAdminDate(pending.createdAt)} · ${pending.requestIp}`;
    info.append(name, details);
    const actions = document.createElement('div');
    const approve = document.createElement('button');
    approve.type = 'button';
    approve.className = 'primary-btn admin-action-btn';
    approve.textContent = 'Accepter';
    approve.addEventListener('click', () => decidePendingUser(pending.id, 'approve'));
    const reject = document.createElement('button');
    reject.type = 'button';
    reject.className = 'danger-btn admin-action-btn';
    reject.textContent = 'Refuser';
    reject.addEventListener('click', () => decidePendingUser(pending.id, 'reject'));
    actions.append(approve, reject);
    item.append(info, actions);
    container.append(item);
  });
}

async function decidePendingUser(id, decision) {
  if (!await goodwaterConfirm(decision === 'approve' ? 'Accepter cette inscription ?' : 'Refuser cette inscription ?')) return;
  try {
    const result = await apiRequest(`/api/admin/pending-users/${id}/${decision}`, { method: 'POST' });
    await loadAdminDashboard();
    setAdminMessage(result.message);
  } catch (error) {
    setAdminMessage(error.message, true);
  }
}

async function updateUserRole(username, role) {
  try {
    await apiRequest(`/api/admin/users/${encodeURIComponent(username)}/role`, {
      method: 'PUT', body: JSON.stringify({ role })
    });
    await loadAdminDashboard();
    setAdminMessage(`Rôle de ${username} mis à jour.`);
  } catch (error) {
    setAdminMessage(error.message, true);
    await loadAdminDashboard();
  }
}

async function createAdminUser(event) {
  event.preventDefault();
  try {
    const result = await apiRequest('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: document.getElementById('admin-new-username').value.trim(),
        password: document.getElementById('admin-new-password').value,
        role: document.getElementById('admin-new-role').value
      })
    });
    event.target.reset();
    await loadAdminDashboard();
    setAdminMessage(`${result.username} a été créé.`);
  } catch (error) {
    setAdminMessage(error.message, true);
  }
}

async function loadMoreAdminLogs() {
  adminLogLimit = Math.min(adminLogLimit + 20, 200);
  await loadAdminDashboard();
}

async function updateUserBlock(username, durationMinutes) {
  try {
    await apiRequest(`/api/admin/users/${encodeURIComponent(username)}/block`, {
      method: 'PUT', body: JSON.stringify({ durationMinutes })
    });
    await loadAdminDashboard();
    setAdminMessage(durationMinutes === 0 ? `${username} a été débloqué.` : `${username} a été bloqué.`);
  } catch (error) {
    setAdminMessage(error.message, true);
  }
}

async function resetUserPassword(username) {
  const password = window.prompt(`Nouveau mot de passe pour ${username} (8 caractères minimum) :`);
  if (password === null) return;
  if (password.length < 8) return setAdminMessage('Le mot de passe doit contenir au moins 8 caractères.', true);
  if (!await goodwaterConfirm(`Confirmer la réinitialisation du mot de passe de ${username} ?`)) return;
  try {
    await apiRequest(`/api/admin/users/${encodeURIComponent(username)}/password`, {
      method: 'PUT', body: JSON.stringify({ password })
    });
    await loadAdminDashboard();
    setAdminMessage(`Mot de passe de ${username} réinitialisé.`);
  } catch (error) {
    setAdminMessage(error.message, true);
  }
}

async function deleteUser(username) {
  const confirmation = window.prompt(`Pour supprimer définitivement ${username}, saisissez son nom d’utilisateur :`);
  if (confirmation === null) return;
  if (confirmation !== username) {
    setAdminMessage('Suppression annulée : le nom saisi ne correspond pas.', true);
    return;
  }
  try {
    await apiRequest(`/api/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
    await loadAdminDashboard();
    setAdminMessage(`${username} a été supprimé définitivement.`);
  } catch (error) {
    setAdminMessage(error.message, true);
  }
}

function toggleTheme() {
  const dark = document.body.classList.toggle('dark');
  localStorage.setItem('goodwater-theme', dark ? 'dark' : 'light');
  document.getElementById('theme-icon').textContent = dark ? '☀️' : '🌙';
}

async function openSettingsModal() {
  const user = getStoredUser();
  document.getElementById('settings-username-display').value = user?.username || '';
  document.getElementById('settings-avatar').textContent = (user?.username || '?').charAt(0).toUpperCase();
  const roleLabels = { viewer: 'Lecture', editor: 'Lecture / écriture', grand_chef: 'Grand chef', admin: 'Admin' };
  document.getElementById('profile-role').textContent = roleLabels[user?.role] || 'Lecture';
  document.getElementById('profile-message').textContent = '';
  document.getElementById('profile-password-form').reset();
  document.getElementById('profile-password-message').textContent = '';
  openModal('settings-modal');
  loadSessions();
  loadBiometricCredentials();
  try {
    const profile = await apiRequest('/api/profile');
    document.getElementById('profile-first-name').value = profile.firstName || '';
    document.getElementById('profile-last-name').value = profile.lastName || '';
    document.getElementById('profile-description').value = profile.description || '';
  } catch (error) {
    document.getElementById('profile-message').textContent = error.message;
  }
}

async function saveProfile(event) {
  event.preventDefault();
  const message = document.getElementById('profile-message');
  message.textContent = '';
  try {
    const profile = await apiRequest('/api/profile', {
      method: 'PUT',
      body: JSON.stringify({
        firstName: document.getElementById('profile-first-name').value,
        lastName: document.getElementById('profile-last-name').value,
        description: document.getElementById('profile-description').value
      })
    });
    document.getElementById('settings-avatar').textContent = (profile.firstName || profile.username).charAt(0).toUpperCase();
    message.textContent = 'Profil enregistré.';
  } catch (error) {
    message.textContent = error.message;
  }
}

async function changeOwnPassword(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.getElementById('profile-password-message');
  const currentPassword = document.getElementById('profile-current-password').value;
  const newPassword = document.getElementById('profile-new-password').value;
  const confirmation = document.getElementById('profile-confirm-password').value;
  message.textContent = '';
  message.className = '';

  if (newPassword !== confirmation) {
    message.textContent = 'Les nouveaux mots de passe ne correspondent pas.';
    message.className = 'error';
    return;
  }

  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    const result = await apiRequest('/api/profile/password', {
      method: 'PUT',
      body: JSON.stringify({ currentPassword, newPassword })
    });
    form.reset();
    message.textContent = result.message;
    message.className = '';
  } catch (error) {
    message.textContent = error.message;
    message.className = 'error';
  } finally {
    submitButton.disabled = false;
  }
}

async function registerBiometricCredential() {
  const button = document.getElementById('register-biometric-btn');
  if (!window.SimpleWebAuthnBrowser) return window.alert('La connexion par biométrie n’est pas disponible sur ce navigateur.');
  button.disabled = true;
  try {
    const optionsJSON = await apiRequest('/api/passkeys/register/options', { method: 'POST', body: '{}' });
    const response = await window.SimpleWebAuthnBrowser.startRegistration({ optionsJSON });
    await apiRequest('/api/passkeys/register/verify', { method: 'POST', body: JSON.stringify(response) });
    await loadBiometricCredentials();
  } catch (error) {
    window.alert(error.message || 'Activation de la connexion par biométrie annulée.');
  } finally { button.disabled = false; }
}

async function loadBiometricCredentials() {
  const container = document.getElementById('biometric-list');
  container.replaceChildren(createMessage('Chargement…'));
  try {
    const credentials = await apiRequest('/api/passkeys');
    container.replaceChildren();
    if (!credentials.length) return container.append(createMessage('Aucune connexion biométrique activée.'));
    credentials.forEach(credential => {
      const item = document.createElement('article');
      item.className = 'biometric-item';
      const icon = document.createElement('div');
      icon.className = 'biometric-device-icon';
      const deviceLabel = credential.deviceLabel || 'Appareil non identifié';
      icon.textContent = /iPhone|iPad|Android/i.test(deviceLabel) ? '▯' : '▰';
      icon.setAttribute('aria-hidden', 'true');
      const info = document.createElement('div');
      info.className = 'biometric-device-info';
      const heading = document.createElement('div');
      heading.className = 'biometric-device-title';
      const title = document.createElement('strong');
      title.textContent = deviceLabel;
      heading.append(title);
      if (credential.backedUp) {
        const badge = document.createElement('span');
        badge.className = 'biometric-badge';
        badge.textContent = 'Synchronisée';
        heading.append(badge);
      }
      const browser = document.createElement('span');
      browser.textContent = credential.browserName || 'Sera identifié à la prochaine connexion biométrique';
      const date = document.createElement('small');
      date.textContent = credential.createdAt ? `Ajoutée le ${formatAdminDate(credential.createdAt)}` : 'Date d’ajout inconnue';
      info.append(heading, browser, date);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'biometric-delete-btn';
      remove.textContent = 'Supprimer';
      remove.setAttribute('aria-label', `Supprimer la connexion biométrique de ${deviceLabel}`);
      remove.addEventListener('click', () => deleteBiometricCredential(credential.id, remove));
      item.append(icon, info, remove);
      container.append(item);
    });
  } catch (error) { container.replaceChildren(createMessage(error.message, true)); }
}

async function deleteBiometricCredential(id, button) {
  if (!await goodwaterConfirm('Supprimer cette connexion biométrique ? Vous pourrez toujours vous connecter avec votre mot de passe.')) return;
  button.disabled = true;
  try {
    await apiRequest(`/api/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await loadBiometricCredentials();
  } catch (error) {
    window.alert(error.message || 'Suppression impossible.');
    button.disabled = false;
  }
}

async function loginWithBiometrics() {
  const username = document.getElementById('login-username').value.trim();
  const error = document.getElementById('login-error');
  const button = document.getElementById('biometric-login-btn');
  error.textContent = '';
  if (!username) {
    error.textContent = "Saisissez d’abord votre nom d’utilisateur.";
    return;
  }
  if (!window.SimpleWebAuthnBrowser) {
    error.textContent = 'La connexion par biométrie n’est pas disponible sur ce navigateur.';
    return;
  }
  button.disabled = true;
  try {
    const optionsJSON = await apiRequest('/api/passkeys/login/options', { auth: false, method: 'POST', body: JSON.stringify({ username }) });
    const response = await window.SimpleWebAuthnBrowser.startAuthentication({ optionsJSON });
    const data = await apiRequest('/api/passkeys/login/verify', { auth: false, method: 'POST', body: JSON.stringify({ username, response }) });
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(USER_KEY, JSON.stringify({ username: data.username, role: data.role }));
    document.getElementById('login-form').reset();
    await showMainPage({ username: data.username, role: data.role });
  } catch (requestError) { error.textContent = requestError.message; }
  finally { button.disabled = false; }
}

function describeSession(userAgent) {
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /Firefox\//.test(userAgent) ? 'Firefox' : /Chrome\//.test(userAgent) ? 'Chrome' : /Safari\//.test(userAgent) ? 'Safari' : 'Navigateur';
  const system = /Android/.test(userAgent) ? 'Android' : /iPhone|iPad/.test(userAgent) ? 'iOS' : /Windows/.test(userAgent) ? 'Windows' : /Mac OS/.test(userAgent) ? 'macOS' : /Linux/.test(userAgent) ? 'Linux' : 'Appareil inconnu';
  return `${browser} sur ${system}`;
}

async function loadSessions() {
  const container = document.getElementById('sessions-list');
  const message = document.getElementById('sessions-message');
  container.replaceChildren(createMessage('Chargement…'));
  message.textContent = '';
  try {
    const sessions = await apiRequest('/api/sessions');
    container.replaceChildren();
    if (!sessions.length) return container.append(createMessage('Aucune session suivie.'));
    sessions.forEach(session => {
      const item = document.createElement('article');
      item.className = 'session-item';
      const info = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = `${describeSession(session.userAgent)}${session.current ? ' · Cet appareil' : ''}`;
      const details = document.createElement('small');
      details.textContent = `${session.ip || 'IP inconnue'} · activité ${formatAdminDate(session.lastSeenAt)}`;
      info.append(title, details);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'danger-btn admin-action-btn';
      button.textContent = 'Déconnecter';
      button.addEventListener('click', () => revokeSession(session.id, session.current));
      item.append(info, button);
      container.append(item);
    });
  } catch (error) { message.textContent = error.message; }
}

async function revokeSession(id, current) {
  if (!await goodwaterConfirm(current ? 'Déconnecter cet appareil maintenant ?' : 'Déconnecter cet appareil ?')) return;
  try {
    await apiRequest(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (current) return handleLogout(false);
    await loadSessions();
  } catch (error) { document.getElementById('sessions-message').textContent = error.message; }
}

async function loadRecipeTrash(containerId = 'recipe-trash-list', messageId = 'trash-message') {
  const container = document.getElementById(containerId);
  const message = document.getElementById(messageId);
  container.replaceChildren(createMessage('Chargement…'));
  message.textContent = '';
  try {
    const items = await apiRequest('/api/recipe-trash');
    container.replaceChildren();
    if (!items.length) return container.append(createMessage('La corbeille est vide.'));
    items.forEach(item => {
      const card = document.createElement('article');
      card.className = 'trash-card';
      const info = document.createElement('div');
      const title = document.createElement('h3');
      title.textContent = item.title;
      const details = document.createElement('p');
      details.textContent = `Supprimée par ${item.deletedBy} le ${formatAdminDate(item.deletedAt)}${item.owner ? ` · Auteur : ${item.owner}` : ''}`;
      info.append(title, details);
      const actions = document.createElement('div');
      const restore = document.createElement('button');
      restore.type = 'button'; restore.className = 'success-btn'; restore.textContent = 'Restaurer';
      restore.addEventListener('click', () => restoreTrashRecipe(item.id, containerId, messageId));
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'danger-btn'; remove.textContent = 'Supprimer définitivement';
      remove.addEventListener('click', () => permanentlyDeleteTrashRecipe(item.id, item.title, containerId, messageId));
      actions.append(restore, remove); card.append(info, actions); container.append(card);
    });
  } catch (error) { message.textContent = error.message; }
}

async function restoreTrashRecipe(id, containerId = 'recipe-trash-list', messageId = 'trash-message') {
  try {
    await apiRequest(`/api/recipe-trash/${encodeURIComponent(id)}/restore`, { method: 'POST' });
    document.getElementById(messageId).textContent = 'Recette restaurée avec succès.';
    await loadRecipeTrash(containerId, messageId);
  } catch (error) { document.getElementById(messageId).textContent = error.message; }
}

async function permanentlyDeleteTrashRecipe(id, title, containerId = 'recipe-trash-list', messageId = 'trash-message') {
  if (!await goodwaterConfirm(`Supprimer définitivement « ${title} » ? Cette action est irréversible.`)) return;
  try { await apiRequest(`/api/recipe-trash/${encodeURIComponent(id)}`, { method: 'DELETE' }); await loadRecipeTrash(containerId, messageId); }
  catch (error) { document.getElementById(messageId).textContent = error.message; }
}

function openGym() {
  window.location.href = 'https://gym.goodwater-recipes.fr/';
}

function initializeLogo() {
  document.querySelectorAll('.app-logo-img').forEach(img => {
    const svg = document.getElementById(img.id.replace('-img', '-svg'));
    img.onload = () => {
      img.style.display = 'block';
      if (svg) svg.style.display = 'none';
    };
    img.onerror = () => {
      img.style.display = 'none';
      if (svg) svg.style.display = '';
    };
    img.src = `/api/logo?v=${Date.now()}`;
  });
}

function togglePasswordVisibility(button) {
  const input = document.getElementById(button.dataset.passwordToggle);
  if (!input) return;
  const showPassword = input.type === 'password';
  const fieldName = document.querySelector(`label[for="${input.id}"]`)?.textContent.toLowerCase() || 'mot de passe';
  input.type = showPassword ? 'text' : 'password';
  button.setAttribute('aria-pressed', String(showPassword));
  button.setAttribute('aria-label', `${showPassword ? 'Masquer' : 'Afficher'} : ${fieldName}`);
  button.querySelector('span').textContent = showPassword ? 'Masquer' : 'Afficher';
}

function resetPasswordVisibility(form) {
  form.querySelectorAll('[data-password-toggle]').forEach(button => {
    const input = document.getElementById(button.dataset.passwordToggle);
    if (input) input.type = 'password';
    const fieldName = document.querySelector(`label[for="${input?.id}"]`)?.textContent.toLowerCase() || 'mot de passe';
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', `Afficher : ${fieldName}`);
    button.querySelector('span').textContent = 'Afficher';
  });
}

function bindEvents() {
  document.querySelectorAll('[data-password-toggle]').forEach(button => {
    button.addEventListener('click', () => togglePasswordVisibility(button));
  });
  new Set(Array.from(document.querySelectorAll('[data-password-toggle]'), button => button.closest('form'))).forEach(form => {
    form.addEventListener('reset', () => resetPasswordVisibility(form));
  });
  document.getElementById('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const error = document.getElementById('login-error');
    const button = document.getElementById('login-submit');
    error.textContent = '';
    button.disabled = true;
    try {
      const data = await apiRequest('/api/login', {
        auth: false,
        method: 'POST',
        body: JSON.stringify({
          username: document.getElementById('login-username').value.trim(),
          password: document.getElementById('login-password').value
        })
      });
      localStorage.setItem(TOKEN_KEY, data.token);
      localStorage.setItem(USER_KEY, JSON.stringify({ username: data.username, role: data.role }));
      document.getElementById('login-form').reset();
      await showMainPage({ username: data.username, role: data.role });
    } catch (requestError) {
      error.textContent = requestError.message;
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById('register-form').addEventListener('submit', async event => {
    event.preventDefault();
    const error = document.getElementById('register-error');
    const success = document.getElementById('register-success');
    error.textContent = '';
    success.textContent = '';
    try {
      await apiRequest('/api/register', {
        auth: false,
        method: 'POST',
        body: JSON.stringify({
          username: document.getElementById('register-username').value.trim(),
          password: document.getElementById('register-password').value
        })
      });
      success.textContent = 'Demande envoyée. Un administrateur doit accepter votre compte avant la connexion.';
      document.getElementById('login-username').value = document.getElementById('register-username').value.trim();
      document.getElementById('register-form').reset();
      setTimeout(() => showAuthPage('login'), 900);
    } catch (requestError) {
      error.textContent = requestError.message;
    }
  });

  document.getElementById('show-register').addEventListener('click', event => {
    event.preventDefault();
    showAuthPage('register');
  });
  document.getElementById('show-login').addEventListener('click', event => {
    event.preventDefault();
    showAuthPage('login');
  });
  document.getElementById('recipe-search').addEventListener('input', renderRecipes);
  document.getElementById('recipe-sort').addEventListener('change', event => {
    recipeSort = event.target.value;
    renderRecipes();
  });
  document.getElementById('clear-recipe-filters').addEventListener('click', () => {
    activeCategory = null;
    document.getElementById('recipe-search').value = '';
    renderRecipes();
    document.getElementById('recipe-search').focus();
  });
  document.getElementById('random-recipe-btn').addEventListener('click', () => {
    if (!recipes.length) return;
    const candidates = activeCategory === '__favorites__'
      ? recipes.filter(recipe => personalLibrary.favorites.includes(recipe.id))
      : activeCategory ? recipes.filter(recipe => recipeCategory(recipe) === activeCategory) : recipes;
    const recipe = candidates[Math.floor(Math.random() * candidates.length)];
    if (recipe) openRecipe(recipe.id);
  });
  document.getElementById('estimate-nutrition-btn').addEventListener('click', estimateRecipeNutrition);
  document.getElementById('recipe-form-servings').addEventListener('input', markNutritionEstimateStale);
  ['nutrition-calories', 'nutrition-protein', 'nutrition-carbs', 'nutrition-fat', 'nutrition-fiber'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => { nutritionEstimated = false; });
  });
  document.getElementById('recipe-form').addEventListener('submit', saveRecipe);
  document.getElementById('recipe-form-photo').addEventListener('change', previewSelectedRecipePhoto);
  document.getElementById('remove-recipe-photo-btn').addEventListener('click', removeCurrentRecipePhoto);
  document.getElementById('illustrate-recipe-photo-btn').addEventListener('click', illustrateCurrentRecipePhoto);
  document.getElementById('add-recipe-ingredient-btn').addEventListener('click', () => addRecipeIngredientRow());
  document.getElementById('add-recipe-step-btn').addEventListener('click', () => addRecipeStepRow().focus());
  document.getElementById('app-launcher-btn').addEventListener('click', event => {
    event.stopPropagation();
    toggleAppLauncher();
  });
  document.querySelectorAll('[data-launcher-target]').forEach(button => {
    button.addEventListener('click', () => openLauncherTarget(button.dataset.launcherTarget));
  });
  document.getElementById('add-item-form').addEventListener('submit', addShoppingItem);
  document.getElementById('delete-checked-shopping-btn').addEventListener('click', deleteCheckedShoppingItems);
  document.getElementById('menu-recipe-search').addEventListener('input', renderMenuRecipes);
  document.getElementById('menu-add-shopping-btn').addEventListener('click', addWeeklyMenuToShoppingList);
  document.getElementById('menu-clear-btn').addEventListener('click', clearWeeklyMenu);
  document.getElementById('cooking-prev-btn').addEventListener('click', () => changeCookingStep(-1));
  document.getElementById('cooking-next-btn').addEventListener('click', () => changeCookingStep(1));
  document.getElementById('banner-logo-img').addEventListener('click', () => {
    const destination = getStoredUser()?.role === 'admin' ? 'admin' : 'recipes';
    switchNav(destination);
    if (destination === 'admin') loadAdminDashboard();
  });
  document.getElementById('add-recipe-btn').addEventListener('click', showAddRecipeForm);
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
  document.getElementById('profile-form').addEventListener('submit', saveProfile);
  document.getElementById('profile-password-form').addEventListener('submit', changeOwnPassword);
  document.getElementById('biometric-login-btn').addEventListener('click', loginWithBiometrics);
  document.getElementById('register-biometric-btn').addEventListener('click', registerBiometricCredential);
  document.getElementById('goto-gym-btn').addEventListener('click', openGym);
  document.querySelector('#recipe-form-modal .modal-actions .secondary-btn').addEventListener('click', hideRecipeForm);
  document.querySelectorAll('.nav-btn').forEach(button => button.addEventListener('click', () => {
    switchNav(button.dataset.nav);
    if (button.dataset.nav === 'admin') loadAdminDashboard();
    if (button.dataset.nav === 'recipes' && !recipes.length) loadRecipes();
    if (button.dataset.nav === 'shopping') loadShoppingList();
    if (button.dataset.nav === 'menu') loadWeeklyMenu();
    if (button.dataset.nav === 'trash') loadRecipeTrash();
  }));
  document.getElementById('trash-refresh-btn').addEventListener('click', loadRecipeTrash);
  document.getElementById('sessions-refresh-btn').addEventListener('click', loadSessions);
  document.getElementById('admin-refresh-btn').addEventListener('click', loadAdminDashboard);
  document.getElementById('admin-stat-details-close').addEventListener('click', closeAdminStatDetails);
  document.getElementById('admin-logins-tab').addEventListener('click', () => switchAdminJournalView('logins'));
  document.getElementById('admin-passwords-tab').addEventListener('click', () => switchAdminJournalView('passwords'));
  document.getElementById('admin-actions-tab').addEventListener('click', () => switchAdminJournalView('actions'));
  ['admin-log-search', 'admin-log-result', 'admin-log-from', 'admin-log-to'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => renderAdminLogs(adminLogs));
  });
  document.getElementById('admin-log-reset-btn').addEventListener('click', resetAdminLogFilters);
  document.getElementById('admin-log-export-btn').addEventListener('click', exportAdminLogsCsv);
  document.getElementById('admin-create-user-form').addEventListener('submit', createAdminUser);
  document.getElementById('admin-load-more-btn').addEventListener('click', loadMoreAdminLogs);
  document.querySelectorAll('.close-modal').forEach(button => button.addEventListener('click', () => closeModal(button.closest('.modal'))));
  document.querySelectorAll('.modal').forEach(modal => modal.addEventListener('click', event => {
    if (event.target === modal) closeModal(modal);
  }));
  document.getElementById('logout-btn-modal').addEventListener('click', handleLogout);
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase('fr') === 'k') {
      event.preventDefault();
      const search = document.getElementById('recipe-search');
      if (!document.getElementById('main-page').classList.contains('hidden')) search.focus();
      return;
    }
    if (event.key === 'Escape') {
      closeAppLauncher();
      document.querySelectorAll('.modal:not(.hidden)').forEach(closeModal);
    }
  });
  document.addEventListener('click', event => {
    if (!event.target.closest('.app-launcher-wrap')) closeAppLauncher();
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  const dark = localStorage.getItem('goodwater-theme') === 'dark';
  document.body.classList.toggle('dark', dark);
  document.getElementById('theme-icon').textContent = dark ? '☀️' : '🌙';
  initializeLogo();
  bindEvents();
  try {
    const legacyShareMatch = window.location.pathname.match(/^\/(?:share|r)\/([^/]+)$/);
    const readableShareMatch = window.location.pathname.match(/^\/[^/]+\/([A-Za-z0-9_-]{20})$/);
    const shareToken = readableShareMatch?.[1] || legacyShareMatch?.[1];
    if (shareToken) await showSharedRecipe(decodeURIComponent(shareToken));
    else await restoreSession();
  } finally {
    await hideAppSplash();
  }
});

window.addEventListener('pageshow', () => {
  if (!document.getElementById('recipe-form-modal')?.classList.contains('hidden')) {
    requestAnimationFrame(resizeAllRecipeSteps);
  }
});

window.addEventListener('resize', () => {
  if (!document.getElementById('recipe-form-modal')?.classList.contains('hidden')) {
    resizeAllRecipeSteps();
  }
});
