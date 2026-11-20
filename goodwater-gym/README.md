# Goodwater Gym

Application de suivi d'entraînement et d'exercices.

## Développement

```bash
npm install
npm run check
npm start
```

Configure `JWT_SECRET` in the process environment with a unique value of at
least 32 characters before starting the server.
Le serveur utilise le port `3002` par défaut. L'authentification partage la
base SQLite de Goodwater Recipes par défaut. Si cette base se trouve ailleurs,
configure la variable d'environnement `AUTH_DB_PATH` avec son chemin. Ne
versionne pas les secrets ni les bases SQLite.

Les données d'exercices sont dans `data/exercises-dataset.json`. Les images
exigent l'attribution et le respect des conditions décrites dans
[`EXERCISES_DATASET_LICENSE`](EXERCISES_DATASET_LICENSE) et
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
