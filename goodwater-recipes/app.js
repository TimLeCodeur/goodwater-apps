// Serveur HTTP de Goodwater Recipes.
require('dotenv').config();

const express = require('express');
const path = require('path');
const dns = require('dns');
const fs = require('fs-extra');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const nodemailer = require('nodemailer');
const crypto = require('crypto');

// Le jeton Cloudflare est limité à l'adresse IPv4 publique de ce serveur.
dns.setDefaultResultOrder('ipv4first');

const app = express();
const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
const WEBAUTHN_RP_ID = 'goodwater-recipes.fr';
const WEBAUTHN_ORIGIN = 'https://goodwater-recipes.fr';
const webauthnPromise = import('@simplewebauthn/server');
const passkeyChallenges = new Map();
const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://goodwater-recipes.fr').replace(/\/$/, '');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.invalid';
const mailTransport = nodemailer.createTransport({ sendmail: true, newline: 'unix', path: '/usr/sbin/sendmail' });
app.set('trust proxy', 1);

function readPositiveIntegerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

// Aucun secret par défaut : un oubli de configuration doit empêcher le démarrage.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is required!');
  process.exit(1);
}

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'db.sqlite');
const RECIPE_IMAGES_DIR = process.env.RECIPE_IMAGES_DIR || path.join(__dirname, 'data', 'recipe-images');
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
const LOG_PATH = path.join(__dirname, 'logs', 'app.log');
let db;
let logger;

// Initialise une interface de journalisation unique pour tout le serveur.
async function initLogger() {
  try {
    await fs.ensureDir(path.dirname(LOG_PATH));
    logger = {
      info: (msg) => console.log('[INFO]', new Date().toISOString(), msg),
      warn: (msg) => console.warn('[WARN]', new Date().toISOString(), msg),
      error: (msg) => console.error('[ERROR]', new Date().toISOString(), msg),
      debug: (msg) => {
        if (process.env.NODE_ENV !== 'production') {
          console.log('[DEBUG]', new Date().toISOString(), msg);
        }
      }
    };
  } catch (err) {
    logger = {
      info: (msg) => console.log('[INFO]', msg),
      warn: (msg) => console.warn('[WARN]', msg),
      error: (msg) => console.error('[ERROR]', msg),
      debug: (msg) => {
        if (process.env.NODE_ENV !== 'production') {
          console.log('[DEBUG]', msg);
        }
      }
    };
  }
}

// Une erreur globale laisse potentiellement le processus dans un état incohérent.
// Ces gestionnaires ne sont installés qu'au démarrage réel, jamais lors des tests.
function registerProcessErrorHandlers() {
  process.on('uncaughtException', error => {
    console.error('[FATAL] Uncaught Exception:', error);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
  });
}

// Crée le schéma et applique les migrations idempotentes avant d'accepter du trafic.
function initDb() {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, openError => {
      if (openError) reject(openError);
    });

    db.serialize(() => {
    db.run('PRAGMA foreign_keys = ON');
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT DEFAULT 'viewer',
      first_name TEXT DEFAULT '',
      last_name TEXT DEFAULT '',
      description TEXT DEFAULT '',
      blocked_until DATETIME DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Migrations compatibles avec les bases créées par les anciennes versions.
    db.run("ALTER TABLE users ADD COLUMN first_name TEXT DEFAULT ''", () => {});
    db.run("ALTER TABLE users ADD COLUMN last_name TEXT DEFAULT ''", () => {});
    db.run("ALTER TABLE users ADD COLUMN description TEXT DEFAULT ''", () => {});
    db.run("ALTER TABLE users ADD COLUMN blocked_until DATETIME DEFAULT NULL", () => {});
    
    db.run(`CREATE TABLE IF NOT EXISTS login_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      ip TEXT NOT NULL,
      success INTEGER DEFAULT 1,
      reason TEXT DEFAULT '',
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run("ALTER TABLE login_logs ADD COLUMN success INTEGER DEFAULT 1", () => {});
    db.run("ALTER TABLE login_logs ADD COLUMN reason TEXT DEFAULT ''", () => {});

    db.run(`CREATE TABLE IF NOT EXISTS admin_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      target_username TEXT DEFAULT '',
      action TEXT NOT NULL,
      ip TEXT NOT NULL,
      success INTEGER DEFAULT 1,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run("ALTER TABLE admin_logs ADD COLUMN success INTEGER DEFAULT 1", () => {});

    db.run(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      user_agent TEXT DEFAULT '',
      ip TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      revoked_at DATETIME DEFAULT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS passkeys (
      credential_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      public_key BLOB NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT DEFAULT '[]',
      device_type TEXT DEFAULT '',
      backed_up INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      device_label TEXT DEFAULT '',
      browser_name TEXT DEFAULT '',
      user_agent TEXT DEFAULT ''
    )`);
    db.run("ALTER TABLE passkeys ADD COLUMN device_label TEXT DEFAULT ''", () => {});
    db.run("ALTER TABLE passkeys ADD COLUMN browser_name TEXT DEFAULT ''", () => {});
    db.run("ALTER TABLE passkeys ADD COLUMN user_agent TEXT DEFAULT ''", () => {});

    db.run(`CREATE TABLE IF NOT EXISTS recipe_trash (
      recipe_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      owner_username TEXT DEFAULT '',
      deleted_by TEXT NOT NULL,
      deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS pending_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      request_ip TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME DEFAULT NULL
    )`);
    db.run("ALTER TABLE pending_users ADD COLUMN status TEXT DEFAULT 'pending'", () => {});
    db.run("ALTER TABLE pending_users ADD COLUMN request_ip TEXT DEFAULT ''", () => {});
    db.run("ALTER TABLE pending_users ADD COLUMN resolved_at DATETIME DEFAULT NULL", () => {});
    db.run(`CREATE TABLE IF NOT EXISTS recipe_owners (
      recipe_id TEXT PRIMARY KEY,
      owner_username TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS shopping_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 1,
      unit TEXT NOT NULL DEFAULT '',
      checked INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(username, normalized_name, unit)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS weekly_menu_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      recipe_id TEXT NOT NULL,
      day INTEGER NOT NULL,
      meal TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS recipe_favorites (
      username TEXT NOT NULL,
      recipe_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (username, recipe_id)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS recipe_collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(username, name)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS recipe_collection_items (
      collection_id INTEGER NOT NULL,
      recipe_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (collection_id, recipe_id),
      FOREIGN KEY (collection_id) REFERENCES recipe_collections(id) ON DELETE CASCADE
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS recipe_views (
      username TEXT NOT NULL,
      recipe_id TEXT NOT NULL,
      viewed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      view_count INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (username, recipe_id)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS recipe_shares (
      code TEXT PRIMARY KEY,
      recipe_id TEXT NOT NULL,
      created_by TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_login_logs_timestamp ON login_logs(timestamp)');
    db.run('CREATE INDEX IF NOT EXISTS idx_sessions_username ON sessions(username)');
    db.run('CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at)');
    db.run('CREATE INDEX IF NOT EXISTS idx_passkeys_username ON passkeys(username)');
    db.run('CREATE INDEX IF NOT EXISTS idx_pending_users_status ON pending_users(status)');
    db.run('CREATE INDEX IF NOT EXISTS idx_weekly_menu_user ON weekly_menu_items(username)');
    db.run('CREATE INDEX IF NOT EXISTS idx_recipe_views_user_date ON recipe_views(username, viewed_at DESC)');
    db.run('CREATE INDEX IF NOT EXISTS idx_collection_items_collection ON recipe_collection_items(collection_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_recipe_shares_expiry ON recipe_shares(expires_at)');
    
    // Crée le compte administrateur initial uniquement si nécessaire.
    db.get("SELECT * FROM users WHERE username = 'admin'", async (err, row) => {
      if (err) {
        console.error('Database error during admin check:', err);
        return reject(err);
      }
      
      if (!row) {
        // En production, aucun mot de passe administrateur par défaut n'est accepté.
        if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_PASSWORD) {
          console.error('FATAL: ADMIN_PASSWORD environment variable is required in production!');
          process.exit(1);
        }
        
        let hashedPassword;
        if (process.env.ADMIN_PASSWORD) {
          hashedPassword = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
        } else {
          // Valeur de secours réservée au développement local.
          hashedPassword = bcrypt.hashSync('admin123', 12);
          console.warn('WARNING: Using default admin password. Set ADMIN_PASSWORD env variable!');
        }
        
        db.run("INSERT INTO users (username, password, role) VALUES (?, ?, ?)", 
          ['admin', hashedPassword, 'admin'],
          (err) => {
            if (err) {
              console.error('Error creating admin:', err);
              reject(err);
            } else {
              console.log('Admin user created successfully');
              resolve();
            }
          }
        );
      } else {
        resolve();
      }
    });
    });
  });
}

// En-têtes de sécurité HTTP.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'img-src': ['"self"', 'data:', 'https:'],
    },
  },
}));

// Origines autorisées pour les appels provenant d'un navigateur.
const allowedOrigins = process.env.CORS_ORIGINS 
  ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
  : ['https://goodwater-recipes.fr', 'https://www.goodwater-recipes.fr'];

app.use(cors({
  origin: function (origin, callback) {
    // Les clients non-navigateurs (application mobile, curl) n'envoient pas d'origine.
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn('CORS blocked origin:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

// Une limite explicite évite de charger des corps démesurés en mémoire.
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.use('/recipe-images', express.static(RECIPE_IMAGES_DIR, {
  maxAge: '7d',
  immutable: false,
  fallthrough: true
}));

// Les fichiers versionnés côté client peuvent être mis en cache sans risque.
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d',
  etag: true,
  setHeaders: (res, filePath) => {
    if (path.basename(filePath) === 'index.html') {
      res.setHeader('Cache-Control', 'no-store, max-age=0');
    }
  }
}));

// Limitation des tentatives de connexion et des appels liés aux recettes.
const loginLimiter = rateLimit({
  windowMs: readPositiveIntegerEnv('LOGIN_RATE_LIMIT_WINDOW_MS', 5 * 60 * 1000),
  max: readPositiveIntegerEnv('LOGIN_RATE_LIMIT_MAX', 100),
  message: { error: 'Trop de tentatives. Réessayez dans 5 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: readPositiveIntegerEnv('RATE_LIMIT_WINDOW_MS', 60 * 1000),
  max: readPositiveIntegerEnv('RATE_LIMIT_MAX', 60),
  standardHeaders: true,
  legacyHeaders: false,
});

const recipeImageAiLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: readPositiveIntegerEnv('RECIPE_IMAGE_AI_DAILY_LIMIT', 10),
  keyGenerator: req => req.user?.username || req.ip,
  message: { error: 'Quota quotidien de transformations atteint. Réessayez demain.' },
  standardHeaders: true,
  legacyHeaders: false,
});

function limitRecipeImageAi(req, res, next) {
  return req.query.ai === 'true' ? recipeImageAiLimiter(req, res, next) : next();
}

const RECIPES_DIR = process.env.RECIPES_DIR || path.join(__dirname, 'data', 'recipes');
const RECIPE_IMAGE_EXTENSIONS = ['jpg', 'png', 'webp'];

async function getRecipeImage(recipeId) {
  for (const extension of RECIPE_IMAGE_EXTENSIONS) {
    const imagePath = path.join(RECIPE_IMAGES_DIR, `${recipeId}.${extension}`);
    if (await fs.pathExists(imagePath)) {
      const stats = await fs.stat(imagePath);
      return `/recipe-images/${encodeURIComponent(recipeId)}.${extension}?v=${Math.round(stats.mtimeMs)}`;
    }
  }
  return null;
}

async function getRecipeImageFile(recipeId) {
  for (const extension of RECIPE_IMAGE_EXTENSIONS) {
    const imagePath = path.join(RECIPE_IMAGES_DIR, `${recipeId}.${extension}`);
    if (await fs.pathExists(imagePath)) return imagePath;
  }
  return null;
}

function detectRecipeImageExtension(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}

async function saveRecipeImage(recipeId, buffer) {
  const extension = detectRecipeImageExtension(buffer);
  if (!extension) throw new Error('UNSUPPORTED_IMAGE');
  await fs.ensureDir(RECIPE_IMAGES_DIR);
  await Promise.all(RECIPE_IMAGE_EXTENSIONS.map(candidate =>
    candidate === extension ? Promise.resolve() : fs.remove(path.join(RECIPE_IMAGES_DIR, `${recipeId}.${candidate}`))
  ));
  await fs.writeFile(path.join(RECIPE_IMAGES_DIR, `${recipeId}.${extension}`), buffer);
  return getRecipeImage(recipeId);
}

async function removeRecipeImage(recipeId) {
  await Promise.all(RECIPE_IMAGE_EXTENSIONS.map(extension =>
    fs.remove(path.join(RECIPE_IMAGES_DIR, `${recipeId}.${extension}`))
  ));
}

function getCookie(req, name) {
  const value = String(req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`));
  return value ? decodeURIComponent(value.slice(name.length + 1)) : '';
}

function setSsoCookie(res, sessionId, maxAge = 86400) {
  res.setHeader('Set-Cookie', `gw_session=${encodeURIComponent(sessionId)}; Domain=.goodwater-recipes.fr; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`);
}

// Vérifie à la fois le JWT, l'existence du compte et la session côté serveur.
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    const sessionId = getCookie(req, 'gw_session');
    if (!sessionId) return res.status(401).json({ error: 'Jeton d’accès requis' });
    return db.get(
      `SELECT u.username, u.role FROM sessions s JOIN users u ON u.username = s.username
       WHERE s.id = ? AND s.revoked_at IS NULL AND datetime(s.expires_at) > datetime('now')`,
      [sessionId],
      (error, user) => {
        if (error) return res.status(500).json({ error: 'Erreur lors de la vérification de la session' });
        if (!user) return res.status(401).json({ error: 'Session invalide ou expirée' });
        req.user = user;
        req.sessionId = sessionId;
        db.run('UPDATE sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?', [sessionId]);
        next();
      }
    );
  }
  
  const token = authHeader.split(' ')[1];
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    db.get('SELECT username, role FROM users WHERE username = ?', [decoded.username], (error, user) => {
      if (error) return res.status(500).json({ error: 'Erreur lors de la vérification du compte' });
      if (!user) return res.status(401).json({ error: 'Jeton invalide ou expiré' });
      const acceptSession = () => {
        req.user = user;
        req.sessionId = decoded.sid || null;
        next();
      };
      // Compatibilité temporaire avec les jetons créés avant le suivi des sessions.
      if (!decoded.sid) return acceptSession();
      db.get(
        `SELECT id FROM sessions WHERE id = ? AND username = ? AND revoked_at IS NULL
          AND datetime(expires_at) > datetime('now')`,
        [decoded.sid, decoded.username],
        (sessionError, session) => {
          if (sessionError) return res.status(500).json({ error: 'Erreur lors de la vérification de la session' });
          if (!session) return res.status(401).json({ error: 'Jeton invalide ou expiré' });
          db.run('UPDATE sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?', [decoded.sid]);
          acceptSession();
        }
      );
    });
  } catch (err) {
    return res.status(401).json({ error: 'Jeton invalide ou expiré' });
  }
}

function auditAction(req, targetUsername, action, success = 1) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  db.run(
    'INSERT INTO admin_logs (username, target_username, action, ip, success) VALUES (?, ?, ?, ?, ?)',
    [req.user?.username || 'system', targetUsername || '', action, String(ip).slice(0, 100), success ? 1 : 0],
    error => { if (error) console.error('Audit log error:', error); }
  );
}

function createSessionId() {
  return require('crypto').randomBytes(24).toString('hex');
}

function recipeWriteMiddleware(req, res, next) {
  if (req.user && ['editor', 'grand_chef'].includes(req.user.role)) return next();
  return res.status(403).json({ error: 'Votre rôle permet uniquement la lecture des recettes' });
}

function getRecipeOwner(recipeId) {
  return new Promise((resolve, reject) => db.get(
    'SELECT owner_username AS owner FROM recipe_owners WHERE recipe_id = ?', [recipeId],
    (error, row) => error ? reject(error) : resolve(row?.owner || null)
  ));
}

function setRecipeOwner(recipeId, username) {
  return new Promise((resolve, reject) => db.run(
    'INSERT INTO recipe_owners (recipe_id, owner_username) VALUES (?, ?)', [recipeId, username],
    error => error ? reject(error) : resolve()
  ));
}

function deleteRecipeOwner(recipeId) {
  return new Promise((resolve, reject) => db.run(
    'DELETE FROM recipe_owners WHERE recipe_id = ?', [recipeId],
    error => error ? reject(error) : resolve()
  ));
}

function canEditRecipe(user, owner) {
  return user.role === 'grand_chef' || (user.role === 'editor' && owner === user.username);
}

function normalizeShoppingName(name) {
  return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase('fr');
}

function validateShoppingItem(rawItem) {
  const name = typeof rawItem?.name === 'string' ? rawItem.name.trim() : '';
  const unit = typeof rawItem?.unit === 'string' ? rawItem.unit.trim().toLocaleLowerCase('fr') : '';
  const quantity = Number(rawItem?.quantity);
  if (!name || name.length > 100) return null;
  if (unit.length > 30) return null;
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000) return null;
  return { name, normalizedName: normalizeShoppingName(name), quantity, unit };
}

// Réserve les routes d'administration au rôle admin.
function adminMiddleware(req, res, next) {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    return res.status(403).json({ error: 'Accès administrateur requis' });
  }
}

// Transforme un titre libre en identifiant de fichier sûr.
function sanitizeFilename(title) {
  return title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Préserve les identifiants existants, y compris les underscores répétés.
function sanitizeRecipeId(id) {
  return String(id || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
}

function parseRecipeFile(rawContent, fallbackTitle) {
  const lines = rawContent.replace(/\r\n/g, '\n').split('\n');
  const firstContentLine = lines.findIndex(line => line.trim());
  const title = firstContentLine >= 0 ? lines[firstContentLine].trim() : fallbackTitle;
  const content = firstContentLine >= 0
    ? [...lines.slice(0, firstContentLine), ...lines.slice(firstContentLine + 1)].join('\n').trim()
    : '';
  const category = rawContent.match(/>>\s*category\s*:\s*([^<\n]+)\s*<</i)?.[1].trim() || 'Non classée';
  const servingsValue = Number.parseInt(rawContent.match(/>>\s*servings\s*:\s*(\d+)\s*<</i)?.[1], 10);
  const nutritionValue = key => {
    const value = Number.parseFloat(rawContent.match(new RegExp(`>>\\s*${key}\\s*:\\s*([\\d.,]+)\\s*<<`, 'i'))?.[1]?.replace(',', '.'));
    return Number.isFinite(value) && value >= 0 ? Math.round(value * 10) / 10 : null;
  };
  const nutritionFoods = rawContent.match(/>>\s*nutrition_foods\s*:\s*([0-9,\s]*)\s*<</i)?.[1]
    ?.split(',')
    .map(code => code.trim())
    .map(code => /^\d+$/.test(code) ? code : '') || [];
  const nutritionStatus = rawContent.match(/>>\s*nutrition_status\s*:\s*([^<\n]+)\s*<</i)?.[1].trim()
    || 'legacy';
  const nutritionMessage = rawContent.match(/>>\s*nutrition_message\s*:\s*([^<\n]+)\s*<</i)?.[1].trim() || '';

  return {
    title,
    content,
    category,
    servings: Number.isInteger(servingsValue) && servingsValue > 0 ? servingsValue : 1,
    nutritionFoods,
    nutritionStatus,
    nutritionMessage,
    nutrition: {
      calories: nutritionValue('calories'),
      protein: nutritionValue('protein'),
      carbs: nutritionValue('carbs'),
      fat: nutritionValue('fat'),
      fiber: nutritionValue('fiber')
    }
  };
}

function serializeRecipeFile(title, content) {
  const normalizedContent = content.replace(/\r\n/g, '\n').trim();
  const lines = normalizedContent.split('\n');
  if (lines[0]?.trim().toLocaleLowerCase('fr') === title.trim().toLocaleLowerCase('fr')) {
    lines.shift();
  }
  return `${title.trim()}\n${lines.join('\n').trim()}\n`;
}

function validateRecipePayload(body) {
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const content = typeof body?.content === 'string' ? body.content.trim() : '';
  if (!title || !content || title.length > 200) return null;
  return { title, content };
}

// Liste toutes les recettes accessibles à l'utilisateur.
app.get('/api/recipes', apiLimiter, authMiddleware, async (req, res) => {
  try {
    if (!await fs.pathExists(RECIPES_DIR)) {
      await fs.ensureDir(RECIPES_DIR);
      return res.json([]);
    }
    
    const files = (await fs.readdir(RECIPES_DIR)).filter(file => file.endsWith('.cook'));
    const recipes = (await Promise.all(files.map(async file => {
        try {
          const filePath = path.join(RECIPES_DIR, file);
          const [rawContent, fileStats] = await Promise.all([fs.readFile(filePath, 'utf-8'), fs.stat(filePath)]);
          const parsed = parseRecipeFile(rawContent, file.replace('.cook', '').replace(/_/g, ' '));
          const recipeId = file.replace('.cook', '');
          const [owner, imageUrl] = await Promise.all([getRecipeOwner(recipeId), getRecipeImage(recipeId)]);
          return {
            id: recipeId,
            title: parsed.title,
            content: parsed.content,
            category: parsed.category,
            servings: parsed.servings,
            nutrition: parsed.nutrition,
            nutritionFoods: parsed.nutritionFoods,
            nutritionStatus: parsed.nutritionStatus,
            nutritionMessage: parsed.nutritionMessage,
            createdAt: fileStats.birthtime.toISOString(),
            updatedAt: fileStats.mtime.toISOString(),
            imageUrl,
            author: owner,
            canEdit: canEditRecipe(req.user, owner)
          };
        } catch (error) {
          console.warn('Error reading recipe ' + file + ':', error);
          return null;
        }
    }))).filter(Boolean);
    
    res.json(recipes);
  } catch (error) {
    console.error('Error loading recipes:', error);
    res.status(500).json({ error: 'Erreur lors du chargement des recettes' });
  }
});

// Charge une recette précise.
app.get('/api/recipes/:id', apiLimiter, authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const sanitizedId = sanitizeRecipeId(id);
    const filePath = path.join(RECIPES_DIR, sanitizedId + '.cook');
    
    if (!await fs.pathExists(filePath)) {
      return res.status(404).json({ error: 'Recette introuvable' });
    }
    
    const rawContent = await fs.readFile(filePath, 'utf-8');
    const parsed = parseRecipeFile(rawContent, sanitizedId.replace(/_/g, ' '));
    const owner = await getRecipeOwner(sanitizedId);
    const fileStats = await fs.stat(filePath);
    
    res.json({
      id: sanitizedId,
      title: parsed.title,
      content: parsed.content,
      category: parsed.category,
      servings: parsed.servings,
      nutrition: parsed.nutrition,
      nutritionFoods: parsed.nutritionFoods,
      nutritionStatus: parsed.nutritionStatus,
      nutritionMessage: parsed.nutritionMessage,
      createdAt: fileStats.birthtime.toISOString(),
      updatedAt: fileStats.mtime.toISOString(),
      imageUrl: await getRecipeImage(sanitizedId),
      author: owner,
      canEdit: canEditRecipe(req.user, owner)
    });
  } catch (error) {
    console.error('Error loading recipe:', error);
    res.status(500).json({ error: 'Erreur lors du chargement de la recette' });
  }
});

// Crée un lien public limité à une recette et valable au maximum 24 heures.
app.post('/api/recipes/:id/share', apiLimiter, authMiddleware, async (req, res) => {
  const recipeId = sanitizeRecipeId(req.params.id);
  const recipePath = path.join(RECIPES_DIR, `${recipeId}.cook`);
  if (!recipeId || !await fs.pathExists(recipePath)) {
    return res.status(404).json({ error: 'Recette introuvable' });
  }

  const now = Date.now();
  const expiresAt = now + 24 * 60 * 60 * 1000;
  db.run('DELETE FROM recipe_shares WHERE expires_at <= ?', [now]);
  try {
    let code;
    for (let attempt = 0; attempt < 3 && !code; attempt += 1) {
      const candidate = crypto.randomBytes(15).toString('base64url');
      try {
        await new Promise((resolve, reject) => db.run(
          'INSERT INTO recipe_shares (code, recipe_id, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
          [candidate, recipeId, req.user.username, expiresAt, now],
          error => error ? reject(error) : resolve()
        ));
        code = candidate;
      } catch (error) {
        if (error.code !== 'SQLITE_CONSTRAINT') throw error;
      }
    }
    if (!code) throw new Error('Impossible de créer un code unique');
    const rawRecipe = await fs.readFile(recipePath, 'utf8');
    const title = parseRecipeFile(rawRecipe, recipeId.replace(/_/g, ' ')).title;
    const slug = title.normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('fr')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'recette';
    res.json({ url: `${APP_BASE_URL}/${slug}/${code}`, expiresAt: new Date(expiresAt).toISOString() });
  } catch (error) {
    console.error('Recipe share creation error:', error.message);
    res.status(500).json({ error: 'Impossible de créer le lien de partage' });
  }
});

// Consulte une recette partagée sans session. Le jeton reste vérifié à chaque appel.
app.get('/api/shared-recipes/:token', apiLimiter, async (req, res) => {
  try {
    let recipeId;
    let expiresAt;
    if (/^(?:[A-Za-z0-9_-]{11}|[A-Za-z0-9_-]{20})$/.test(req.params.token)) {
      const share = await new Promise((resolve, reject) => db.get(
        'SELECT recipe_id, expires_at FROM recipe_shares WHERE code = ? AND expires_at > ?',
        [req.params.token, Date.now()],
        (error, row) => error ? reject(error) : resolve(row)
      ));
      if (!share) throw new Error('invalid');
      recipeId = sanitizeRecipeId(share.recipe_id);
      expiresAt = Number(share.expires_at);
      if (!recipeId || recipeId !== share.recipe_id) throw new Error('invalid');
    } else {
      // Compatibilité avec les liens JWT déjà distribués, jusqu’à leur expiration.
      const payload = jwt.verify(req.params.token, JWT_SECRET);
      if (payload.purpose !== 'recipe_share' || typeof payload.recipeId !== 'string') throw new Error('invalid');
      recipeId = sanitizeRecipeId(payload.recipeId);
      expiresAt = payload.exp * 1000;
      if (!recipeId || recipeId !== payload.recipeId) throw new Error('invalid');
    }
    const filePath = path.join(RECIPES_DIR, `${recipeId}.cook`);
    if (!await fs.pathExists(filePath)) return res.status(404).json({ error: 'Recette introuvable' });

    const [rawContent, fileStats, owner, imageUrl] = await Promise.all([
      fs.readFile(filePath, 'utf-8'), fs.stat(filePath), getRecipeOwner(recipeId), getRecipeImage(recipeId)
    ]);
    const parsed = parseRecipeFile(rawContent, recipeId.replace(/_/g, ' '));
    res.set('Cache-Control', 'private, no-store');
    res.json({
      id: recipeId, title: parsed.title, content: parsed.content, category: parsed.category,
      servings: parsed.servings, nutrition: parsed.nutrition,
      nutritionFoods: parsed.nutritionFoods, nutritionStatus: parsed.nutritionStatus,
      nutritionMessage: parsed.nutritionMessage, updatedAt: fileStats.mtime.toISOString(),
      imageUrl, author: owner, expiresAt: new Date(expiresAt).toISOString()
    });
  } catch {
    res.status(410).json({ error: 'Ce lien de partage est invalide ou a expiré.' });
  }
});

// Connexion.
app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!username || !password) {
      return res.status(400).json({ error: 'Identifiants invalides' });
    }

    return handleLoginAttempt(req, res, username, password);
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Erreur lors de la connexion' });
  }
});

// Vérifie les identifiants et crée une session révocable côté serveur.
async function handleLoginAttempt(req, res, username, password) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const logAttempt = (success, reason = '') => {
    db.run(
      'INSERT INTO login_logs (username, ip, success, reason) VALUES (?, ?, ?, ?)',
      [String(username).slice(0, 100), String(ip).slice(0, 100), success ? 1 : 0, reason]
    );
  };
  
  db.get("SELECT * FROM users WHERE username = ?", [username], async (err, row) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Erreur du serveur' });
    }
    
    if (!row) {
      return db.get(
        "SELECT 1 AS pending FROM pending_users WHERE username = ? AND status = 'pending'",
        [username],
        (pendingError, pending) => {
          if (pendingError) {
            console.error('Database error:', pendingError);
            return res.status(500).json({ error: 'Erreur du serveur' });
          }
          if (pending) {
            logAttempt(false, 'Compte en attente de validation');
            return res.status(403).json({ error: "Compte pas encore validé par l'administrateur" });
          }
          logAttempt(false, 'Identifiants invalides');
          return res.status(401).json({ error: 'Identifiants invalides' });
        }
      );
    }

    if (row.blocked_until && new Date(row.blocked_until).getTime() > Date.now()) {
      logAttempt(false, 'Compte bloqué');
      return res.status(403).json({
        error: "Compte bloqué, merci d'attendre la fin de la période de blocage",
        blockedUntil: row.blocked_until
      });
    }
    
    const isValid = await bcrypt.compare(password, row.password);
    
    if (!isValid) {
      logAttempt(false, 'Identifiants invalides');
      return res.status(401).json({ error: 'Identifiants invalides' });
    }
    
    const sessionId = createSessionId();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const userAgent = String(req.get('user-agent') || 'Appareil inconnu').slice(0, 300);
    db.run(
      `INSERT INTO sessions (id, username, user_agent, ip, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      [sessionId, row.username, userAgent, String(ip).slice(0, 100), expiresAt],
      sessionError => {
        if (sessionError) return res.status(500).json({ error: 'Erreur lors de la création de la session' });
        logAttempt(true, 'Connexion réussie');
        const token = jwt.sign(
          { username: row.username, role: row.role, sid: sessionId },
          JWT_SECRET,
          { expiresIn: '24h' }
        );
        setSsoCookie(res, sessionId);
        res.json({ token, username: row.username, role: row.role });
      }
    );
  });
}

function describePasskeyDevice(userAgent = '') {
  const ua = String(userAgent).trim().slice(0, 500);
  let deviceLabel = 'Appareil non identifié';
  if (/iPhone/i.test(ua)) deviceLabel = 'iPhone';
  else if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && /Mobile/i.test(ua))) deviceLabel = 'iPad';
  else if (/Android/i.test(ua)) {
    const model = ua.match(/Android[^;]*;\s*([^;)]+?)(?:\s+Build\/|[;)])/i)?.[1]?.replace(/^wv\s*/i, '').trim();
    deviceLabel = model && !/^K$/i.test(model) ? model : 'Appareil Android';
  } else if (/Windows/i.test(ua)) deviceLabel = 'Ordinateur Windows';
  else if (/Macintosh|Mac OS X/i.test(ua)) deviceLabel = 'Mac';
  else if (/CrOS/i.test(ua)) deviceLabel = 'Chromebook';
  else if (/Linux/i.test(ua)) deviceLabel = 'Ordinateur Linux';

  let browserName = 'Navigateur non identifié';
  if (/EdgiOS|EdgA|Edg\//i.test(ua)) browserName = 'Microsoft Edge';
  else if (/CriOS|Chrome\//i.test(ua)) browserName = 'Google Chrome';
  else if (/FxiOS|Firefox\//i.test(ua)) browserName = 'Mozilla Firefox';
  else if (/OPiOS|OPR\//i.test(ua)) browserName = 'Opera';
  else if (/Safari\//i.test(ua)) browserName = 'Safari';
  return { deviceLabel, browserName, userAgent: ua };
}

function createPasskeySession(req, res, user, callback) {
  const sessionId = createSessionId();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const userAgent = String(req.get('user-agent') || 'Appareil inconnu').slice(0, 300);
  const ip = String(req.ip || req.socket.remoteAddress || 'unknown').slice(0, 100);
  db.run(
    `INSERT INTO sessions (id, username, user_agent, ip, expires_at) VALUES (?, ?, ?, ?, ?)`,
    [sessionId, user.username, userAgent, ip, expiresAt],
    error => {
      if (error) return callback(error);
      const token = jwt.sign({ username: user.username, role: user.role, sid: sessionId }, JWT_SECRET, { expiresIn: '24h' });
      setSsoCookie(res, sessionId);
      callback(null, token);
    }
  );
}

app.post('/api/passkeys/register/options', authMiddleware, async (req, res) => {
  try {
    const { generateRegistrationOptions } = await webauthnPromise;
    db.all('SELECT credential_id, transports FROM passkeys WHERE username = ?', [req.user.username], async (error, passkeys) => {
      if (error) return res.status(500).json({ error: 'Impossible de charger les connexions biométriques' });
      const options = await generateRegistrationOptions({
        rpName: 'Goodwater', rpID: WEBAUTHN_RP_ID,
        userName: req.user.username, userDisplayName: req.user.username,
        userID: crypto.createHash('sha256').update(req.user.username).digest(),
        attestationType: 'none',
        excludeCredentials: passkeys.map(passkey => ({ id: passkey.credential_id, transports: JSON.parse(passkey.transports || '[]') })),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' }
      });
      passkeyChallenges.set(`register:${req.user.username}`, { challenge: options.challenge, expires: Date.now() + 5 * 60 * 1000 });
      res.json(options);
    });
  } catch (error) {
    logger?.error(`Passkey registration options: ${error.message}`);
    res.status(500).json({ error: 'Impossible de préparer la connexion biométrique' });
  }
});

app.post('/api/passkeys/register/verify', authMiddleware, async (req, res) => {
  const pending = passkeyChallenges.get(`register:${req.user.username}`);
  if (!pending || pending.expires < Date.now()) return res.status(400).json({ error: 'Demande de connexion biométrique expirée' });
  try {
    const { verifyRegistrationResponse } = await webauthnPromise;
    const verification = await verifyRegistrationResponse({
      response: req.body, expectedChallenge: pending.challenge,
      expectedOrigin: WEBAUTHN_ORIGIN, expectedRPID: WEBAUTHN_RP_ID
    });
    if (!verification.verified) return res.status(400).json({ error: 'Connexion biométrique non vérifiée' });
    const info = verification.registrationInfo;
    const credential = info.credential;
    const device = describePasskeyDevice(req.get('user-agent'));
    db.run(
      `INSERT INTO passkeys (credential_id, username, public_key, counter, transports, device_type, backed_up, device_label, browser_name, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [credential.id, req.user.username, Buffer.from(credential.publicKey), credential.counter,
        JSON.stringify(credential.transports || req.body.response?.transports || []), info.credentialDeviceType,
        info.credentialBackedUp ? 1 : 0, device.deviceLabel, device.browserName, device.userAgent],
      error => {
        if (error) return res.status(error.code === 'SQLITE_CONSTRAINT' ? 409 : 500).json({ error: 'Cette connexion biométrique est déjà enregistrée' });
        passkeyChallenges.delete(`register:${req.user.username}`);
        res.json({ verified: true });
      }
    );
  } catch (error) {
    logger?.error(`Passkey registration verification: ${error.message}`);
    res.status(400).json({ error: 'Connexion biométrique invalide' });
  }
});

app.get('/api/passkeys', authMiddleware, (req, res) => {
  db.all(
    `SELECT rowid AS id, device_type AS deviceType, backed_up AS backedUp, created_at AS createdAt,
            device_label AS deviceLabel, browser_name AS browserName
       FROM passkeys WHERE username = ? ORDER BY created_at DESC, rowid DESC`,
    [req.user.username],
    (error, rows) => error
      ? res.status(500).json({ error: 'Impossible de charger les connexions biométriques' })
      : res.json(rows.map(row => ({ ...row, backedUp: Boolean(row.backedUp) })))
  );
});

app.delete('/api/passkeys/:id', authMiddleware, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Connexion biométrique invalide' });
  db.run('DELETE FROM passkeys WHERE rowid = ? AND username = ?', [id, req.user.username], function(error) {
    if (error) return res.status(500).json({ error: 'Impossible de supprimer la connexion biométrique' });
    if (!this.changes) return res.status(404).json({ error: 'Connexion biométrique introuvable' });
    res.json({ message: 'Connexion biométrique supprimée' });
  });
});

app.post('/api/passkeys/login/options', loginLimiter, async (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim().slice(0, 100) : '';
  if (!username) return res.status(400).json({ error: "Saisissez d’abord votre nom d’utilisateur" });
  try {
    const { generateAuthenticationOptions } = await webauthnPromise;
    db.all('SELECT credential_id, transports FROM passkeys WHERE username = ?', [username], async (error, passkeys) => {
      if (error) return res.status(500).json({ error: 'Erreur du serveur' });
      if (!passkeys.length) return res.status(404).json({ error: 'Aucune connexion biométrique enregistrée pour ce compte' });
      const options = await generateAuthenticationOptions({
        rpID: WEBAUTHN_RP_ID, userVerification: 'preferred',
        allowCredentials: passkeys.map(passkey => ({ id: passkey.credential_id, transports: JSON.parse(passkey.transports || '[]') }))
      });
      passkeyChallenges.set(`login:${username}`, { challenge: options.challenge, expires: Date.now() + 5 * 60 * 1000 });
      res.json(options);
    });
  } catch { res.status(500).json({ error: 'Impossible de préparer la connexion biométrique' }); }
});

app.post('/api/passkeys/login/verify', loginLimiter, async (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim().slice(0, 100) : '';
  const response = req.body.response;
  const pending = passkeyChallenges.get(`login:${username}`);
  if (!pending || pending.expires < Date.now() || !response?.id) return res.status(400).json({ error: 'Demande de connexion expirée' });
  db.get(
    `SELECT p.*, u.role, u.blocked_until FROM passkeys p JOIN users u ON u.username = p.username
       WHERE p.credential_id = ? AND p.username = ?`,
    [response.id, username],
    async (error, passkey) => {
      if (error) return res.status(500).json({ error: 'Erreur du serveur' });
      if (!passkey) return res.status(401).json({ error: 'Connexion biométrique inconnue' });
      if (passkey.blocked_until && new Date(passkey.blocked_until).getTime() > Date.now()) return res.status(403).json({ error: 'Compte temporairement bloqué' });
      try {
        const { verifyAuthenticationResponse } = await webauthnPromise;
        const verification = await verifyAuthenticationResponse({
          response, expectedChallenge: pending.challenge, expectedOrigin: WEBAUTHN_ORIGIN, expectedRPID: WEBAUTHN_RP_ID,
          credential: {
            id: passkey.credential_id, publicKey: new Uint8Array(passkey.public_key), counter: passkey.counter,
            transports: JSON.parse(passkey.transports || '[]')
          }
        });
        if (!verification.verified) return res.status(401).json({ error: 'Connexion biométrique non vérifiée' });
        const device = describePasskeyDevice(req.get('user-agent'));
        db.run(
          'UPDATE passkeys SET counter = ?, device_label = ?, browser_name = ?, user_agent = ? WHERE credential_id = ?',
          [verification.authenticationInfo.newCounter, device.deviceLabel, device.browserName, device.userAgent, passkey.credential_id]
        );
        passkeyChallenges.delete(`login:${username}`);
        createPasskeySession(req, res, { username, role: passkey.role }, (sessionError, token) => {
          if (sessionError) return res.status(500).json({ error: 'Erreur lors de la création de la session' });
          db.run('INSERT INTO login_logs (username, ip, success, reason) VALUES (?, ?, 1, ?)', [username, String(req.ip).slice(0, 100), 'Connexion biométrique']);
          res.json({ token, username, role: passkey.role });
        });
      } catch (error) {
        logger?.error(`Passkey authentication: ${error.message}`);
        res.status(401).json({ error: 'Connexion biométrique invalide' });
      }
    }
  );
});

async function sendRegistrationEmail(pendingId, username) {
  const approveToken = jwt.sign({ purpose: 'registration', pendingId, decision: 'approve' }, JWT_SECRET, { expiresIn: '7d' });
  const rejectToken = jwt.sign({ purpose: 'registration', pendingId, decision: 'reject' }, JWT_SECRET, { expiresIn: '7d' });
  const approveUrl = `${APP_BASE_URL}/registration-action?token=${encodeURIComponent(approveToken)}`;
  const rejectUrl = `${APP_BASE_URL}/registration-action?token=${encodeURIComponent(rejectToken)}`;
  await mailTransport.sendMail({
    from: 'Goodwater Recipes <no-reply@goodwater-recipes.fr>',
    to: ADMIN_EMAIL,
    subject: `Nouvelle inscription Goodwater Recipes : ${username}`,
    text: `L'utilisateur ${username} demande un compte.\n\nAccepter : ${approveUrl}\n\nRefuser : ${rejectUrl}\n`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;padding:24px;color:#1f2937"><h2>Nouvelle demande d'inscription</h2><p><strong>${username}</strong> souhaite créer un compte Goodwater Recipes.</p><div style="margin:28px 0"><a href="${approveUrl}" style="display:inline-block;margin:0 12px 10px 0;padding:12px 22px;border-radius:7px;background:#16803c;color:#fff;text-decoration:none;font-weight:bold">Accepter</a><a href="${rejectUrl}" style="display:inline-block;padding:12px 22px;border-radius:7px;background:#c62828;color:#fff;text-decoration:none;font-weight:bold">Refuser</a></div><p style="font-size:13px;color:#6b7280">La décision est appliquée immédiatement au clic. Ces boutons expirent dans 7 jours.</p></div>`
  });
}

function resolveRegistration(pendingId, decision, callback) {
  db.get('SELECT * FROM pending_users WHERE id = ? AND status = ?', [pendingId, 'pending'], (readError, pending) => {
    if (readError) return callback(readError);
    if (!pending) return callback(null, null);
    if (decision === 'reject') {
      return db.run("UPDATE pending_users SET status = 'rejected', resolved_at = CURRENT_TIMESTAMP WHERE id = ?", [pendingId], error => callback(error, { username: pending.username, decision }));
    }
    db.run('INSERT INTO users (username, password, role) VALUES (?, ?, ?)', [pending.username, pending.password, 'viewer'], insertError => {
      if (insertError) return callback(insertError);
      db.run("UPDATE pending_users SET status = 'approved', resolved_at = CURRENT_TIMESTAMP WHERE id = ?", [pendingId], error => callback(error, { username: pending.username, decision }));
    });
  });
}

// Toute inscription doit être validée par un administrateur.
app.post('/api/register', loginLimiter, async (req, res) => {
  try {
    const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Le nom utilisateur et le mot de passe sont requis' });
    }
    
    if (!/^[a-zA-Z0-9_-]{3,30}$/.test(username)) {
      return res.status(400).json({ error: 'Le nom utilisateur doit contenir entre 3 et 30 lettres, chiffres, tirets ou underscores' });
    }
    
    if (password.length < 8 || password.length > 128) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir entre 8 et 128 caractères' });
    }
    
    db.get(
      `SELECT 1 AS found FROM users WHERE username = ?
       UNION ALL SELECT 1 FROM pending_users WHERE username = ? AND status = 'pending' LIMIT 1`,
      [username, username],
      async (lookupError, existing) => {
        if (lookupError) return res.status(500).json({ error: 'Erreur lors de la demande' });
        if (existing) return res.status(409).json({ error: 'Ce nom utilisateur existe déjà ou attend une validation' });
        try {
          const hashedPassword = await bcrypt.hash(password, 12);
          db.run(
            'INSERT INTO pending_users (username, password, request_ip) VALUES (?, ?, ?)',
            [username, hashedPassword, req.ip || req.socket.remoteAddress || 'unknown'],
            async function(insertError) {
              if (insertError) return res.status(500).json({ error: 'Erreur lors de la demande' });
              try {
                await sendRegistrationEmail(this.lastID, username);
              } catch (mailError) {
                console.error('Registration email error:', mailError);
              }
              res.status(202).json({ message: 'Demande envoyée. Un administrateur doit valider votre compte.' });
            }
          );
        } catch (hashError) {
          res.status(500).json({ error: 'Erreur lors de la demande' });
        }
      }
    );
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Erreur lors de l’inscription' });
  }
});

// Profil de l'utilisateur connecté.
app.get('/api/profile', authMiddleware, (req, res) => {
  db.get(
    `SELECT username, role, COALESCE(first_name, '') AS firstName,
            COALESCE(last_name, '') AS lastName,
            COALESCE(description, '') AS description
       FROM users WHERE username = ?`,
    [req.user.username],
    (error, profile) => {
      if (error) return res.status(500).json({ error: 'Erreur lors du chargement du profil' });
      if (!profile) return res.status(404).json({ error: 'Utilisateur introuvable' });
      res.json(profile);
    }
  );
});

app.put('/api/profile', authMiddleware, (req, res) => {
  const fields = {
    firstName: typeof req.body.firstName === 'string' ? req.body.firstName.trim() : '',
    lastName: typeof req.body.lastName === 'string' ? req.body.lastName.trim() : '',
    description: typeof req.body.description === 'string' ? req.body.description.trim() : ''
  };
  if (fields.firstName.length > 60 || fields.lastName.length > 60) {
    return res.status(400).json({ error: 'Le prénom et le nom sont limités à 60 caractères' });
  }
  if (fields.description.length > 500) {
    return res.status(400).json({ error: 'La description est limitée à 500 caractères' });
  }

  db.run(
    'UPDATE users SET first_name = ?, last_name = ?, description = ? WHERE username = ?',
    [fields.firstName, fields.lastName, fields.description, req.user.username],
    function(error) {
      if (error) return res.status(500).json({ error: 'Erreur lors de la sauvegarde du profil' });
      if (!this.changes) return res.status(404).json({ error: 'Utilisateur introuvable' });
      res.json({ username: req.user.username, role: req.user.role, ...fields });
    }
  );
});

app.put('/api/profile/password', authMiddleware, async (req, res) => {
  const currentPassword = typeof req.body.currentPassword === 'string' ? req.body.currentPassword : '';
  const newPassword = typeof req.body.newPassword === 'string' ? req.body.newPassword : '';
  if (!currentPassword) {
    return res.status(400).json({ error: 'Le mot de passe actuel est requis' });
  }
  if (newPassword.length < 8 || newPassword.length > 128) {
    return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir entre 8 et 128 caractères' });
  }
  if (currentPassword === newPassword) {
    return res.status(400).json({ error: 'Le nouveau mot de passe doit être différent de l’ancien' });
  }

  try {
    db.get('SELECT password FROM users WHERE username = ?', [req.user.username], async (readError, user) => {
      if (readError) return res.status(500).json({ error: 'Erreur lors de la vérification du mot de passe' });
      if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

      try {
        const validCurrentPassword = await bcrypt.compare(currentPassword, user.password);
        if (!validCurrentPassword) {
          const ip = req.ip || req.socket.remoteAddress || 'unknown';
          db.run(
            'INSERT INTO admin_logs (username, target_username, action, ip, success) VALUES (?, ?, ?, ?, ?)',
            [req.user.username, req.user.username, 'password_change_failed_self', String(ip).slice(0, 100), 0],
            logError => {
              if (logError) console.error('Failed password change audit log error:', logError);
            }
          );
          return res.status(400).json({ error: 'Le mot de passe actuel est incorrect' });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 12);
        db.run('UPDATE users SET password = ? WHERE username = ?', [hashedPassword, req.user.username], function(updateError) {
          if (updateError) return res.status(500).json({ error: 'Erreur lors du changement de mot de passe' });
          db.run(
            'UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE username = ? AND id <> ? AND revoked_at IS NULL',
            [req.user.username, req.sessionId || ''],
            sessionError => {
              if (sessionError) return res.status(500).json({ error: 'Mot de passe modifié, mais erreur lors de la fermeture des autres sessions' });
              auditAction(req, req.user.username, 'password_changed_self');
              res.json({ message: 'Mot de passe modifié. Les autres appareils ont été déconnectés.' });
            }
          );
        });
      } catch {
        res.status(500).json({ error: 'Erreur lors du changement de mot de passe' });
      }
    });
  } catch {
    res.status(500).json({ error: 'Erreur lors du changement de mot de passe' });
  }
});

app.get('/api/sessions', authMiddleware, (req, res) => {
  db.all(
    `SELECT id, user_agent AS userAgent, ip, created_at AS createdAt,
            last_seen_at AS lastSeenAt, expires_at AS expiresAt
       FROM sessions WHERE username = ? AND revoked_at IS NULL
         AND datetime(expires_at) > datetime('now') ORDER BY last_seen_at DESC`,
    [req.user.username],
    (error, sessions) => error
      ? res.status(500).json({ error: 'Erreur lors du chargement des sessions' })
      : res.json(sessions.map(session => ({ ...session, current: session.id === req.sessionId })))
  );
});

app.delete('/api/sessions/:id', authMiddleware, (req, res) => {
  db.run(
    'UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND username = ? AND revoked_at IS NULL',
    [req.params.id, req.user.username],
    function(error) {
      if (error) return res.status(500).json({ error: 'Erreur lors de la déconnexion de l’appareil' });
      if (!this.changes) return res.status(404).json({ error: 'Session introuvable' });
      res.json({ message: 'Appareil déconnecté', current: req.params.id === req.sessionId });
    }
  );
});

app.post('/api/logout', authMiddleware, (req, res) => {
  const finish = () => {
    setSsoCookie(res, '', 0);
    res.json({ message: 'Déconnexion effectuée' });
  };
  if (!req.sessionId) return finish();
  db.run('UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?', [req.sessionId], error => {
    if (error) return res.status(500).json({ error: 'Erreur lors de la déconnexion' });
    finish();
  });
});

app.get('/api/session', authMiddleware, (req, res) => {
  res.json({ username: req.user.username, role: req.user.role });
});

// Administration
app.get('/api/admin/pending-users', authMiddleware, adminMiddleware, (req, res) => {
  db.all(
    `SELECT id, username, request_ip AS requestIp, created_at AS createdAt
       FROM pending_users WHERE status = 'pending' ORDER BY id ASC`,
    [],
    (error, pending) => error
      ? res.status(500).json({ error: 'Erreur lors du chargement des demandes' })
      : res.json(pending)
  );
});

app.post('/api/admin/pending-users/:id/:decision', authMiddleware, adminMiddleware, (req, res) => {
  const decision = req.params.decision;
  if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'Décision invalide' });
  resolveRegistration(Number(req.params.id), decision, (error, result) => {
    if (error) return res.status(500).json({ error: 'Erreur lors du traitement de la demande' });
    if (!result) return res.status(404).json({ error: 'Demande introuvable ou déjà traitée' });
    auditAction(req, result.username, decision === 'approve' ? 'registration_approved' : 'registration_rejected');
    res.json({ message: decision === 'approve' ? `${result.username} a été accepté` : `${result.username} a été refusé` });
  });
});

app.post('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const role = ['viewer', 'editor', 'grand_chef'].includes(req.body.role) ? req.body.role : 'viewer';
  if (!/^[a-zA-Z0-9_-]{3,30}$/.test(username)) return res.status(400).json({ error: 'Nom utilisateur invalide' });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Mot de passe invalide' });
  try {
    const hash = await bcrypt.hash(password, 12);
    db.run('INSERT INTO users (username, password, role) VALUES (?, ?, ?)', [username, hash, role], function(error) {
      if (error?.code === 'SQLITE_CONSTRAINT') return res.status(409).json({ error: 'Cet utilisateur existe déjà' });
      if (error) return res.status(500).json({ error: 'Erreur lors de la création' });
      auditAction(req, username, 'user_created');
      res.status(201).json({ username, role });
    });
  } catch {
    res.status(500).json({ error: 'Erreur lors de la création' });
  }
});

app.put('/api/admin/users/:username/role', authMiddleware, adminMiddleware, (req, res) => {
  const role = req.body.role;
  if (!['viewer', 'editor', 'grand_chef', 'admin'].includes(role)) return res.status(400).json({ error: 'Rôle invalide' });
  if (req.params.username === req.user.username && role !== 'admin') {
    return res.status(400).json({ error: 'Vous ne pouvez pas retirer votre propre rôle administrateur' });
  }
  db.run('UPDATE users SET role = ? WHERE username = ?', [role, req.params.username], function(error) {
    if (error) return res.status(500).json({ error: 'Erreur lors du changement de rôle' });
    if (!this.changes) return res.status(404).json({ error: 'Utilisateur introuvable' });
    auditAction(req, req.params.username, 'role_changed');
    res.json({ username: req.params.username, role });
  });
});

app.get('/api/admin/users', authMiddleware, adminMiddleware, (req, res) => {
  db.all(
    `SELECT username, role, COALESCE(first_name, '') AS firstName,
            COALESCE(last_name, '') AS lastName, blocked_until AS blockedUntil,
            created_at AS createdAt
       FROM users ORDER BY username COLLATE NOCASE`,
    [],
    (error, users) => {
      if (error) return res.status(500).json({ error: 'Erreur lors du chargement des utilisateurs' });
      res.json(users);
    }
  );
});

app.put('/api/admin/users/:username/block', authMiddleware, adminMiddleware, (req, res) => {
  const username = req.params.username;
  const durationMinutes = Number(req.body.durationMinutes);
  if (username === req.user.username) return res.status(400).json({ error: 'Vous ne pouvez pas bloquer votre propre compte' });
  if (!Number.isFinite(durationMinutes) || durationMinutes < 0 || durationMinutes > 525600) {
    return res.status(400).json({ error: 'Durée de blocage invalide' });
  }
  const blockedUntil = durationMinutes === 0 ? null : new Date(Date.now() + Math.round(durationMinutes) * 60_000).toISOString();
  db.run('UPDATE users SET blocked_until = ? WHERE username = ?', [blockedUntil, username], function(error) {
    if (error) return res.status(500).json({ error: 'Erreur lors du blocage' });
    if (!this.changes) return res.status(404).json({ error: 'Utilisateur introuvable' });
    auditAction(req, username, durationMinutes === 0 ? 'user_unblocked' : 'user_blocked');
    res.json({ username, blockedUntil });
  });
});

app.put('/api/admin/users/:username/password', authMiddleware, adminMiddleware, async (req, res) => {
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (password.length < 8 || password.length > 128) {
    return res.status(400).json({ error: 'Le mot de passe doit contenir entre 8 et 128 caractères' });
  }
  try {
    const hashedPassword = await bcrypt.hash(password, 12);
    db.run('UPDATE users SET password = ? WHERE username = ?', [hashedPassword, req.params.username], function(error) {
      if (error) return res.status(500).json({ error: 'Erreur lors de la réinitialisation' });
      if (!this.changes) return res.status(404).json({ error: 'Utilisateur introuvable' });
      db.run(
        `UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP
          WHERE username = ? AND revoked_at IS NULL AND (? <> ? OR id <> ?)`,
        [req.params.username, req.params.username, req.user.username, req.sessionId || ''],
        sessionError => {
          if (sessionError) return res.status(500).json({ error: 'Mot de passe réinitialisé, mais erreur lors de la fermeture des sessions' });
          auditAction(req, req.params.username, 'password_changed');
          res.json({ message: 'Mot de passe réinitialisé et sessions déconnectées' });
        }
      );
    });
  } catch {
    res.status(500).json({ error: 'Erreur lors de la réinitialisation' });
  }
});

app.delete('/api/admin/users/:username', authMiddleware, adminMiddleware, (req, res) => {
  const username = req.params.username;
  if (username === req.user.username) {
    return res.status(400).json({ error: 'Vous ne pouvez pas supprimer votre propre compte' });
  }
  db.get('SELECT role FROM users WHERE username = ?', [username], (readError, user) => {
    if (readError) return res.status(500).json({ error: 'Erreur lors de la suppression' });
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    if (user.role === 'admin') return res.status(403).json({ error: 'Un compte administrateur ne peut pas être supprimé ici' });
    db.run('DELETE FROM users WHERE username = ?', [username], function(deleteError) {
      if (deleteError) return res.status(500).json({ error: 'Erreur lors de la suppression' });
      auditAction(req, username, 'user_deleted');
      res.json({ message: `Utilisateur ${username} supprimé` });
    });
  });
});

app.get('/api/admin/stats', authMiddleware, adminMiddleware, (req, res) => {
  const queries = [
    ["SELECT COUNT(*) AS value FROM users", 'users'],
    ["SELECT COUNT(*) AS value FROM users WHERE blocked_until IS NOT NULL AND datetime(blocked_until) > datetime('now')", 'blocked'],
    ["SELECT COUNT(*) AS value FROM pending_users WHERE status = 'pending'", 'pending'],
    ["SELECT COUNT(*) AS value FROM login_logs WHERE success = 1 AND timestamp >= datetime('now', '-24 hours')", 'successfulLogins'],
    ["SELECT COUNT(*) AS value FROM login_logs WHERE success = 0 AND timestamp >= datetime('now', '-24 hours')", 'failedLogins'],
    ["SELECT COUNT(*) AS value FROM recipe_trash", 'trashedRecipes']
  ];
  const stats = {};
  let remaining = queries.length;
  queries.forEach(([sql, key]) => db.get(sql, [], (error, row) => {
    if (res.headersSent) return;
    if (error) return res.status(500).json({ error: 'Erreur lors du chargement des statistiques' });
    stats[key] = row.value;
    remaining -= 1;
    if (!remaining) res.json(stats);
  }));
});

app.get('/api/admin/stats/:key/details', authMiddleware, adminMiddleware, (req, res) => {
  const queries = {
    users: `SELECT username, role AS detail, created_at AS timestamp
              FROM users ORDER BY username COLLATE NOCASE`,
    blocked: `SELECT username, 'Bloqué jusqu’au ' || blocked_until AS detail, blocked_until AS timestamp
                FROM users
               WHERE blocked_until IS NOT NULL AND datetime(blocked_until) > datetime('now')
               ORDER BY datetime(blocked_until) DESC`,
    pending: `SELECT username, 'Demande en attente' AS detail, created_at AS timestamp
                FROM pending_users WHERE status = 'pending' ORDER BY datetime(created_at) DESC`,
    successfulLogins: `SELECT username, COUNT(*) || ' connexion(s)' AS detail, MAX(timestamp) AS timestamp
                         FROM login_logs
                        WHERE success = 1 AND timestamp >= datetime('now', '-24 hours')
                        GROUP BY username ORDER BY COUNT(*) DESC, username COLLATE NOCASE`,
    failedLogins: `SELECT username, COUNT(*) || ' échec(s)' AS detail, MAX(timestamp) AS timestamp
                     FROM login_logs
                    WHERE success = 0 AND timestamp >= datetime('now', '-24 hours')
                    GROUP BY username ORDER BY COUNT(*) DESC, username COLLATE NOCASE`,
    trashedRecipes: `SELECT recipe_id AS id, title AS username,
                            'Auteur : ' || COALESCE(NULLIF(owner_username, ''), 'inconnu') || ' · supprimée par ' || deleted_by AS detail,
                            deleted_at AS timestamp
                       FROM recipe_trash ORDER BY datetime(deleted_at) DESC`
  };
  const sql = queries[req.params.key];
  if (!sql) return res.status(404).json({ error: 'Statistique inconnue' });
  db.all(sql, [], (error, rows) => error
    ? res.status(500).json({ error: 'Erreur lors du chargement du détail' })
    : res.json(rows)
  );
});

app.get('/api/admin/login-logs', authMiddleware, adminMiddleware, (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 200);
  db.all(
    `SELECT id, username, actor_username AS actorUsername,
            target_username AS targetUsername, action, ip, success, reason, timestamp
       FROM (
         SELECT id, username, username AS actor_username,
                username AS target_username, 'login' AS action,
                ip, COALESCE(success, 1) AS success,
                COALESCE(reason, '') AS reason, timestamp
           FROM login_logs
         UNION ALL
         SELECT id, username, username AS actor_username,
                target_username, action, ip, COALESCE(success, 1) AS success,
                CASE action
                  WHEN 'password_changed' THEN 'Mot de passe de ' || target_username || ' modifié'
                  WHEN 'password_changed_self' THEN 'Mot de passe personnel modifié'
                  WHEN 'password_change_failed_self' THEN 'Échec du changement de mot de passe personnel'
                  WHEN 'registration_approved' THEN 'Inscription acceptée'
                  WHEN 'registration_rejected' THEN 'Inscription refusée'
                  WHEN 'user_created' THEN 'Utilisateur créé'
                  WHEN 'role_changed' THEN 'Rôle utilisateur modifié'
                  WHEN 'user_blocked' THEN 'Utilisateur bloqué'
                  WHEN 'user_unblocked' THEN 'Utilisateur débloqué'
                  WHEN 'user_deleted' THEN 'Utilisateur supprimé'
                  WHEN 'recipe_trashed' THEN 'Recette placée dans la corbeille'
                  WHEN 'recipe_restored' THEN 'Recette restaurée'
                  WHEN 'recipe_deleted_permanently' THEN 'Recette supprimée définitivement'
                  ELSE action
                END AS reason,
                timestamp
           FROM admin_logs
       )
      ORDER BY timestamp DESC, id DESC LIMIT ?`,
    [limit],
    (error, logs) => {
      if (error) return res.status(500).json({ error: 'Erreur lors du chargement des connexions' });
      res.json(logs);
    }
  );
});

// Crée une recette et enregistre son propriétaire.
app.post('/api/recipes', apiLimiter, authMiddleware, recipeWriteMiddleware, async (req, res) => {
  try {
    const recipe = validateRecipePayload(req.body);
    if (!recipe) return res.status(400).json({ error: 'Le titre et le contenu sont requis, avec un titre limité à 200 caractères' });
    const { title, content } = recipe;
    
    const safeTitle = sanitizeFilename(title);
    if (!safeTitle) {
      return res.status(400).json({ error: 'Titre invalide' });
    }
    
    let filePath = path.join(RECIPES_DIR, safeTitle + '.cook');
    let counter = 1;
    
    while (await fs.pathExists(filePath)) {
      filePath = path.join(RECIPES_DIR, safeTitle + '_' + counter + '.cook');
      counter++;
    }
    
    const serializedContent = serializeRecipeFile(title, content);
    await fs.writeFile(filePath, serializedContent, 'utf-8');
    
    const recipeId = path.basename(filePath, '.cook');
    try {
      await setRecipeOwner(recipeId, req.user.username);
    } catch (ownerError) {
      await fs.remove(filePath);
      throw ownerError;
    }
    
    const parsed = parseRecipeFile(serializedContent, title);
    const now = new Date().toISOString();
    res.status(201).json({
      id: recipeId,
      title: title,
      content: content,
      category: parsed.category,
      servings: parsed.servings,
      nutrition: parsed.nutrition,
      nutritionFoods: parsed.nutritionFoods,
      nutritionStatus: parsed.nutritionStatus,
      nutritionMessage: parsed.nutritionMessage,
      createdAt: now,
      updatedAt: now,
      imageUrl: null,
      author: req.user.username,
      canEdit: true
    });
  } catch (error) {
    console.error('Error creating recipe:', error);
    res.status(500).json({ error: 'Erreur lors de la création de la recette' });
  }
});

// Modifie une recette sans changer son propriétaire ni son identifiant.
app.put('/api/recipes/:id', apiLimiter, authMiddleware, recipeWriteMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const recipe = validateRecipePayload(req.body);
    if (!recipe) return res.status(400).json({ error: 'Le titre et le contenu sont requis, avec un titre limité à 200 caractères' });
    const { title, content } = recipe;
    
    const sanitizedId = sanitizeRecipeId(id);
    const filePath = path.join(RECIPES_DIR, sanitizedId + '.cook');
    
    if (!await fs.pathExists(filePath)) {
      return res.status(404).json({ error: 'Recette introuvable' });
    }
    const owner = await getRecipeOwner(sanitizedId);
    if (!canEditRecipe(req.user, owner)) {
      return res.status(403).json({ error: 'Vous ne pouvez modifier que les recettes que vous avez créées' });
    }
    
    const serializedContent = serializeRecipeFile(title, content);
    await fs.writeFile(filePath, serializedContent, 'utf-8');
    const parsed = parseRecipeFile(serializedContent, title);
    const fileStats = await fs.stat(filePath);
    
    res.json({
      id: sanitizedId,
      title: title,
      content: content,
      category: parsed.category,
      servings: parsed.servings,
      nutrition: parsed.nutrition,
      nutritionFoods: parsed.nutritionFoods,
      nutritionStatus: parsed.nutritionStatus,
      nutritionMessage: parsed.nutritionMessage,
      createdAt: fileStats.birthtime.toISOString(),
      updatedAt: fileStats.mtime.toISOString(),
      imageUrl: await getRecipeImage(sanitizedId),
      author: owner,
      canEdit: true
    });
  } catch (error) {
    console.error('Error updating recipe:', error);
    res.status(500).json({ error: 'Erreur lors de la modification de la recette' });
  }
});

async function illustrateRecipeImage(sourceImage, title) {
  if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
    const error = new Error('CLOUDFLARE_NOT_CONFIGURED');
    error.code = 'CLOUDFLARE_NOT_CONFIGURED';
    throw error;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const requestBody = JSON.stringify({
      prompt: `Illustration culinaire éditoriale homogène de ${title}, plat appétissant au centre, vue légèrement plongeante, lumière naturelle douce, couleurs chaudes, fond beige sobre, composition élégante, sans texte, sans personne`,
      negative_prompt: 'text, watermark, logo, hands, people, clutter, distorted food, oversaturated colors',
      image_b64: sourceImage.toString('base64'),
      strength: 0.38,
      guidance: 7.5,
      num_steps: 20,
      width: 1024,
      height: 768
    });
    const attempts = [
      { model: '@cf/runwayml/stable-diffusion-v1-5-img2img', multipart: false },
      { model: '@cf/runwayml/stable-diffusion-v1-5-img2img', multipart: false },
      { model: '@cf/black-forest-labs/flux-2-klein-4b', multipart: true }
    ];
    let response;
    for (let attempt = 0; attempt < attempts.length; attempt++) {
      const current = attempts[attempt];
      const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(CLOUDFLARE_ACCOUNT_ID)}/ai/run/${current.model}`;
      let body = requestBody;
      const headers = { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' };
      if (current.multipart) {
        const form = new FormData();
        form.append('prompt', `Transforme l’image 0 en illustration culinaire éditoriale homogène de ${title}, conserve fidèlement le plat, vue légèrement plongeante, lumière naturelle douce, couleurs chaudes, fond beige sobre, sans texte ni personne.`);
        form.append('input_image_0', new Blob([sourceImage], { type: 'image/jpeg' }), 'recipe.jpg');
        form.append('width', '1024');
        form.append('height', '768');
        form.append('steps', '4');
        body = form;
        delete headers['Content-Type'];
      }
      response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal
      });
      if (response.ok) break;
      const details = (await response.text()).slice(0, 500);
      const capacityExceeded = response.status === 429 && /capacity temporarily exceeded|"code":3040/i.test(details);
      if (capacityExceeded && attempt < attempts.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
        continue;
      }
      const error = new Error(`Cloudflare Workers AI ${response.status}: ${details}`);
      error.code = capacityExceeded ? 'CLOUDFLARE_CAPACITY' : response.status === 429 ? 'CLOUDFLARE_QUOTA' : 'CLOUDFLARE_ERROR';
      throw error;
    }
    const responseBuffer = Buffer.from(await response.arrayBuffer());
    if (response.headers.get('content-type')?.includes('application/json')) {
      const payload = JSON.parse(responseBuffer.toString('utf8'));
      const encodedImage = payload.result?.image || payload.image;
      if (typeof encodedImage !== 'string') throw new Error('CLOUDFLARE_IMAGE_MISSING');
      return Buffer.from(encodedImage.replace(/^data:image\/[^;]+;base64,/, ''), 'base64');
    }
    return responseBuffer;
  } finally {
    clearTimeout(timeout);
  }
}

const recipeImageParser = express.raw({
  type: ['image/jpeg', 'image/png', 'image/webp'],
  limit: '3mb'
});

app.put('/api/recipes/:id/image', authMiddleware, recipeWriteMiddleware, limitRecipeImageAi, recipeImageParser, async (req, res) => {
  try {
    const recipeId = sanitizeRecipeId(req.params.id);
    const recipePath = path.join(RECIPES_DIR, `${recipeId}.cook`);
    if (!await fs.pathExists(recipePath)) return res.status(404).json({ error: 'Recette introuvable' });
    const owner = await getRecipeOwner(recipeId);
    if (!canEditRecipe(req.user, owner)) {
      return res.status(403).json({ error: 'Vous ne pouvez modifier que les recettes que vous avez créées' });
    }
    if (!Buffer.isBuffer(req.body) || !req.body.length || req.body.length > 3 * 1024 * 1024) {
      return res.status(400).json({ error: 'Photo invalide ou trop volumineuse (3 Mo maximum)' });
    }
    if (!detectRecipeImageExtension(req.body)) {
      return res.status(400).json({ error: 'Format invalide (JPEG, PNG ou WebP)' });
    }

    let image = req.body;
    const useAi = req.query.ai === 'true';
    if (useAi) {
      const rawRecipe = await fs.readFile(recipePath, 'utf8');
      const parsedRecipe = parseRecipeFile(rawRecipe, recipeId.replace(/_/g, ' '));
      image = await illustrateRecipeImage(image, parsedRecipe.title);
    }
    const imageUrl = await saveRecipeImage(recipeId, image);
    auditAction(req, recipeId, useAi ? 'recipe_image_illustrated' : 'recipe_image_uploaded');
    res.json({ imageUrl, illustrated: useAi });
  } catch (error) {
    console.error('Recipe image error:', error.message);
    if (error.code === 'CLOUDFLARE_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'La transformation IA n’est pas configurée' });
    }
    if (error.code === 'CLOUDFLARE_QUOTA') {
      return res.status(429).json({ error: 'Quota Cloudflare atteint. Réessayez plus tard ou enregistrez la photo sans IA.' });
    }
    if (error.name === 'AbortError') {
      return res.status(504).json({ error: 'La transformation IA a pris trop de temps' });
    }
    res.status(502).json({ error: 'Impossible de transformer ou d’enregistrer la photo' });
  }
});

app.delete('/api/recipes/:id/image', authMiddleware, recipeWriteMiddleware, async (req, res) => {
  try {
    const recipeId = sanitizeRecipeId(req.params.id);
    const owner = await getRecipeOwner(recipeId);
    if (!canEditRecipe(req.user, owner)) return res.status(403).json({ error: 'Suppression non autorisée' });
    await removeRecipeImage(recipeId);
    res.json({ message: 'Photo supprimée' });
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de la suppression de la photo' });
  }
});

app.post('/api/recipes/:id/image/illustrate', authMiddleware, recipeWriteMiddleware, recipeImageAiLimiter, async (req, res) => {
  try {
    const recipeId = sanitizeRecipeId(req.params.id);
    const recipePath = path.join(RECIPES_DIR, `${recipeId}.cook`);
    const imagePath = await getRecipeImageFile(recipeId);
    if (!await fs.pathExists(recipePath)) return res.status(404).json({ error: 'Recette introuvable' });
    if (!imagePath) return res.status(404).json({ error: 'Ajoutez d’abord une photo' });
    const owner = await getRecipeOwner(recipeId);
    if (!canEditRecipe(req.user, owner)) return res.status(403).json({ error: 'Modification non autorisée' });
    const rawRecipe = await fs.readFile(recipePath, 'utf8');
    const parsedRecipe = parseRecipeFile(rawRecipe, recipeId.replace(/_/g, ' '));
    const sourceImage = await fs.readFile(imagePath);
    const illustratedImage = await illustrateRecipeImage(sourceImage, parsedRecipe.title);
    const imageUrl = await saveRecipeImage(recipeId, illustratedImage);
    auditAction(req, recipeId, 'recipe_image_illustrated');
    res.json({ imageUrl, illustrated: true });
  } catch (error) {
    console.error('Recipe illustration error:', error.message);
    if (error.code === 'CLOUDFLARE_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'La transformation IA n’est pas configurée' });
    }
    if (error.code === 'CLOUDFLARE_QUOTA') {
      return res.status(429).json({ error: 'Quota Cloudflare atteint. Réessayez demain.' });
    }
    if (error.code === 'CLOUDFLARE_CAPACITY') {
      return res.status(503).json({ error: 'Cloudflare est temporairement saturé. Réessayez dans quelques minutes.' });
    }
    if (error.message.includes('Cloudflare Workers AI 401')) {
      return res.status(502).json({ error: 'Le jeton Cloudflare n’a pas l’autorisation Workers AI' });
    }
    if (/input image|image dimensions|image size|too large/i.test(error.message)) {
      return res.status(400).json({ error: 'Resélectionnez la photo afin de la préparer au nouveau format IA.' });
    }
    if (error.name === 'AbortError') return res.status(504).json({ error: 'La transformation IA a pris trop de temps' });
    res.status(502).json({ error: 'Impossible de transformer la photo avec l’IA' });
  }
});

// Uniformise une photo avant la création de la recette, sans la conserver côté serveur.
app.post('/api/recipe-image-preview/illustrate', authMiddleware, recipeWriteMiddleware, recipeImageAiLimiter, recipeImageParser, async (req, res) => {
  try {
    const title = typeof req.query.title === 'string' ? req.query.title.trim().slice(0, 200) : '';
    if (!title) return res.status(400).json({ error: 'Indiquez d’abord le titre de la recette' });
    if (!Buffer.isBuffer(req.body) || !req.body.length || !detectRecipeImageExtension(req.body)) {
      return res.status(400).json({ error: 'Sélectionnez une photo JPEG, PNG ou WebP valide' });
    }
    const image = await illustrateRecipeImage(req.body, title);
    res.set('Cache-Control', 'no-store');
    res.type('image/jpeg').send(image);
  } catch (error) {
    console.error('Recipe image preview illustration error:', error.message);
    if (error.code === 'CLOUDFLARE_NOT_CONFIGURED') return res.status(503).json({ error: 'La transformation IA n’est pas configurée' });
    if (error.code === 'CLOUDFLARE_QUOTA') return res.status(429).json({ error: 'Quota Cloudflare atteint. Réessayez plus tard.' });
    if (error.code === 'CLOUDFLARE_CAPACITY') return res.status(503).json({ error: 'Cloudflare est temporairement saturé. Réessayez dans quelques minutes.' });
    if (error.name === 'AbortError') return res.status(504).json({ error: 'La transformation IA a pris trop de temps' });
    res.status(502).json({ error: 'Impossible d’uniformiser cette photo' });
  }
});

// Place une recette dans la corbeille avant de supprimer son fichier.
app.delete('/api/recipes/:id', apiLimiter, authMiddleware, recipeWriteMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const sanitizedId = sanitizeRecipeId(id);
    const filePath = path.join(RECIPES_DIR, sanitizedId + '.cook');
    
    if (!await fs.pathExists(filePath)) {
      return res.status(404).json({ error: 'Recette introuvable' });
    }
    const owner = await getRecipeOwner(sanitizedId);
    if (!canEditRecipe(req.user, owner)) {
      return res.status(403).json({ error: 'Vous ne pouvez supprimer que les recettes que vous avez créées' });
    }
    
    const rawContent = await fs.readFile(filePath, 'utf-8');
    const parsed = parseRecipeFile(rawContent, sanitizedId.replace(/_/g, ' '));
    await new Promise((resolve, reject) => db.run(
      `INSERT OR REPLACE INTO recipe_trash
       (recipe_id, title, content, owner_username, deleted_by, deleted_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [sanitizedId, parsed.title, rawContent, owner || '', req.user.username],
      error => error ? reject(error) : resolve()
    ));
    await fs.unlink(filePath);
    await deleteRecipeOwner(sanitizedId);
    await Promise.all([
      new Promise((resolve, reject) => db.run('DELETE FROM recipe_favorites WHERE recipe_id = ?', [sanitizedId], error => error ? reject(error) : resolve())),
      new Promise((resolve, reject) => db.run('DELETE FROM recipe_collection_items WHERE recipe_id = ?', [sanitizedId], error => error ? reject(error) : resolve())),
      new Promise((resolve, reject) => db.run('DELETE FROM recipe_views WHERE recipe_id = ?', [sanitizedId], error => error ? reject(error) : resolve()))
    ]);
    auditAction(req, sanitizedId, 'recipe_trashed');
    res.json({ message: 'Recette placée dans la corbeille' });
  } catch (error) {
    console.error('Error deleting recipe:', error);
    res.status(500).json({ error: 'Erreur lors de la suppression de la recette' });
  }
});

app.get('/api/recipe-trash', authMiddleware, (req, res) => {
  const seeAll = req.user.role === 'grand_chef' || req.user.role === 'admin';
  const sql = `SELECT recipe_id AS id, title, owner_username AS owner,
                      deleted_by AS deletedBy, deleted_at AS deletedAt
                 FROM recipe_trash ${seeAll ? '' : 'WHERE owner_username = ? OR deleted_by = ?'}
                ORDER BY deleted_at DESC`;
  const params = seeAll ? [] : [req.user.username, req.user.username];
  db.all(sql, params, (error, items) => error
    ? res.status(500).json({ error: 'Erreur lors du chargement de la corbeille' })
    : res.json(items));
});

app.post('/api/recipe-trash/:id/restore', authMiddleware, async (req, res) => {
  const id = sanitizeRecipeId(req.params.id);
  db.get('SELECT * FROM recipe_trash WHERE recipe_id = ?', [id], async (error, item) => {
    if (error) return res.status(500).json({ error: 'Erreur lors de la restauration' });
    if (!item) return res.status(404).json({ error: 'Recette introuvable dans la corbeille' });
    const allowed = ['grand_chef', 'admin'].includes(req.user.role)
      || item.owner_username === req.user.username || item.deleted_by === req.user.username;
    if (!allowed) return res.status(403).json({ error: 'Restauration non autorisée' });
    const filePath = path.join(RECIPES_DIR, id + '.cook');
    if (await fs.pathExists(filePath)) return res.status(409).json({ error: 'Une recette portant ce nom existe déjà' });
    let ownerInserted = false;
    try {
      await fs.ensureDir(RECIPES_DIR);
      await fs.writeFile(filePath, item.content, 'utf-8');
      await new Promise((resolve, reject) => db.run(
        'INSERT INTO recipe_owners (recipe_id, owner_username) VALUES (?, ?)',
        [id, item.owner_username || req.user.username], error => error ? reject(error) : resolve()
      ));
      ownerInserted = true;
      await new Promise((resolve, reject) => db.run(
        'DELETE FROM recipe_trash WHERE recipe_id = ?', [id], error => error ? reject(error) : resolve()
      ));
      auditAction(req, id, 'recipe_restored');
      res.json({ message: 'Recette restaurée' });
    } catch (restoreError) {
      console.error('Recipe restore error:', restoreError);
      if (ownerInserted) await deleteRecipeOwner(id).catch(() => {});
      await fs.remove(filePath).catch(() => {});
      res.status(500).json({ error: 'Erreur lors de la restauration' });
    }
  });
});

app.delete('/api/recipe-trash/:id', authMiddleware, (req, res) => {
  const id = sanitizeRecipeId(req.params.id);
  db.get('SELECT owner_username, deleted_by FROM recipe_trash WHERE recipe_id = ?', [id], (error, item) => {
    if (error) return res.status(500).json({ error: 'Erreur lors de la suppression' });
    if (!item) return res.status(404).json({ error: 'Recette introuvable dans la corbeille' });
    const allowed = ['grand_chef', 'admin'].includes(req.user.role)
      || item.owner_username === req.user.username || item.deleted_by === req.user.username;
    if (!allowed) return res.status(403).json({ error: 'Suppression non autorisée' });
    db.run('DELETE FROM recipe_trash WHERE recipe_id = ?', [id], deleteError => {
      if (deleteError) return res.status(500).json({ error: 'Erreur lors de la suppression' });
      auditAction(req, id, 'recipe_deleted_permanently');
      removeRecipeImage(id)
        .then(() => res.json({ message: 'Recette supprimée définitivement' }))
        .catch(() => res.status(500).json({ error: 'Recette supprimée, mais sa photo n’a pas pu être effacée' }));
    });
  });
});

// Bibliothèque personnelle : favoris, collections et historique de consultation.
app.get('/api/library', authMiddleware, (req, res) => {
  const username = req.user.username;
  db.all('SELECT recipe_id AS recipeId FROM recipe_favorites WHERE username = ? ORDER BY created_at DESC', [username], (favoriteError, favorites) => {
    if (favoriteError) return res.status(500).json({ error: 'Impossible de charger les favoris' });
    db.all(
      `SELECT c.id, c.name, i.recipe_id AS recipeId
         FROM recipe_collections c LEFT JOIN recipe_collection_items i ON i.collection_id = c.id
        WHERE c.username = ? ORDER BY c.name COLLATE NOCASE, i.created_at`,
      [username],
      (collectionError, rows) => {
        if (collectionError) return res.status(500).json({ error: 'Impossible de charger les collections' });
        db.all(
          'SELECT recipe_id AS recipeId, viewed_at AS viewedAt, view_count AS viewCount FROM recipe_views WHERE username = ? ORDER BY viewed_at DESC LIMIT 12',
          [username],
          (viewError, recent) => {
            if (viewError) return res.status(500).json({ error: 'Impossible de charger l’historique' });
            const collections = [];
            for (const row of rows) {
              let collection = collections.find(item => item.id === row.id);
              if (!collection) {
                collection = { id: row.id, name: row.name, recipeIds: [] };
                collections.push(collection);
              }
              if (row.recipeId) collection.recipeIds.push(row.recipeId);
            }
            res.json({ favorites: favorites.map(item => item.recipeId), collections, recent });
          }
        );
      }
    );
  });
});

app.put('/api/recipes/:id/favorite', authMiddleware, async (req, res) => {
  const recipeId = sanitizeRecipeId(req.params.id);
  if (!recipeId || !await fs.pathExists(path.join(RECIPES_DIR, `${recipeId}.cook`))) return res.status(404).json({ error: 'Recette introuvable' });
  if (req.body.favorite === false) {
    return db.run('DELETE FROM recipe_favorites WHERE username = ? AND recipe_id = ?', [req.user.username, recipeId], error => {
      if (error) return res.status(500).json({ error: 'Impossible de retirer le favori' });
      res.json({ favorite: false });
    });
  }
  db.run('INSERT INTO recipe_favorites (username, recipe_id) VALUES (?, ?) ON CONFLICT(username, recipe_id) DO NOTHING', [req.user.username, recipeId], error =>
    error ? res.status(500).json({ error: 'Impossible d’ajouter le favori' }) : res.json({ favorite: true }));
});

app.post('/api/recipes/:id/view', authMiddleware, async (req, res) => {
  const recipeId = sanitizeRecipeId(req.params.id);
  if (!recipeId || !await fs.pathExists(path.join(RECIPES_DIR, `${recipeId}.cook`))) return res.status(404).json({ error: 'Recette introuvable' });
  db.run(
    `INSERT INTO recipe_views (username, recipe_id) VALUES (?, ?)
     ON CONFLICT(username, recipe_id) DO UPDATE SET viewed_at = CURRENT_TIMESTAMP, view_count = view_count + 1`,
    [req.user.username, recipeId],
    error => error ? res.status(500).json({ error: 'Impossible d’enregistrer la consultation' }) : res.json({ recorded: true })
  );
});

app.post('/api/collections', authMiddleware, (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim().slice(0, 60) : '';
  if (!name) return res.status(400).json({ error: 'Nom de collection requis' });
  db.run('INSERT INTO recipe_collections (username, name) VALUES (?, ?)', [req.user.username, name], function(error) {
    if (error) return res.status(error.code === 'SQLITE_CONSTRAINT' ? 409 : 500).json({ error: error.code === 'SQLITE_CONSTRAINT' ? 'Cette collection existe déjà' : 'Impossible de créer la collection' });
    res.json({ id: this.lastID, name, recipeIds: [] });
  });
});

app.put('/api/collections/:id/recipes', authMiddleware, (req, res) => {
  const collectionId = Number.parseInt(req.params.id, 10);
  const recipeId = sanitizeRecipeId(req.body.recipeId);
  if (!Number.isSafeInteger(collectionId) || collectionId <= 0 || !recipeId) return res.status(400).json({ error: 'Données invalides' });
  db.get('SELECT id FROM recipe_collections WHERE id = ? AND username = ?', [collectionId, req.user.username], (readError, collection) => {
    if (readError) return res.status(500).json({ error: 'Erreur du serveur' });
    if (!collection) return res.status(404).json({ error: 'Collection introuvable' });
    const included = req.body.included !== false;
    const sql = included
      ? 'INSERT INTO recipe_collection_items (collection_id, recipe_id) VALUES (?, ?) ON CONFLICT(collection_id, recipe_id) DO NOTHING'
      : 'DELETE FROM recipe_collection_items WHERE collection_id = ? AND recipe_id = ?';
    db.run(sql, [collectionId, recipeId], error => error
      ? res.status(500).json({ error: 'Impossible de modifier la collection' })
      : res.json({ included }));
  });
});

app.delete('/api/collections/:id', authMiddleware, (req, res) => {
  db.run('DELETE FROM recipe_collections WHERE id = ? AND username = ?', [req.params.id, req.user.username], function(error) {
    if (error) return res.status(500).json({ error: 'Impossible de supprimer la collection' });
    if (!this.changes) return res.status(404).json({ error: 'Collection introuvable' });
    res.json({ message: 'Collection supprimée' });
  });
});

app.get('/api/dashboard', authMiddleware, (req, res) => {
  const username = req.user.username;
  db.get(
    `SELECT
       (SELECT COUNT(*) FROM recipe_favorites WHERE username = ?) AS favoriteCount,
       (SELECT COUNT(*) FROM recipe_collections WHERE username = ?) AS collectionCount,
       (SELECT COUNT(*) FROM shopping_items WHERE username = ? AND checked = 0) AS shoppingCount,
       (SELECT COUNT(*) FROM weekly_menu_items WHERE username = ?) AS menuCount`,
    [username, username, username, username],
    (error, stats) => error ? res.status(500).json({ error: 'Impossible de charger le tableau de bord' }) : res.json(stats)
  );
});

// Menu hebdomadaire propre à chaque utilisateur.
const WEEKLY_MEALS = ['breakfast', 'lunch', 'dinner', 'extra'];

function validateMenuSlot(day, meal) {
  const normalizedDay = Number(day);
  return Number.isInteger(normalizedDay) && normalizedDay >= 0 && normalizedDay <= 6 && WEEKLY_MEALS.includes(meal)
    ? { day: normalizedDay, meal }
    : null;
}

app.get('/api/weekly-menu', authMiddleware, (req, res) => {
  db.all(
    `SELECT id, recipe_id AS recipeId, day, meal, position
       FROM weekly_menu_items WHERE username = ? ORDER BY day ASC, position ASC, id ASC`,
    [req.user.username],
    (error, items) => error
      ? res.status(500).json({ error: 'Erreur lors du chargement du menu' })
      : res.json(items)
  );
});

app.post('/api/weekly-menu', authMiddleware, async (req, res) => {
  const slot = validateMenuSlot(req.body.day, req.body.meal);
  const recipeId = sanitizeRecipeId(req.body.recipeId);
  if (!slot || !recipeId) return res.status(400).json({ error: 'Recette ou créneau invalide' });
  if (!await fs.pathExists(path.join(RECIPES_DIR, recipeId + '.cook'))) {
    return res.status(404).json({ error: 'Recette introuvable' });
  }
  db.run(
    `INSERT INTO weekly_menu_items (username, recipe_id, day, meal, position)
     VALUES (?, ?, ?, ?, COALESCE((SELECT MAX(position) + 1 FROM weekly_menu_items WHERE username = ? AND day = ? AND meal = ?), 0))`,
    [req.user.username, recipeId, slot.day, slot.meal, req.user.username, slot.day, slot.meal],
    function(error) {
      if (error) return res.status(500).json({ error: "Erreur lors de l'ajout au menu" });
      res.status(201).json({ id: this.lastID, recipeId, ...slot });
    }
  );
});

app.put('/api/weekly-menu/:id', authMiddleware, (req, res) => {
  const slot = validateMenuSlot(req.body.day, req.body.meal);
  if (!slot) return res.status(400).json({ error: 'Créneau invalide' });
  db.run(
    'UPDATE weekly_menu_items SET day = ?, meal = ? WHERE id = ? AND username = ?',
    [slot.day, slot.meal, Number(req.params.id), req.user.username],
    function(error) {
      if (error) return res.status(500).json({ error: 'Erreur lors du déplacement' });
      if (!this.changes) return res.status(404).json({ error: 'Élément introuvable' });
      res.json({ id: Number(req.params.id), ...slot });
    }
  );
});

app.delete('/api/weekly-menu/all', authMiddleware, (req, res) => {
  db.run('DELETE FROM weekly_menu_items WHERE username = ?', [req.user.username], function(error) {
    if (error) return res.status(500).json({ error: 'Erreur lors de la suppression du menu' });
    res.json({ deleted: this.changes });
  });
});

app.delete('/api/weekly-menu/:id', authMiddleware, (req, res) => {
  db.run(
    'DELETE FROM weekly_menu_items WHERE id = ? AND username = ?',
    [Number(req.params.id), req.user.username],
    function(error) {
      if (error) return res.status(500).json({ error: 'Erreur lors de la suppression' });
      if (!this.changes) return res.status(404).json({ error: 'Élément introuvable' });
      res.json({ message: 'Recette retirée du menu' });
    }
  );
});

// Liste de courses propre à chaque utilisateur.
app.get('/api/shopping-list', authMiddleware, (req, res) => {
  db.all(
    `SELECT id, name, quantity, unit, checked, created_at AS createdAt
       FROM shopping_items WHERE username = ? ORDER BY checked ASC, id ASC`,
    [req.user.username],
    (error, items) => error
      ? res.status(500).json({ error: 'Erreur lors du chargement de la liste de courses' })
      : res.json(items)
  );
});

app.post('/api/shopping-list', authMiddleware, (req, res) => {
  const item = validateShoppingItem(req.body);
  if (!item) return res.status(400).json({ error: 'Ingrédient, quantité ou unité invalide' });
  db.run(
    `INSERT INTO shopping_items (username, name, normalized_name, quantity, unit)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(username, normalized_name, unit)
     DO UPDATE SET quantity = quantity + excluded.quantity, checked = 0, name = excluded.name`,
    [req.user.username, item.name, item.normalizedName, item.quantity, item.unit],
    error => error
      ? res.status(500).json({ error: "Erreur lors de l'ajout à la liste" })
      : res.status(201).json({ message: 'Ingrédient ajouté à la liste' })
  );
});

app.post('/api/shopping-list/batch', authMiddleware, (req, res) => {
  const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
  if (!rawItems.length || rawItems.length > 100) return res.status(400).json({ error: 'Liste d’ingrédients invalide' });
  const items = rawItems.map(validateShoppingItem);
  if (items.some(item => !item)) return res.status(400).json({ error: 'Un ingrédient contient une quantité ou une unité invalide' });
  db.serialize(() => {
    db.run('BEGIN IMMEDIATE');
    const statement = db.prepare(
      `INSERT INTO shopping_items (username, name, normalized_name, quantity, unit)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(username, normalized_name, unit)
       DO UPDATE SET quantity = quantity + excluded.quantity, checked = 0, name = excluded.name`
    );
    let failed = false;
    items.forEach(item => statement.run(
      req.user.username, item.name, item.normalizedName, item.quantity, item.unit,
      error => { if (error) failed = true; }
    ));
    statement.finalize(error => {
      if (error || failed) {
        return db.run('ROLLBACK', () => res.status(500).json({ error: "Erreur lors de l'ajout des ingrédients" }));
      }
      db.run('COMMIT', commitError => commitError
        ? res.status(500).json({ error: "Erreur lors de l'ajout des ingrédients" })
        : res.status(201).json({ message: `${items.length} ingrédient(s) ajouté(s) à la liste` })
      );
    });
  });
});

app.put('/api/shopping-list/:id', authMiddleware, (req, res) => {
  const checked = req.body.checked ? 1 : 0;
  db.run(
    'UPDATE shopping_items SET checked = ? WHERE id = ? AND username = ?',
    [checked, Number(req.params.id), req.user.username],
    function(error) {
      if (error) return res.status(500).json({ error: 'Erreur lors de la mise à jour' });
      if (!this.changes) return res.status(404).json({ error: 'Ingrédient introuvable' });
      res.json({ id: Number(req.params.id), checked: Boolean(checked) });
    }
  );
});

app.delete('/api/shopping-list/checked', authMiddleware, (req, res) => {
  db.run(
    'DELETE FROM shopping_items WHERE username = ? AND checked = 1',
    [req.user.username],
    function(error) {
      if (error) return res.status(500).json({ error: 'Erreur lors de la suppression' });
      res.json({ deleted: this.changes });
    }
  );
});

app.delete('/api/shopping-list/:id', authMiddleware, (req, res) => {
  db.run(
    'DELETE FROM shopping_items WHERE id = ? AND username = ?',
    [Number(req.params.id), req.user.username],
    function(error) {
      if (error) return res.status(500).json({ error: 'Erreur lors de la suppression' });
      if (!this.changes) return res.status(404).json({ error: 'Ingrédient introuvable' });
      res.json({ message: 'Ingrédient supprimé' });
    }
  );
});

// Sonde de disponibilité utilisée par la supervision.
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Configuration du logo personnalisé.
const LOGO_FILE = path.join(__dirname, 'data', 'logo.json');

// Sert le logo personnalisé, puis se rabat sur le logo livré avec l'application.
app.get('/api/logo', async (req, res) => {
  try {
    if (await fs.pathExists(LOGO_FILE)) {
      const logoData = await fs.readJson(LOGO_FILE);
      res.set('Content-Type', logoData.mime);
      res.set('Cache-Control', 'no-cache');
      res.send(Buffer.from(logoData.data, 'base64'));
    } else {
      const logoPath = path.join(__dirname, 'public', 'logo.png');
      if (await fs.pathExists(logoPath)) {
        res.sendFile(logoPath);
      } else {
        res.status(404).end();
      }
    }
  } catch (err) {
    console.error('Error serving logo:', err);
    try {
      const logoPath = path.join(__dirname, 'public', 'logo.png');
      if (await fs.pathExists(logoPath)) {
        res.sendFile(logoPath);
      } else {
        res.status(404).end();
      }
    } catch {
      res.status(404).end();
    }
  }
});

// Remplace le logo personnalisé (administrateur uniquement).
app.post('/api/logo', authMiddleware, adminMiddleware, async (req, res) => {
  const { image } = req.body;
  const match = image?.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/);
  if (!match) {
    return res.status(400).json({ error: 'Format invalide (png, jpeg, gif, webp)' });
  }
  const [, mime, data] = match;
  try {
    await fs.ensureDir(path.dirname(LOGO_FILE));
    await fs.writeJson(LOGO_FILE, { data, mime });
    res.json({ message: 'Logo mis à jour' });
  } catch (err) {
    console.error('Error saving logo:', err);
    res.status(500).json({ error: 'Erreur lors de la sauvegarde du logo' });
  }
});

// Supprime le logo personnalisé (administrateur uniquement).
app.delete('/api/logo', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (await fs.pathExists(LOGO_FILE)) {
      await fs.remove(LOGO_FILE);
    }
    res.json({ message: 'Logo supprimé' });
  } catch (err) {
    console.error('Error deleting logo:', err);
    res.status(500).json({ error: 'Erreur lors de la suppression du logo' });
  }
});

app.get('/registration-action', (req, res) => {
  try {
    const payload = jwt.verify(req.query.token, JWT_SECRET);
    if (payload.purpose !== 'registration' || !['approve', 'reject'].includes(payload.decision)) throw new Error('invalid');
    res.set('Cache-Control', 'no-store');
    res.type('html').send(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Validation du compte — Goodwater Recipes</title><style>@import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&display=swap');:root{--primary:#bd4a2b;--background:#fff8f3;--card:#fff;--foreground:#25211f;--muted:#746c68}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at top left,#ffe7d8,transparent 42%),radial-gradient(circle at bottom right,#f8ddd3,transparent 42%),var(--background);color:var(--foreground);font-family:Outfit,Arial,sans-serif}.card{width:min(100%,520px);padding:38px 34px;background:var(--card);border:1px solid #ecdcd4;border-radius:24px;box-shadow:0 18px 50px #6f352118;text-align:center}.logo{width:88px;height:88px;object-fit:contain;margin-bottom:12px}.brand{margin:0 0 28px;color:var(--primary);font-size:1.15rem;font-weight:700;letter-spacing:.02em}h1{margin:0 0 12px;font-size:clamp(1.55rem,5vw,2rem)}p{margin:0;color:var(--muted);font-size:1.05rem;line-height:1.6}.status-icon{display:grid;place-items:center;width:64px;height:64px;margin:0 auto 22px;border-radius:50%;background:#f7e8e1;color:var(--primary);font-size:1.8rem;font-weight:700}.card.accepted .status-icon{background:#dcf5e5;color:#16803c}.card.accepted h1{color:#16803c}.card.rejected .status-icon{background:#fde3e3;color:#c62828}.card.rejected h1{color:#c62828}.card.error .status-icon{background:#fff0d6;color:#a86100}.card.error h1{color:#a86100}.spinner{width:26px;height:26px;border:3px solid #e6c9bd;border-top-color:var(--primary);border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style><script src="/registration-action.js?v=20260811-2" defer></script></head><body><main id="result-card" class="card"><img class="logo" src="/api/logo" alt="Goodwater Recipes"><div class="brand">GOODWATER RECIPES</div><div id="status-icon" class="status-icon"><span class="spinner"></span></div><h1 id="result-title">Traitement de la demande…</h1><p id="result-detail">Merci de patienter quelques instants.</p></main></body></html>`);
  } catch {
    res.status(400).type('html').send('<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Lien invalide</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#fff8f3;color:#25211f;font-family:Arial,sans-serif"><main style="max-width:520px;padding:38px;background:#fff;border-radius:24px;box-shadow:0 18px 50px #6f352118;text-align:center"><img src="/api/logo" alt="Goodwater Recipes" style="width:88px"><h1 style="color:#a86100">Lien invalide ou expiré</h1><p>Cette demande ne peut plus être traitée depuis ce lien.</p></main></body></html>');
  }
});

app.post('/api/registration-action', (req, res) => {
  try {
    const payload = jwt.verify(req.body.token, JWT_SECRET);
    if (payload.purpose !== 'registration' || !['approve', 'reject'].includes(payload.decision)) throw new Error('invalid');
    resolveRegistration(payload.pendingId, payload.decision, (error, result) => {
      if (error) return res.status(500).json({ error: 'Erreur lors du traitement' });
      const sendResult = (username, status) => {
        const accepted = status === 'approved';
        res.json({
          status: accepted ? 'accepted' : 'rejected',
          title: accepted ? 'Le compte a bien été accepté' : 'Le compte a bien été refusé',
          detail: accepted ? `Le compte de ${username} est maintenant actif.` : `La demande de ${username} a été refusée.`
        });
      };
      if (result) return sendResult(result.username, payload.decision === 'approve' ? 'approved' : 'rejected');
      db.get('SELECT username, status FROM pending_users WHERE id = ?', [payload.pendingId], (readError, pending) => {
        if (readError) return res.status(500).json({ error: 'Erreur lors du traitement' });
        if (!pending) return res.status(404).json({ error: 'Demande introuvable' });
        if (!['approved', 'rejected'].includes(pending.status)) return res.status(409).json({ error: 'La demande est encore en attente' });
        sendResult(pending.username, pending.status);
      });
    });
  } catch {
    res.status(400).json({ error: 'Lien invalide ou expiré' });
  }
});

function escapeHtmlAttribute(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Fournit aux messageries et réseaux sociaux un aperçu propre des liens partagés.
app.get('/:recipeSlug/:shareCode', async (req, res, next) => {
  if (!/^[a-z0-9-]{1,80}$/.test(req.params.recipeSlug) || !/^[A-Za-z0-9_-]{20}$/.test(req.params.shareCode)) {
    return next();
  }
  try {
    const share = await new Promise((resolve, reject) => db.get(
      'SELECT recipe_id FROM recipe_shares WHERE code = ? AND expires_at > ?',
      [req.params.shareCode, Date.now()],
      (error, row) => error ? reject(error) : resolve(row)
    ));
    if (!share) return next();
    const recipeId = sanitizeRecipeId(share.recipe_id);
    const recipePath = path.join(RECIPES_DIR, `${recipeId}.cook`);
    if (!recipeId || !await fs.pathExists(recipePath)) return next();
    const rawRecipe = await fs.readFile(recipePath, 'utf8');
    const recipe = parseRecipeFile(rawRecipe, recipeId.replace(/_/g, ' '));
    const imageUrl = await getRecipeImage(recipeId);
    const absoluteImageUrl = imageUrl ? `${APP_BASE_URL}${imageUrl}` : `${APP_BASE_URL}/logo.png`;
    const pageUrl = `${APP_BASE_URL}/${encodeURIComponent(req.params.recipeSlug)}/${encodeURIComponent(req.params.shareCode)}`;
    const description = `Découvrez la recette « ${recipe.title} » sur Goodwater Recipes.`;
    const socialMetadata = `
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="Goodwater Recipes">
  <meta property="og:title" content="${escapeHtmlAttribute(recipe.title)}">
  <meta property="og:description" content="${escapeHtmlAttribute(description)}">
  <meta property="og:url" content="${escapeHtmlAttribute(pageUrl)}">
  <meta property="og:image" content="${escapeHtmlAttribute(absoluteImageUrl)}">
  <meta property="og:image:alt" content="Photo de ${escapeHtmlAttribute(recipe.title)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtmlAttribute(recipe.title)}">
  <meta name="twitter:description" content="${escapeHtmlAttribute(description)}">
  <meta name="twitter:image" content="${escapeHtmlAttribute(absoluteImageUrl)}">`;
    const indexHtml = await fs.readFile(path.join(__dirname, 'public', 'index.html'), 'utf8');
    res.set('Cache-Control', 'no-store, max-age=0');
    res.type('html').send(indexHtml
      .replace('<title>Goodwater Recipes - Gestion de recettes</title>', `<title>${escapeHtmlAttribute(recipe.title)} – Goodwater Recipes</title>`)
      .replace('</head>', `${socialMetadata}\n</head>`));
  } catch (error) {
    console.error('Shared recipe preview error:', error.message);
    next();
  }
});

// Une route API inconnue ne doit jamais renvoyer silencieusement l'application HTML.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Route API introuvable' });
});

// Normalise notamment les refus CORS et les erreurs de parsing JSON.
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.message === 'Not allowed by CORS' ? 403 : 400;
  const message = status === 403 ? 'Origine non autorisée' : 'Requête invalide';
  return res.status(status).json({ error: message });
});

// Toutes les routes d'interface sont prises en charge par l'application monopage.
app.get('*', (req, res) => {
  res.set('Cache-Control', 'no-store, max-age=0');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function startServer() {
  registerProcessErrorHandlers();
  await initLogger();
  logger.info('Logger initialized');
  await fs.ensureDir(path.dirname(DB_PATH));
  await fs.ensureDir(RECIPES_DIR);
  await fs.ensureDir(RECIPE_IMAGES_DIR);
  await initDb();

  return app.listen(PORT, '127.0.0.1', () => {
    logger.info(`Goodwater Recipes listening on port ${PORT}`);
  });
}

function closeDatabase() {
  return new Promise((resolve, reject) => {
    if (!db) return resolve();
    db.close(error => error ? reject(error) : resolve());
  });
}

if (require.main === module) {
  startServer().catch(error => {
    console.error('[FATAL] Unable to start Goodwater Recipes:', error);
    process.exit(1);
  });
}

module.exports = {
  app,
  closeDatabase,
  initDb,
  sanitizeFilename,
  sanitizeRecipeId,
  serializeRecipeFile,
  startServer,
  validateRecipePayload,
  validateShoppingItem
};
