const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3002;
const DATA_DIR = path.join(__dirname, 'data');
const JWT_SECRET_FILE = path.join(DATA_DIR, '.jwt-secret');
const AUTH_DB_PATH = process.env.AUTH_DB_PATH || path.resolve(__dirname, '../goodwater-recipes/data/db.sqlite');
const EXERCISE_DATASET_PATH = path.join(DATA_DIR, 'exercises-dataset.json');
fs.ensureDirSync(DATA_DIR);

function getJwtSecret() {
  if (typeof process.env.JWT_SECRET === 'string' && process.env.JWT_SECRET.length >= 32) return process.env.JWT_SECRET;
  if (fs.existsSync(JWT_SECRET_FILE)) return fs.readFileSync(JWT_SECRET_FILE, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(JWT_SECRET_FILE, secret, { mode: 0o600 });
  return secret;
}

const JWT_SECRET = getJwtSecret();
const webauthnPromise = import('@simplewebauthn/server');
const passkeyChallenges = new Map();
const WEBAUTHN_RP_ID = 'goodwater-recipes.fr';
const WEBAUTHN_ORIGIN = 'https://gym.goodwater-recipes.fr';
app.set('trust proxy', 'loopback');

// Prevent crashes
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
  process.exit(1);
});

// Middleware
app.use(cors({ origin: false }));
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://raw.githubusercontent.com'],
      connectSrc: ["'self'"]
    }
  }
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: '1h',
  setHeaders(res, filePath) {
    if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));
app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'goodwater-gym' }));

// ============ BASE DE DONNÉES ============
const dbPath = path.join(DATA_DIR, 'gym.db');
fs.ensureDirSync(path.dirname(dbPath));
const db = new sqlite3.Database(dbPath);
const authDb = new sqlite3.Database(AUTH_DB_PATH, sqlite3.OPEN_READWRITE, err => {
  if (err) console.error(`Impossible d'ouvrir la base utilisateurs partagée: ${err.message}`);
});
authDb.run('PRAGMA busy_timeout = 5000');
authDb.serialize(() => {
  authDb.run(`CREATE TABLE IF NOT EXISTS passkeys (
    credential_id TEXT PRIMARY KEY, username TEXT NOT NULL, public_key BLOB NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0, transports TEXT DEFAULT '[]', device_type TEXT DEFAULT '',
    backed_up INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  authDb.run("ALTER TABLE passkeys ADD COLUMN device_label TEXT DEFAULT ''", () => {});
  authDb.run("ALTER TABLE passkeys ADD COLUMN browser_name TEXT DEFAULT ''", () => {});
  authDb.run("ALTER TABLE passkeys ADD COLUMN user_agent TEXT DEFAULT ''", () => {});
  authDb.run('CREATE INDEX IF NOT EXISTS idx_passkeys_username ON passkeys(username)');
});

function cleanText(value, maxLength) { return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''; }
function describeUserAgent(userAgent = '') {
  const ua = cleanText(userAgent, 500);
  let deviceLabel = 'Appareil non identifié';
  if (/iPhone/i.test(ua)) deviceLabel = 'iPhone';
  else if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && /Mobile/i.test(ua))) deviceLabel = 'iPad';
  else if (/Android/i.test(ua)) deviceLabel = ua.match(/Android[^;]*;\s*([^;)]+?)(?:\s+Build\/|[;)])/i)?.[1]?.trim() || 'Appareil Android';
  else if (/Windows/i.test(ua)) deviceLabel = 'Ordinateur Windows';
  else if (/Macintosh|Mac OS X/i.test(ua)) deviceLabel = 'Mac';
  else if (/CrOS/i.test(ua)) deviceLabel = 'Chromebook';
  else if (/Linux/i.test(ua)) deviceLabel = 'Ordinateur Linux';
  let browserName = 'Navigateur non identifié';
  if (/EdgiOS|EdgA|Edg\//i.test(ua)) browserName = 'Microsoft Edge';
  else if (/CriOS|Chrome\//i.test(ua)) browserName = 'Google Chrome';
  else if (/FxiOS|Firefox\//i.test(ua)) browserName = 'Mozilla Firefox';
  else if (/OPiOS|OPR\//i.test(ua)) browserName = 'Opera';
  else if (/Safari\//i.test(ua)) browserName = 'Safari';
  return { deviceLabel, browserName, userAgent:ua };
}

// Initialisation des tables
db.serialize(() => {
  db.run('PRAGMA foreign_keys = ON');
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA busy_timeout = 5000');
  db.run(`CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    password TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS exercises (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    muscle_group TEXT,
    equipment TEXT,
    user_id TEXT,
    is_default INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  // Métadonnées du catalogue open-source exercises-dataset.
  const exerciseColumns = [
    ['source_id', 'TEXT'], ['target', 'TEXT'], ['secondary_muscles', 'TEXT'],
    ['instructions', 'TEXT'], ['image_url', 'TEXT'], ['gif_url', 'TEXT'], ['attribution', 'TEXT']
  ];
  db.all('PRAGMA table_info(exercises)', (columnError, columns) => {
    if (columnError) return console.error('Lecture du schéma exercises impossible:', columnError);
    const existing = new Set(columns.map(column => column.name));
    const missing = exerciseColumns.filter(([name]) => !existing.has(name));
    let remaining = missing.length;
    const finishMigration = () => {
      if (--remaining > 0) return;
      db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_exercises_source ON exercises(source_id) WHERE source_id IS NOT NULL', importExerciseDataset);
    };
    if (!missing.length) return db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_exercises_source ON exercises(source_id) WHERE source_id IS NOT NULL', importExerciseDataset);
    missing.forEach(([name, type]) => db.run(`ALTER TABLE exercises ADD COLUMN ${name} ${type}`, error => {
      if (error) console.error(`Ajout de la colonne ${name} impossible:`, error);
      finishMigration();
    }));
  });

  db.run(`CREATE TABLE IF NOT EXISTS workouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    date TEXT DEFAULT CURRENT_TIMESTAMP,
    name TEXT,
    notes TEXT,
    duration INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(username)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS workout_sets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workout_id INTEGER NOT NULL,
    exercise_id INTEGER NOT NULL,
    set_number INTEGER NOT NULL,
    reps INTEGER,
    weight REAL,
    rpe REAL,
    is_warmup INTEGER DEFAULT 0,
    is_drop INTEGER DEFAULT 0,
    is_failure INTEGER DEFAULT 0,
    notes TEXT,
    completed INTEGER DEFAULT 0,
    FOREIGN KEY (workout_id) REFERENCES workouts(id),
    FOREIGN KEY (exercise_id) REFERENCES exercises(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS personal_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    exercise_id INTEGER NOT NULL,
    weight REAL,
    reps INTEGER,
    date TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(username),
    FOREIGN KEY (exercise_id) REFERENCES exercises(id),
    UNIQUE(user_id, exercise_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS workout_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS workout_template_exercises (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER NOT NULL,
    exercise_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    sets INTEGER DEFAULT 3,
    reps INTEGER DEFAULT 10,
    weight REAL DEFAULT 0,
    FOREIGN KEY (template_id) REFERENCES workout_templates(id) ON DELETE CASCADE,
    FOREIGN KEY (exercise_id) REFERENCES exercises(id)
  )`);
  db.all('PRAGMA table_info(workout_template_exercises)', (error, columns) => {
    if (!error && !columns.some(column => column.name === 'weight')) {
      db.run('ALTER TABLE workout_template_exercises ADD COLUMN weight REAL DEFAULT 0');
    }
  });
  db.run('CREATE INDEX IF NOT EXISTS idx_workouts_user_date ON workouts(user_id, date DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_workout_sets_workout ON workout_sets(workout_id, id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_records_user_date ON personal_records(user_id, date DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_exercises_user_name ON exercises(user_id, name)');

  // Exercises par défaut
  db.get("SELECT COUNT(*) as count FROM exercises WHERE is_default = 1", (err, row) => {
    if (row && row.count === 0) {
      const defaultExercises = [
        ['Développé couché', 'Pectoraux', 'Barre'],
        ['Squat', 'Quadriceps', 'Barre'],
        ['Soulevé de terre', 'Dos', 'Barre'],
        ['Développé militaire', 'Épaules', 'Barre'],
        ['Rowing barre', 'Dos', 'Barre'],
        ['Curl biceps', 'Biceps', 'Barre'],
        ['Extension triceps', 'Triceps', 'Poids'],
        ['Leg press', 'Quadriceps', 'Machine'],
        ['Crunch abdos', 'Abdominaux', 'Poids'],
        ['Tirage menton', 'Dos', 'Barre'],
        ['Élévations latérales', 'Épaules', 'Poids'],
        ['Leg curl', 'Ischio-jambiers', 'Machine'],
        ['Pull-ups', 'Dos', 'Poids'],
        ['Dips', 'Pectoraux', 'Poids'],
        ['Hip thrust', 'Fessiers', 'Barre']
      ];
      const stmt = db.prepare("INSERT INTO exercises (name, muscle_group, equipment, is_default) VALUES (?, ?, ?, 1)");
      defaultExercises.forEach(([name, muscle, equip]) => stmt.run(name, muscle, equip));
      stmt.finalize();
      console.log('Exercices par défaut créés');
    }
  });
});

const MUSCLE_LABELS = {
  back: 'Dos', cardio: 'Cardio', chest: 'Pectoraux', 'lower arms': 'Avant-bras',
  'lower legs': 'Mollets', neck: 'Cou', shoulders: 'Épaules', 'upper arms': 'Bras',
  'upper legs': 'Jambes', waist: 'Abdominaux'
};
const EQUIPMENT_LABELS = {
  assisted:'assisté', band:'élastique', barbell:'barre', 'body weight':'poids du corps',
  'bosu ball':'ballon BOSU', cable:'poulie', dumbbell:'haltères', 'elliptical machine':'vélo elliptique',
  'ez barbell':'barre EZ', hammer:'marteau', kettlebell:'kettlebell', 'leverage machine':'machine guidée',
  'medicine ball':'médecine-ball', 'olympic barbell':'barre olympique', 'resistance band':'élastique de résistance',
  roller:'rouleau', rope:'corde', 'skierg machine':'machine SkiErg', sled:'traîneau', 'sled machine':'machine à traîneau',
  'smith machine':'machine Smith', 'stability ball':'ballon de stabilité', 'stationary bike':'vélo d’appartement',
  'stepmill machine':'escalier mécanique', tire:'pneu', 'trap bar':'barre hexagonale',
  'upper body ergometer':'ergomètre du haut du corps', weighted:'lesté', 'wheel roller':'roue abdominale'
};
const TARGET_LABELS = {
  abductors:'Abducteurs', abs:'Abdominaux', adductors:'Adducteurs', biceps:'Biceps', calves:'Mollets',
  'cardiovascular system':'Système cardiovasculaire', delts:'Deltoïdes', forearms:'Avant-bras', fessiers:'Fessiers', glutes:'Fessiers',
  hamstrings:'Ischio-jambiers', lats:'Grands dorsaux', 'levator scapulae':'Élévateur de la scapula',
  pectorals:'Pectoraux', quads:'Quadriceps', 'serratus anterior':'Dentelé antérieur', spine:'Colonne vertébrale',
  traps:'Trapèzes', triceps:'Triceps', 'upper back':'Haut du dos'
};

function importExerciseDataset() {
  if (!fs.existsSync(EXERCISE_DATASET_PATH)) return;
  let exercises;
  try { exercises = JSON.parse(fs.readFileSync(EXERCISE_DATASET_PATH, 'utf8')); }
  catch (error) { return console.error('Catalogue exercises-dataset invalide:', error); }
  db.get('SELECT COUNT(*) AS count FROM exercises WHERE source_id IS NOT NULL', (countError, row) => {
    if (countError) return;
    if (row?.count === exercises.length) return updateFrenchExerciseNames(exercises);
    const statement = db.prepare(`INSERT OR IGNORE INTO exercises
      (name, muscle_group, equipment, is_default, source_id, target, secondary_muscles, instructions, image_url, gif_url, attribution)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`);
    exercises.forEach(exercise => statement.run(
      exercise.name_fr || exercise.name, MUSCLE_LABELS[exercise.category] || exercise.category, EQUIPMENT_LABELS[exercise.equipment] || exercise.equipment,
      exercise.id, TARGET_LABELS[exercise.target] || exercise.target, JSON.stringify(exercise.secondary_muscles || []),
      exercise.instructions_fr, exercise.image, exercise.gif_url, exercise.attribution
    ));
    statement.finalize(error => error
      ? console.error('Import exercises-dataset impossible:', error)
      : updateFrenchExerciseNames(exercises));
  });
}

function updateFrenchExerciseNames(exercises) {
  const statement = db.prepare('UPDATE exercises SET name = ?, equipment = ?, target = ? WHERE source_id = ?');
  exercises.forEach(exercise => statement.run(
    exercise.name_fr || exercise.name,
    EQUIPMENT_LABELS[exercise.equipment] || exercise.equipment,
    TARGET_LABELS[exercise.target] || exercise.target,
    exercise.id
  ));
  statement.finalize(updateError => updateError
    ? console.error('Francisation des exercices impossible:', updateError)
    : console.log(`${exercises.length} noms d’exercices disponibles en français`));
}

// ============ AUTH ============
function getCookie(req, name) {
  const cookie = String(req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : '';
}

function setSsoCookie(res, sessionId, maxAge = 86400) {
  res.setHeader('Set-Cookie', `gw_session=${encodeURIComponent(sessionId)}; Domain=.goodwater-recipes.fr; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`);
}

function syncGymUser(user, callback) {
  db.run(
    `INSERT INTO users (username, password, role) VALUES (?, ?, ?)
     ON CONFLICT(username) DO UPDATE SET password = excluded.password, role = excluded.role`,
    [user.username, user.password || 'shared-account', user.role],
    callback
  );
}

function createSharedSession(req, res, user, callback) {
  const sessionId = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  authDb.run(
    'INSERT INTO sessions (id, username, user_agent, ip, expires_at) VALUES (?, ?, ?, ?, ?)',
    [sessionId, user.username, String(req.get('user-agent') || '').slice(0, 300), String(req.ip || '').slice(0, 100), expiresAt],
    error => {
      if (error) return callback(error);
      const token = jwt.sign({ username: user.username, role: user.role, sid: sessionId }, JWT_SECRET, { expiresIn: '24h' });
      setSsoCookie(res, sessionId);
      callback(null, token);
    }
  );
}

function acceptSharedUser(req, res, next, user, sessionId = null) {
  if (user.blocked_until && new Date(user.blocked_until).getTime() > Date.now()) {
    return res.status(403).json({ error: 'Compte temporairement bloqué' });
  }
  syncGymUser(user, syncError => {
    if (syncError) return res.status(500).json({ error: 'Erreur lors de la préparation du compte Gym' });
    req.user = { username: user.username, role: user.role };
    req.sessionId = sessionId;
    if (sessionId) authDb.run('UPDATE sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?', [sessionId]);
    next();
  });
}

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    const sessionId = getCookie(req, 'gw_session');
    if (!sessionId) return res.status(401).json({ error: 'Token requis' });
    return authDb.get(
      `SELECT u.username, u.password, u.role, u.blocked_until FROM sessions s
       JOIN users u ON u.username = s.username
       WHERE s.id = ? AND s.revoked_at IS NULL AND datetime(s.expires_at) > datetime('now')`,
      [sessionId],
      (error, user) => {
        if (error) return res.status(500).json({ error: 'Erreur lors de la vérification du compte' });
        if (!user) return res.status(401).json({ error: 'Session expirée' });
        acceptSharedUser(req, res, next, user, sessionId);
      }
    );
  }

  let decoded;
  try { decoded = jwt.verify(token, JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Token invalide' }); }
  authDb.get(
    'SELECT username, password, role, blocked_until FROM users WHERE username = ?',
    [decoded.username],
    (error, user) => {
      if (error) return res.status(500).json({ error: 'Erreur lors de la vérification du compte' });
      if (!user) return res.status(401).json({ error: 'Utilisateur introuvable' });
      if (!decoded.sid) return acceptSharedUser(req, res, next, user);
      authDb.get(
        `SELECT id FROM sessions WHERE id = ? AND username = ? AND revoked_at IS NULL
         AND datetime(expires_at) > datetime('now')`,
        [decoded.sid, decoded.username],
        (sessionError, session) => {
          if (sessionError) return res.status(500).json({ error: 'Erreur lors de la vérification de la session' });
          if (!session) return res.status(401).json({ error: 'Session expirée' });
          acceptSharedUser(req, res, next, user, decoded.sid);
        }
      );
    }
  );
};

// Rate limiting
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { error: 'Trop de demandes' }
});
const loginLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, message: { error: 'Trop de tentatives, réessayez dans quelques minutes' } });

app.post('/api/register', registerLimiter, async (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!/^[a-zA-Z0-9_-]{3,30}$/.test(username)) return res.status(400).json({ error: 'Le nom utilisateur doit contenir entre 3 et 30 lettres, chiffres, tirets ou underscores' });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Le mot de passe doit contenir entre 8 et 128 caractères' });
  authDb.get(
    `SELECT 1 AS found FROM users WHERE username = ?
     UNION ALL SELECT 1 FROM pending_users WHERE username = ? AND status = 'pending' LIMIT 1`,
    [username, username],
    async (lookupError, existing) => {
      if (lookupError) return res.status(500).json({ error: 'Erreur lors de la demande' });
      if (existing) return res.status(409).json({ error: 'Ce nom utilisateur existe déjà ou attend une validation' });
      const hashedPassword = await bcrypt.hash(password, 12);
      authDb.run(
        'INSERT INTO pending_users (username, password, request_ip) VALUES (?, ?, ?)',
        [username, hashedPassword, String(req.ip || '').slice(0, 100)],
        error => error
          ? res.status(500).json({ error: 'Erreur lors de la demande' })
          : res.status(202).json({ message: 'Demande envoyée. Un administrateur doit valider votre compte.' })
      );
    }
  );
});

app.post('/api/login', loginLimiter, async (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim().slice(0, 30) : '';
  const password = typeof req.body.password === 'string' ? req.body.password.slice(0, 128) : '';
  if (!username || !password) return res.status(400).json({ error: 'Identifiants requis' });
  authDb.get('SELECT username, password, role, blocked_until FROM users WHERE username = ?', [username], async (error, user) => {
    if (error) return res.status(500).json({ error: 'Erreur du serveur' });
    if (!user) return res.status(401).json({ error: 'Identifiants invalides' });
    if (user.blocked_until && new Date(user.blocked_until).getTime() > Date.now()) return res.status(403).json({ error: 'Compte temporairement bloqué' });
    if (!await bcrypt.compare(password, user.password)) return res.status(401).json({ error: 'Identifiants invalides' });
    syncGymUser(user, syncError => {
      if (syncError) return res.status(500).json({ error: 'Erreur lors de la préparation du compte Gym' });
      createSharedSession(req, res, user, (sessionError, token) => {
        if (sessionError) return res.status(500).json({ error: 'Erreur lors de la création de la session' });
        res.json({ message: 'Connexion réussie', token, username: user.username, role: user.role });
      });
    });
  });
});

app.get('/api/session', authMiddleware, (req, res) => {
  res.json({ username: req.user.username, role: req.user.role });
});

app.post('/api/logout', authMiddleware, (req, res) => {
  const finish = () => {
    setSsoCookie(res, '', 0);
    res.json({ message: 'Déconnexion effectuée' });
  };
  if (!req.sessionId) return finish();
  authDb.run('UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?', [req.sessionId], () => finish());
});

app.get('/api/profile', authMiddleware, (req, res) => {
  authDb.get(`SELECT username, role, COALESCE(first_name, '') AS firstName,
    COALESCE(last_name, '') AS lastName, COALESCE(description, '') AS description
    FROM users WHERE username = ?`, [req.user.username], (error, profile) => {
    if (error) return res.status(500).json({ error: 'Erreur lors du chargement du profil' });
    if (!profile) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    res.json(profile);
  });
});

app.put('/api/profile', authMiddleware, (req, res) => {
  const firstName = typeof req.body.firstName === 'string' ? req.body.firstName.trim().slice(0, 60) : '';
  const lastName = typeof req.body.lastName === 'string' ? req.body.lastName.trim().slice(0, 60) : '';
  const description = typeof req.body.description === 'string' ? req.body.description.trim().slice(0, 500) : '';
  authDb.run('UPDATE users SET first_name = ?, last_name = ?, description = ? WHERE username = ?',
    [firstName, lastName, description, req.user.username], function(error) {
      if (error) return res.status(500).json({ error: 'Erreur lors de la mise à jour du profil' });
      if (!this.changes) return res.status(404).json({ error: 'Utilisateur non trouvé' });
      res.json({ username:req.user.username, role:req.user.role, firstName, lastName, description });
    });
});

app.put('/api/profile/password', authMiddleware, async (req, res) => {
  const currentPassword = typeof req.body.currentPassword === 'string' ? req.body.currentPassword : '';
  const newPassword = typeof req.body.newPassword === 'string' ? req.body.newPassword : '';
  const confirmPassword = typeof req.body.confirmPassword === 'string' ? req.body.confirmPassword : '';
  if (!currentPassword || !newPassword || !confirmPassword) return res.status(400).json({ error: 'Tous les champs sont requis' });
  if (newPassword !== confirmPassword) return res.status(400).json({ error: 'Les mots de passe ne correspondent pas' });
  if (newPassword.length < 8 || newPassword.length > 128) return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir entre 8 et 128 caractères' });
  authDb.get('SELECT password FROM users WHERE username = ?', [req.user.username], async (error, user) => {
    if (error || !user) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    if (!await bcrypt.compare(currentPassword, user.password)) return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
    const password = await bcrypt.hash(newPassword, 12);
    authDb.run('UPDATE users SET password = ? WHERE username = ?', [password, req.user.username], updateError => updateError
      ? res.status(500).json({ error: 'Impossible de modifier le mot de passe' })
      : res.json({ message: 'Mot de passe modifié sur tous les services' }));
  });
});

app.post('/api/passkeys/register/options', authMiddleware, async (req, res) => {
  try {
    const { generateRegistrationOptions } = await webauthnPromise;
    authDb.all('SELECT credential_id, transports FROM passkeys WHERE username = ?', [req.user.username], async (error, passkeys) => {
      if (error) return res.status(500).json({ error: 'Erreur lors du chargement des connexions biométriques' });
      const options = await generateRegistrationOptions({
        rpName:'Goodwater', rpID:WEBAUTHN_RP_ID, userName:req.user.username, userDisplayName:req.user.username,
        userID:crypto.createHash('sha256').update(req.user.username).digest(), attestationType:'none',
        excludeCredentials:passkeys.map(passkey => ({ id:passkey.credential_id, transports:JSON.parse(passkey.transports || '[]') })),
        authenticatorSelection:{ residentKey:'preferred', userVerification:'preferred' }
      });
      passkeyChallenges.set(`register:${req.user.username}`, { challenge:options.challenge, expires:Date.now() + 300000 });
      res.json(options);
    });
  } catch (error) { console.error('Passkey registration options:', error); res.status(500).json({ error:'Impossible de préparer la biométrie' }); }
});

app.post('/api/passkeys/register/verify', authMiddleware, async (req, res) => {
  const pending = passkeyChallenges.get(`register:${req.user.username}`);
  if (!pending || pending.expires < Date.now()) return res.status(400).json({ error:'Demande biométrique expirée' });
  try {
    const { verifyRegistrationResponse } = await webauthnPromise;
    const verification = await verifyRegistrationResponse({ response:req.body, expectedChallenge:pending.challenge, expectedOrigin:WEBAUTHN_ORIGIN, expectedRPID:WEBAUTHN_RP_ID });
    if (!verification.verified) return res.status(400).json({ error:'Connexion biométrique non vérifiée' });
    const info = verification.registrationInfo;
    const credential = info.credential;
    const device = describeUserAgent(req.get('user-agent'));
    authDb.run(`INSERT INTO passkeys (credential_id, username, public_key, counter, transports, device_type, backed_up, device_label, browser_name, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [credential.id, req.user.username, Buffer.from(credential.publicKey), credential.counter,
      JSON.stringify(credential.transports || req.body.response?.transports || []), info.credentialDeviceType, info.credentialBackedUp ? 1 : 0,
      device.deviceLabel, device.browserName, device.userAgent], error => {
        if (error) return res.status(error.code === 'SQLITE_CONSTRAINT' ? 409 : 500).json({ error:'Cette connexion biométrique est déjà enregistrée' });
        passkeyChallenges.delete(`register:${req.user.username}`);
        res.json({ verified:true });
      });
  } catch (error) { console.error('Passkey registration:', error); res.status(400).json({ error:'Connexion biométrique invalide' }); }
});

app.get('/api/passkeys', authMiddleware, (req, res) => {
  authDb.all(`SELECT rowid AS id, device_type AS deviceType, backed_up AS backedUp, created_at AS createdAt,
    device_label AS deviceLabel, browser_name AS browserName FROM passkeys WHERE username = ? ORDER BY created_at DESC, rowid DESC`,
  [req.user.username], (error, rows) => error ? res.status(500).json({ error:'Impossible de charger les connexions biométriques' }) : res.json(rows.map(row => ({ ...row, backedUp:Boolean(row.backedUp) }))));
});

app.delete('/api/passkeys/:id', authMiddleware, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error:'Connexion biométrique invalide' });
  authDb.run('DELETE FROM passkeys WHERE rowid = ? AND username = ?', [id, req.user.username], function(error) {
    if (error) return res.status(500).json({ error:'Suppression impossible' });
    if (!this.changes) return res.status(404).json({ error:'Connexion biométrique introuvable' });
    res.json({ message:'Connexion biométrique supprimée' });
  });
});

app.post('/api/passkeys/login/options', loginLimiter, async (req, res) => {
  const username = cleanText(req.body.username, 30);
  if (!username) return res.status(400).json({ error:"Saisissez d’abord votre nom d’utilisateur" });
  try {
    const { generateAuthenticationOptions } = await webauthnPromise;
    authDb.all('SELECT credential_id, transports FROM passkeys WHERE username = ?', [username], async (error, passkeys) => {
      if (error) return res.status(500).json({ error:'Erreur du serveur' });
      if (!passkeys.length) return res.status(404).json({ error:'Aucune connexion biométrique enregistrée pour ce compte' });
      const options = await generateAuthenticationOptions({ rpID:WEBAUTHN_RP_ID, userVerification:'preferred', allowCredentials:passkeys.map(passkey => ({ id:passkey.credential_id, transports:JSON.parse(passkey.transports || '[]') })) });
      passkeyChallenges.set(`login:${username}`, { challenge:options.challenge, expires:Date.now() + 300000 });
      res.json(options);
    });
  } catch { res.status(500).json({ error:'Impossible de préparer la connexion biométrique' }); }
});

app.post('/api/passkeys/login/verify', loginLimiter, async (req, res) => {
  const username = cleanText(req.body.username, 30);
  const response = req.body.response;
  const pending = passkeyChallenges.get(`login:${username}`);
  if (!pending || pending.expires < Date.now() || !response?.id) return res.status(400).json({ error:'Demande de connexion expirée' });
  authDb.get(`SELECT p.*, u.role, u.blocked_until FROM passkeys p JOIN users u ON u.username = p.username
    WHERE p.credential_id = ? AND p.username = ?`, [response.id, username], async (error, passkey) => {
      if (error) return res.status(500).json({ error:'Erreur du serveur' });
      if (!passkey) return res.status(401).json({ error:'Connexion biométrique inconnue' });
      if (passkey.blocked_until && new Date(passkey.blocked_until).getTime() > Date.now()) return res.status(403).json({ error:'Compte temporairement bloqué' });
      try {
        const { verifyAuthenticationResponse } = await webauthnPromise;
        const verification = await verifyAuthenticationResponse({ response, expectedChallenge:pending.challenge, expectedOrigin:WEBAUTHN_ORIGIN, expectedRPID:WEBAUTHN_RP_ID,
          credential:{ id:passkey.credential_id, publicKey:new Uint8Array(passkey.public_key), counter:passkey.counter, transports:JSON.parse(passkey.transports || '[]') } });
        if (!verification.verified) return res.status(401).json({ error:'Connexion biométrique non vérifiée' });
        const device = describeUserAgent(req.get('user-agent'));
        authDb.run('UPDATE passkeys SET counter = ?, device_label = ?, browser_name = ?, user_agent = ? WHERE credential_id = ?',
          [verification.authenticationInfo.newCounter, device.deviceLabel, device.browserName, device.userAgent, passkey.credential_id]);
        passkeyChallenges.delete(`login:${username}`);
        createSharedSession(req, res, { username, role:passkey.role }, (sessionError, token) => sessionError
          ? res.status(500).json({ error:'Erreur lors de la création de la session' })
          : res.json({ token, username, role:passkey.role }));
      } catch (verificationError) { console.error('Passkey authentication:', verificationError); res.status(401).json({ error:'Connexion biométrique invalide' }); }
    });
});



// ============ EXERCISES ============
app.get('/api/exercises', authMiddleware, (req, res) => {
  const search = req.query.search || '';
  const muscle = req.query.muscle || '';
  
  let sql = "SELECT id, name, muscle_group, equipment, user_id, is_default, source_id, target, image_url FROM exercises WHERE (user_id = ? OR source_id IS NOT NULL)";
  const params = [req.user.username];
  
  if (search) {
    sql += " AND name LIKE ?";
    params.push(`%${search}%`);
  }
  if (muscle) {
    sql += " AND muscle_group = ?";
    params.push(muscle);
  }
  
  sql += " ORDER BY is_default DESC, name ASC";
  
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/exercises/:id', authMiddleware, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Identifiant invalide' });
  db.get(`SELECT id, name, muscle_group, equipment, source_id, target, secondary_muscles,
    instructions, image_url, gif_url, attribution FROM exercises
    WHERE id = ? AND (user_id = ? OR is_default = 1)`, [id, req.user.username], (error, exercise) => {
    if (error) return res.status(500).json({ error: 'Impossible de charger l’exercice' });
    if (!exercise) return res.status(404).json({ error: 'Exercice introuvable' });
    try { exercise.secondary_muscles = JSON.parse(exercise.secondary_muscles || '[]'); } catch { exercise.secondary_muscles = []; }
    res.json(exercise);
  });
});

app.post('/api/exercises', authMiddleware, (req, res) => {
  const { name, muscle_group, equipment } = req.body;
  const cleanName = typeof name === 'string' ? name.trim() : '';
  if (!cleanName || cleanName.length > 100) {
    return res.status(400).json({ error: 'Nom de l\'exercice requis' });
  }
  const cleanMuscle = typeof muscle_group === 'string' ? muscle_group.trim().slice(0, 80) : null;
  const cleanEquipment = typeof equipment === 'string' ? equipment.trim().slice(0, 80) : null;

  db.run(
    "INSERT INTO exercises (name, muscle_group, equipment, user_id) VALUES (?, ?, ?, ?)",
    [cleanName, cleanMuscle, cleanEquipment, req.user.username],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, name: cleanName, muscle_group: cleanMuscle, equipment: cleanEquipment });
    }
  );
});

app.get('/api/muscle-groups', authMiddleware, (req, res) => {
  db.all("SELECT DISTINCT muscle_group FROM exercises WHERE muscle_group IS NOT NULL AND (user_id = ? OR source_id IS NOT NULL) ORDER BY muscle_group", [req.user.username], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows.map(r => r.muscle_group));
  });
});

// ============ SÉANCES PRÉPARÉES ============
app.get('/api/workout-templates', authMiddleware, (req, res) => {
  db.all(`SELECT wt.id, wt.name, wt.created_at, COUNT(wte.id) AS exercise_count
    FROM workout_templates wt LEFT JOIN workout_template_exercises wte ON wte.template_id = wt.id
    WHERE wt.user_id = ? GROUP BY wt.id ORDER BY wt.created_at DESC`, [req.user.username], (error, templates) => {
    if (error) return res.status(500).json({ error: 'Impossible de charger les séances préparées' });
    if (!templates.length) return res.json([]);
    let remaining = templates.length;
    templates.forEach(template => db.all(`SELECT e.id, e.name, e.muscle_group, e.equipment, e.image_url,
      wte.sets, wte.reps, wte.weight, wte.position FROM workout_template_exercises wte JOIN exercises e ON e.id = wte.exercise_id
      WHERE wte.template_id = ? ORDER BY wte.position`, [template.id], (exerciseError, exercises) => {
      template.exercises = exerciseError ? [] : exercises;
      if (--remaining === 0) res.json(templates);
    }));
  });
});

app.post('/api/workout-templates', authMiddleware, (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim().slice(0, 100) : '';
  const exerciseIds = Array.isArray(req.body.exercise_ids) ? [...new Set(req.body.exercise_ids.map(Number).filter(Number.isInteger))] : [];
  if (!name) return res.status(400).json({ error: 'Donnez un nom à la séance' });
  if (!exerciseIds.length || exerciseIds.length > 30) return res.status(400).json({ error: 'Sélectionnez entre 1 et 30 exercices' });
  const placeholders = exerciseIds.map(() => '?').join(',');
  db.all(`SELECT id FROM exercises WHERE id IN (${placeholders}) AND (user_id = ? OR source_id IS NOT NULL)`, [...exerciseIds, req.user.username], (lookupError, rows) => {
    if (lookupError || rows.length !== exerciseIds.length) return res.status(400).json({ error: 'Sélection d’exercices invalide' });
    db.run('INSERT INTO workout_templates (user_id, name) VALUES (?, ?)', [req.user.username, name], function(insertError) {
      if (insertError) return res.status(500).json({ error: 'Impossible de créer la séance' });
      const templateId = this.lastID;
      const statement = db.prepare('INSERT INTO workout_template_exercises (template_id, exercise_id, position) VALUES (?, ?, ?)');
      exerciseIds.forEach((exerciseId, index) => statement.run(templateId, exerciseId, index));
      statement.finalize(error => error ? res.status(500).json({ error: 'Impossible d’ajouter les exercices' }) : res.status(201).json({ id: templateId, name }));
    });
  });
});

app.delete('/api/workout-templates/:id', authMiddleware, (req, res) => {
  db.run('DELETE FROM workout_templates WHERE id = ? AND user_id = ?', [req.params.id, req.user.username], function(error) {
    if (error) return res.status(500).json({ error: 'Impossible de supprimer la séance' });
    if (!this.changes) return res.status(404).json({ error: 'Séance introuvable' });
    res.json({ message: 'Séance supprimée' });
  });
});

app.post('/api/workout-templates/:id/exercises', authMiddleware, (req, res) => {
  const templateId = Number.parseInt(req.params.id, 10);
  const exerciseIds = Array.isArray(req.body.exercise_ids) ? [...new Set(req.body.exercise_ids.map(Number).filter(Number.isInteger))] : [];
  if (!Number.isInteger(templateId) || !exerciseIds.length || exerciseIds.length > 30) return res.status(400).json({ error: 'Sélection invalide' });
  db.get('SELECT id FROM workout_templates WHERE id = ? AND user_id = ?', [templateId, req.user.username], (templateError, template) => {
    if (templateError || !template) return res.status(404).json({ error: 'Séance introuvable' });
    const placeholders = exerciseIds.map(() => '?').join(',');
    db.all(`SELECT id FROM exercises WHERE id IN (${placeholders}) AND (user_id = ? OR source_id IS NOT NULL)`, [...exerciseIds, req.user.username], (exerciseError, allowedRows) => {
      if (exerciseError || allowedRows.length !== exerciseIds.length) return res.status(400).json({ error: 'Un exercice sélectionné est invalide' });
      db.all('SELECT exercise_id FROM workout_template_exercises WHERE template_id = ?', [templateId], (existingError, existingRows) => {
      if (existingError) return res.status(500).json({ error: 'Impossible de modifier la séance' });
      const existing = new Set(existingRows.map(row => row.exercise_id));
      const additions = exerciseIds.filter(id => !existing.has(id));
      if (!additions.length) return res.json({ added: 0, message: 'Ces exercices sont déjà dans la séance' });
      const statement = db.prepare('INSERT INTO workout_template_exercises (template_id, exercise_id, position) VALUES (?, ?, ?)');
      additions.forEach((exerciseId, index) => statement.run(templateId, exerciseId, existingRows.length + index));
      statement.finalize(error => error
        ? res.status(500).json({ error: 'Impossible d’ajouter les exercices' })
        : res.json({ added: additions.length }));
      });
    });
  });
});

app.put('/api/workout-templates/:id', authMiddleware, (req, res) => {
  const templateId = Number.parseInt(req.params.id, 10);
  const exercises = Array.isArray(req.body.exercises) ? req.body.exercises : [];
  if (!Number.isInteger(templateId) || !exercises.length || exercises.length > 30) return res.status(400).json({ error: 'Configuration invalide' });
  const clean = exercises.map((exercise, position) => ({
    id: Number(exercise.id), position,
    sets: Math.min(Math.max(Number.parseInt(exercise.sets, 10) || 1, 1), 20),
    reps: Math.min(Math.max(Number.parseInt(exercise.reps, 10) || 1, 1), 200),
    weight: Math.min(Math.max(Number(exercise.weight) || 0, 0), 2000)
  }));
  if (clean.some(exercise => !Number.isInteger(exercise.id))) return res.status(400).json({ error: 'Exercice invalide' });
  db.get('SELECT id FROM workout_templates WHERE id = ? AND user_id = ?', [templateId, req.user.username], (lookupError, template) => {
    if (lookupError || !template) return res.status(404).json({ error: 'Séance introuvable' });
    db.all('SELECT exercise_id FROM workout_template_exercises WHERE template_id = ?', [templateId], (exerciseError, rows) => {
      const allowed = new Set((rows || []).map(row => row.exercise_id));
      if (exerciseError || clean.some(exercise => !allowed.has(exercise.id))) return res.status(400).json({ error: 'Configuration invalide' });
      const statement = db.prepare('UPDATE workout_template_exercises SET position = ?, sets = ?, reps = ?, weight = ? WHERE template_id = ? AND exercise_id = ?');
      clean.forEach(exercise => statement.run(exercise.position, exercise.sets, exercise.reps, exercise.weight, templateId, exercise.id));
      statement.finalize(error => error ? res.status(500).json({ error: 'Impossible d’enregistrer les réglages' }) : res.json({ message: 'Séance mise à jour' }));
    });
  });
});

// ============ WORKOUTS ============
app.get('/api/workouts', authMiddleware, (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 100);
  const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
  const where = date ? 'user_id = ? AND DATE(date) = ?' : 'user_id = ?';
  const params = date ? [req.user.username, date, limit, offset] : [req.user.username, limit, offset];
  db.all(
    `SELECT * FROM workouts WHERE ${where} ORDER BY date DESC LIMIT ? OFFSET ?`,
    params,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

app.get('/api/workout-calendar', authMiddleware, (req, res) => {
  const year = Math.min(Math.max(Number.parseInt(req.query.year, 10) || new Date().getUTCFullYear(), 2000), 2100);
  const month = Math.min(Math.max(Number.parseInt(req.query.month, 10) || 1, 1), 12);
  const view = ['week', 'month', 'year'].includes(req.query.view) ? req.query.view : 'month';
  const start = /^\d{4}-\d{2}-\d{2}$/.test(req.query.start || '') ? req.query.start : null;
  const end = /^\d{4}-\d{2}-\d{2}$/.test(req.query.end || '') ? req.query.end : null;
  let condition = "strftime('%Y-%m', date) = ?";
  let value = `${year}-${String(month).padStart(2, '0')}`;
  if (view === 'year') { condition = "strftime('%Y', date) = ?"; value = String(year); }
  if (view === 'week' && start && end) { condition = 'DATE(date) BETWEEN ? AND ?'; }
  const params = view === 'week' && start && end ? [req.user.username, start, end] : [req.user.username, value];
  db.all(`SELECT id, DATE(date) AS day, name, duration
    FROM workouts WHERE user_id = ? AND ${condition} ORDER BY date`, params, (error, rows) => {
    if (error) return res.status(500).json({ error: 'Impossible de charger le calendrier' });
    const days = new Map();
    rows.forEach(workout => {
      if (!days.has(workout.day)) days.set(workout.day, { day:workout.day, workout_count:0, workouts:[] });
      const activity = days.get(workout.day);
      activity.workout_count++;
      activity.workouts.push({ id:workout.id, name:workout.name || 'Séance', duration:workout.duration });
    });
    res.json([...days.values()]);
  });
});

app.post('/api/workouts', authMiddleware, (req, res) => {
  try {
    const { name, notes, duration, exercises } = req.body;
    if (!Array.isArray(exercises) || exercises.length > 100) return res.status(400).json({ error: 'Liste d’exercices invalide' });
    const cleanName = typeof name === 'string' ? name.trim().slice(0, 120) : null;
    const cleanNotes = typeof notes === 'string' ? notes.trim().slice(0, 5000) : null;
    const cleanDuration = Number.isFinite(Number(duration)) ? Math.min(Math.max(Math.round(Number(duration)), 0), 1440) : null;
    const invalidSet = exercises.some(exercise => !Number.isInteger(Number(exercise?.exercise_id)) || !Array.isArray(exercise.sets) || exercise.sets.length > 100);
    if (invalidSet) return res.status(400).json({ error: 'Données d’exercice invalides' });
    
    db.run('BEGIN IMMEDIATE', beginError => {
      if (beginError) return res.status(500).json({ error: 'Impossible de démarrer l’enregistrement' });
      db.run(
        "INSERT INTO workouts (user_id, name, notes, duration) VALUES (?, ?, ?, ?)",
        [req.user.username, cleanName, cleanNotes, cleanDuration],
        function(err) {
          if (err) {
            console.error('Error inserting workout:', err);
            return db.run('ROLLBACK', () => res.status(500).json({ error: 'Impossible d’enregistrer la séance' }));
          }
          const workoutId = this.lastID;
          const commit = () => db.run('COMMIT', commitError => commitError
            ? res.status(500).json({ error: 'Impossible de finaliser la séance' })
            : res.json({ id: workoutId, message: 'Séance enregistrée' }));

          if (!exercises.length) return commit();
          const statement = db.prepare(
            "INSERT INTO workout_sets (workout_id, exercise_id, set_number, reps, weight, rpe, is_warmup, is_drop, is_failure, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
          );
          exercises.forEach(exercise => exercise.sets.forEach((set, index) => statement.run(
            workoutId,
            Number(exercise.exercise_id),
            index + 1,
            Number.isFinite(Number(set.reps)) ? Number(set.reps) : null,
            Number.isFinite(Number(set.weight)) ? Number(set.weight) : null,
            Number.isFinite(Number(set.rpe)) ? Number(set.rpe) : null,
            set.is_warmup ? 1 : 0,
            set.is_drop ? 1 : 0,
            set.is_failure ? 1 : 0,
            typeof set.notes === 'string' ? set.notes.trim().slice(0, 1000) : null
          )));
          statement.finalize(finalizeError => finalizeError
            ? db.run('ROLLBACK', () => res.status(500).json({ error: 'Impossible d’enregistrer les séries de la séance' }))
            : commit());
        }
      );
    });
  } catch (err) {
    console.error('Crash in /api/workouts:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/workouts/:id', authMiddleware, (req, res) => {
  db.get("SELECT * FROM workouts WHERE id = ? AND user_id = ?", [req.params.id, req.user.username], (err, workout) => {
    if (err || !workout) return res.status(404).json({ error: 'Séance non trouvée' });
    
    db.all(`
      SELECT ws.*, e.name as exercise_name, e.muscle_group, e.equipment, e.image_url
      FROM workout_sets ws
      JOIN exercises e ON ws.exercise_id = e.id
      WHERE ws.workout_id = ?
      ORDER BY ws.id
    `, [req.params.id], (err, sets) => {
      if (err) return res.status(500).json({ error: err.message });
      
      // Grouper par exercice
      const exercisesMap = {};
      sets.forEach(set => {
        if (!exercisesMap[set.exercise_id]) {
          exercisesMap[set.exercise_id] = {
            exercise_id: set.exercise_id,
            name: set.exercise_name,
            muscle_group: set.muscle_group,
            equipment: set.equipment,
            image_url: set.image_url,
            sets: []
          };
        }
        exercisesMap[set.exercise_id].sets.push({
          set_number: set.set_number,
          reps: set.reps,
          weight: set.weight,
          rpe: set.rpe,
          is_warmup: set.is_warmup,
          is_drop: set.is_drop,
          is_failure: set.is_failure,
          notes: set.notes
        });
      });
      
      res.json({ ...workout, exercises: Object.values(exercisesMap) });
    });
  });
});

app.delete('/api/workouts/:id', authMiddleware, (req, res) => {
  const workoutId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(workoutId) || workoutId < 1) return res.status(400).json({ error: 'Identifiant invalide' });
  db.get('SELECT id FROM workouts WHERE id = ? AND user_id = ?', [workoutId, req.user.username], (lookupError, workout) => {
    if (lookupError) return res.status(500).json({ error: 'Erreur lors de la suppression' });
    if (!workout) return res.status(404).json({ error: 'Séance non trouvée' });
    db.run('BEGIN IMMEDIATE', beginError => {
      if (beginError) return res.status(500).json({ error: 'Erreur lors de la suppression' });
      db.run('DELETE FROM workout_sets WHERE workout_id = ?', [workoutId], setsError => {
        if (setsError) return db.run('ROLLBACK', () => res.status(500).json({ error: 'Erreur lors de la suppression' }));
        db.run('DELETE FROM workouts WHERE id = ? AND user_id = ?', [workoutId, req.user.username], workoutError => {
          if (workoutError) return db.run('ROLLBACK', () => res.status(500).json({ error: 'Erreur lors de la suppression' }));
          db.run('COMMIT', commitError => commitError
            ? res.status(500).json({ error: 'Erreur lors de la suppression' })
            : res.json({ message: 'Séance supprimée' }));
        });
      });
    });
  });
});

// ============ PROGRESS ============
app.get('/api/progress/:exerciseId', authMiddleware, (req, res) => {
  const exerciseId = req.params.exerciseId;
  
  db.all(`
    SELECT 
      DATE(w.date) as date,
      MAX(ws.weight) as max_weight,
      MAX(ws.reps) as max_reps,
      COUNT(*) as total_sets
    FROM workouts w
    JOIN workout_sets ws ON w.id = ws.workout_id
    WHERE w.user_id = ? AND ws.exercise_id = ? AND ws.weight IS NOT NULL
    GROUP BY DATE(w.date)
    ORDER BY date DESC
    LIMIT 30
  `, [req.user.username, exerciseId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// ============ PERSONAL RECORDS ============
app.get('/api/records', authMiddleware, (req, res) => {
  db.all(`
    SELECT e.id AS exercise_id, e.name AS exercise_name, e.muscle_group, e.equipment, e.image_url,
      COUNT(DISTINCT w.id) AS workout_count, COUNT(ws.id) AS set_count,
      MAX(COALESCE(ws.weight, 0)) AS max_weight,
      MAX(CASE WHEN ws.weight = (SELECT MAX(COALESCE(ws2.weight, 0)) FROM workout_sets ws2
        JOIN workouts w2 ON w2.id = ws2.workout_id WHERE w2.user_id = w.user_id AND ws2.exercise_id = ws.exercise_id)
        THEN COALESCE(ws.reps, 0) ELSE 0 END) AS reps_at_record,
      MAX(w.date) AS last_performed
    FROM workouts w
    JOIN workout_sets ws ON ws.workout_id = w.id
    JOIN exercises e ON e.id = ws.exercise_id
    WHERE w.user_id = ?
    GROUP BY e.id, e.name, e.muscle_group
    ORDER BY workout_count DESC, set_count DESC, last_performed DESC
  `, [req.user.username], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// ============ STATS ============
app.get('/api/stats', authMiddleware, (req, res) => {
  const username = req.user.username;
  
  db.get("SELECT COUNT(*) as total_workouts FROM workouts WHERE user_id = ?", [username], (err, r1) => {
    if (err) return res.status(500).json({ error: 'Impossible de charger les statistiques' });
    db.get("SELECT SUM(duration) as total_duration FROM workouts WHERE user_id = ?", [username], (err, r2) => {
      if (err) return res.status(500).json({ error: 'Impossible de charger les statistiques' });
      db.get(`SELECT COUNT(DISTINCT ws.exercise_id) AS total_exercises
        FROM workout_sets ws JOIN workouts w ON w.id = ws.workout_id
        WHERE w.user_id = ?`, [username], (err, r3) => {
        if (err) return res.status(500).json({ error: 'Impossible de charger les statistiques' });
        res.json({
          totalWorkouts: r1.total_workouts || 0,
          totalDuration: r2.total_duration || 0,
          totalRecords: r3.total_exercises || 0
        });
      });
    });
  });
});

// ============ START ============
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`Goodwater Gym listening on port ${PORT}`);
});

function shutdown(signal) {
  console.log(`${signal}: arrêt de Goodwater Gym`);
  clearTimeout(forceShutdownTimer);
  server.close(() => db.close(() => authDb.close(() => process.exit(0))));
  forceShutdownTimer = setTimeout(() => process.exit(1), 10_000);
  forceShutdownTimer.unref();
}

let forceShutdownTimer;
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
