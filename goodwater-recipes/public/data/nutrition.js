(function exposeNutritionCalculator(root) {
  const NUTRIENTS = ['kcal', 'protein', 'carbs', 'fat', 'fiber'];

  function normalize(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('fr')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function searchFoods(query, foods, limit = 12) {
    const normalizedQuery = normalize(query);
    if (!normalizedQuery) return [];
    const queryWords = normalizedQuery.split(/\s+/);

    return foods.map(food => {
      const name = normalize(food.name);
      const nameWords = new Set(name.split(/\s+/));
      const matchedWords = queryWords.filter(word => nameWords.has(word));
      let score = 0;
      if (name === normalizedQuery) score = 10000;
      else if (name.includes(normalizedQuery)) score = 7000 - (name.length - normalizedQuery.length);
      else if (matchedWords.length === queryWords.length) score = 4000 + matchedWords.length;
      else if (matchedWords.length) score = matchedWords.length * 100;
      return { food, score };
    })
      .filter(result => result.score > 0)
      .sort((a, b) => b.score - a.score || a.food.name.localeCompare(b.food.name, 'fr'))
      .slice(0, limit)
      .map(result => result.food);
  }

  function parseGrams(quantity, unit = '') {
    const match = String(quantity || '').trim().replace(',', '.')
      .match(/^(\d+(?:\.\d+)?|\d+\s*\/\s*\d+)\s*([a-z]+)?$/i);
    if (!match) return null;

    const amount = match[1].includes('/')
      ? Number(match[1].split('/')[0]) / Number(match[1].split('/')[1])
      : Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) return null;

    const normalizedUnit = normalize(unit || match[2] || '')
      .replace(/^(grammes?|gr)$/, 'g')
      .replace(/^(kilogrammes?|kilos?)$/, 'kg');
    if (normalizedUnit === 'g') return amount;
    if (normalizedUnit === 'kg') return amount * 1000;
    return null;
  }

  function estimate(ingredients, foods, servings) {
    const byCode = new Map(foods.map(food => [String(food.code), food]));
    const resolved = [];
    const issues = [];

    if (!ingredients.length) return { complete: false, issues: ['Ajoutez au moins un ingrédient.'] };

    ingredients.forEach(ingredient => {
      const food = byCode.get(String(ingredient.ciqualCode || ''));
      const grams = parseGrams(ingredient.quantity, ingredient.unit);
      if (!food) issues.push(`${ingredient.name} : choisissez un aliment Ciqual.`);
      if (grams === null) issues.push(`${ingredient.name} : indiquez une quantité en grammes.`);
      if (food && grams !== null) resolved.push({ food, grams });
    });

    if (issues.length) return { complete: false, issues };

    const portionCount = Number(servings);
    if (!Number.isInteger(portionCount) || portionCount < 1) {
      return { complete: false, issues: ['Indiquez un nombre de portions valide.'] };
    }

    const perServing = {};
    for (const nutrient of NUTRIENTS) {
      const values = resolved.map(({ food }) => food[nutrient]);
      perServing[nutrient] = values.some(value => !Number.isFinite(value))
        ? null
        : Math.round(resolved.reduce((total, item) => total + item.food[nutrient] * item.grams / 100, 0) / portionCount * 10) / 10;
    }

    return { complete: true, perServing };
  }

  const api = { normalize, searchFoods, parseGrams, estimate };
  root.GoodwaterNutrition = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
