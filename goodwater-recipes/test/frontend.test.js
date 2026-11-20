// Contrôles statiques simples pour prévenir les régressions de l'interface.
const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(PUBLIC_DIR, 'script.js'), 'utf8');
const style = fs.readFileSync(path.join(PUBLIC_DIR, 'style.css'), 'utf8');

describe('Goodwater Recipes - Interface statique', function() {
  it('ne contient aucun identifiant HTML dupliqué', function() {
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
    expect(new Set(ids).size).to.equal(ids.length);
  });

  it('déclare les éléments utilisés par getElementById', function() {
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]));
    const references = [...script.matchAll(/getElementById\(['"]([^'"]+)/g)].map(match => match[1]);
    const missingIds = [...new Set(references.filter(id => !ids.has(id)))];
    expect(missingIds).to.deep.equal([]);
  });

  it('n’utilise pas de gestionnaire onclick en ligne', function() {
    expect(html).not.to.match(/\sonclick=/i);
  });

  it('garde des accolades CSS équilibrées', function() {
    const withoutComments = style.replace(/\/\*[\s\S]*?\*\//g, '');
    const depth = [...withoutComments].reduce((value, character) => {
      if (character === '{') return value + 1;
      if (character === '}') return value - 1;
      return value;
    }, 0);
    expect(depth).to.equal(0);
  });
});
