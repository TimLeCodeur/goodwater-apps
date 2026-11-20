'use strict';

const fs = require('fs');
const path = require('path');

const recipesDir = process.env.RECIPES_DIR || path.join(__dirname, '..', 'data', 'recipes');
const applyChanges = process.argv.includes('--apply');
const nutritionMetadata = /^\s*>>\s*(calories|protein|carbs|fat|fiber|nutrition_status|nutrition_message|nutrition_foods|nutrition_dataset)\s*:.*<<\s*$/i;
const servingsMetadata = /^\s*>>\s*servings\s*:\s*\d+\s*<<\s*$/i;
const replacementMetadata = [
  '>> nutrition_status: incomplete <<',
  '>> nutrition_message: À compléter : associez chaque ingrédient à une fiche CIQUAL et renseignez son poids en grammes. <<',
  '>> nutrition_dataset: CIQUAL 2025 <<'
];

for (const filename of fs.readdirSync(recipesDir).filter(name => name.endsWith('.cook') && name !== 'test.cook').sort()) {
  const filePath = path.join(recipesDir, filename);
  const original = fs.readFileSync(filePath, 'utf8');
  const lines = original.replace(/\r\n/g, '\n').split('\n').filter(line => !nutritionMetadata.test(line));
  const servingsIndex = lines.findIndex(line => servingsMetadata.test(line));
  lines.splice(servingsIndex >= 0 ? servingsIndex + 1 : 1, 0, ...replacementMetadata);
  const updated = lines.join('\n').replace(/\n{3,}/g, '\n\n');

  if (updated === original) continue;
  console.log(`${applyChanges ? 'Updated' : 'Would update'} ${filename}: legacy values removed; nutrition marked incomplete.`);
  if (applyChanges) fs.writeFileSync(filePath, updated, 'utf8');
}

if (!applyChanges) console.log('Dry run only. Re-run with --apply to write the changes.');
