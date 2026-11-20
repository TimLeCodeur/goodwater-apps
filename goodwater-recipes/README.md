# Goodwater Recipes

Goodwater Recipes est une application web pour gérer des recettes Cooklang, un menu hebdomadaire et une liste de courses. Elle comprend également un espace d’administration pour les comptes, les sessions, les journaux de sécurité et la corbeille des recettes.

## Architecture

- `app.js` : serveur Express, API REST, authentification JWT, sessions et accès SQLite.
- `public/index.html` : structure de l’application monopage.
- `public/script.js` : contrôleur de l’interface et appels API.
- `public/style.css` : thème responsive clair et sombre.
- `public/registration-action.js` : validation d’une inscription depuis le lien reçu par courriel.
- Les données personnelles (recettes, images et base SQLite) sont générées ou
  ajoutées localement et ne sont pas incluses dans cette copie.

## Configuration

```bash
cp .env.example .env
npm install
npm start
```

`JWT_SECRET` est obligatoire. En production, `ADMIN_PASSWORD` doit être défini avant le premier démarrage afin de créer le compte administrateur initial. Les secrets et la base SQLite ne doivent pas être versionnés.

## Vérifications

```bash
npm run check          # vérification syntaxique
npm test               # suite complète
npm run test:api       # API et interface statique
npm run test:security  # tests sécurité
npm audit --omit=dev   # dépendances de production
```

## Rôles

- `viewer` : consultation des recettes.
- `editor` : consultation et modification de ses propres recettes.
- `grand_chef` : gestion de toutes les recettes et de la corbeille.
- `admin` : gestion des comptes, sessions, statistiques et restaurations.

## Principes de sécurité

- mots de passe hachés avec bcrypt ;
- JWT associés à des sessions révocables en base ;
- validation des entrées et requêtes SQLite paramétrées ;
- limitation des tentatives de connexion et des appels sensibles ;
- en-têtes Helmet, politique CORS et limite de taille des requêtes ;
- journalisation des connexions et actions administratives ;
- tests automatisés sur les routes protégées et la structure du frontend.

Les bases SQLite, recettes personnelles, images locales et secrets de
déploiement ne sont pas inclus dans cette copie.
