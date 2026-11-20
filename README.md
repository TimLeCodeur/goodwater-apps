# Goodwater applications

> **Preparation copy:** this repository has a fresh, empty Git history and has
> not been pushed to GitHub. Review the files and test results before publishing.

This monorepo contains three independent Node.js applications:

- **Recipes** — recipe, menu, and shopping-list management.
- **Gym** — workout and exercise tracking.
- **Task** — task management.

Each application has its own `package.json` and can be installed from its
directory with `npm install`. The SQLite databases, JWT secrets, user records,
logs, and personal recipe files from the server are intentionally not included.
Create local runtime data and secrets on each deployment; never commit them.

## Requirements

- Node.js 20 or newer for Recipes.
- SQLite support as installed by each application's dependencies.
- A `JWT_SECRET` generated uniquely for each deployment (at least 32
  characters).

Recipes uses a `.env` file loaded by `dotenv`; start from
`goodwater-recipes/.env.example` and replace every placeholder locally. Gym and
Task read configuration from the process environment. Their default
`AUTH_DB_PATH` points to the Recipes SQLite database, so initialize Recipes
first or explicitly configure a compatible authentication database.

## Local development

```bash
cd goodwater-recipes
npm install
npm run check
npm start
```

Gym and Task have the same `npm install`, `npm run check`, and `npm start`
workflow from their respective directories. Configure `PORT`, `JWT_SECRET`,
and `AUTH_DB_PATH` in the process environment before starting them.

## Data and licenses

The Gym exercise dataset and its media have separate licensing and attribution
terms. Read [goodwater-gym/EXERCISES_DATASET_LICENSE](goodwater-gym/EXERCISES_DATASET_LICENSE)
and [goodwater-gym/THIRD_PARTY_NOTICES.md](goodwater-gym/THIRD_PARTY_NOTICES.md)
before reusing them. Other third-party notices are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The root MIT license does not
override those terms.

## Publication status

The Recipes test files are included. Run `npm test` from
`goodwater-recipes/` before publication. No source repository history or runtime
data has been copied into this fresh repository.
