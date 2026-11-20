const { expect } = require('chai');
const { estimate, parseGrams, searchFoods } = require('../public/data/nutrition');

describe('Calcul nutritionnel CIQUAL', function() {
  const foods = [
    { code: '100', name: 'Farine de blé', kcal: 350, protein: 10, carbs: 70, fat: 2, fiber: 3 },
    { code: '200', name: 'Huile d’olive', kcal: 900, protein: 0, carbs: 0, fat: 100, fiber: 0 }
  ];

  it('convertit uniquement les poids explicites en grammes', function() {
    expect(parseGrams('250', 'g')).to.equal(250);
    expect(parseGrams('0,5', 'kg')).to.equal(500);
    expect(parseGrams('1/2', 'kg')).to.equal(500);
    expect(parseGrams('2', 'càs')).to.equal(null);
    expect(parseGrams('2', '')).to.equal(null);
  });

  it('calcule les nutriments par portion à partir des valeurs pour 100 g', function() {
    const result = estimate([
      { name: 'farine', quantity: '200', unit: 'g', ciqualCode: '100' },
      { name: 'huile', quantity: '20', unit: 'g', ciqualCode: '200' }
    ], foods, 2);

    expect(result.complete).to.equal(true);
    expect(result.perServing).to.deep.equal({ kcal: 440, protein: 10, carbs: 70, fat: 12, fiber: 3 });
  });

  it('refuse un calcul si une fiche ou une quantité manque', function() {
    const result = estimate([
      { name: 'farine', quantity: '200', unit: 'g', ciqualCode: '' },
      { name: 'huile', quantity: '1', unit: 'càs', ciqualCode: '200' }
    ], foods, 1);

    expect(result.complete).to.equal(false);
    expect(result.issues).to.have.length(2);
  });

  it('cherche les aliments sans perdre les accents saisis', function() {
    expect(searchFoods('huile olive', foods, 1)[0].code).to.equal('200');
  });
});
