# Goodwater Task

Application de gestion des tâches.

## Développement

```bash
npm install
npm run check
npm start
```

Configure `JWT_SECRET` in the process environment with a unique value of at
least 32 characters before starting the server.
Le serveur utilise le port `3001` par défaut. L'authentification partage la
base SQLite de Goodwater Recipes par défaut. Si cette base se trouve ailleurs,
configure la variable d'environnement `AUTH_DB_PATH` avec son chemin. Ne
versionne pas les secrets ni les bases SQLite.
