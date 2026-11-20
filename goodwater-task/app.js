const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3001;
const DATA_DIR = path.join(__dirname, 'data');
const JWT_SECRET_FILE = path.join(DATA_DIR, '.jwt-secret');
const AUTH_DB_PATH = process.env.AUTH_DB_PATH || path.resolve(__dirname, '../goodwater-recipes/data/db.sqlite');

fs.ensureDirSync(DATA_DIR);
function getJwtSecret() {
  if (typeof process.env.JWT_SECRET === 'string' && process.env.JWT_SECRET.length >= 32) return process.env.JWT_SECRET;
  if (fs.existsSync(JWT_SECRET_FILE)) return fs.readFileSync(JWT_SECRET_FILE, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(JWT_SECRET_FILE, secret, { mode: 0o600 });
  return secret;
}
const JWT_SECRET = getJwtSecret();

app.set('trust proxy', 'loopback');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"]
    }
  }
}));
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: '1h',
  setHeaders(res, filePath) {
    if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'goodwater-task' }));

const LOGO_FILE = path.join(DATA_DIR, 'logo.json');
const TASKS_DB_PATH = path.join(DATA_DIR, 'tasks.db');
let logoAsset = null;
const webauthnPromise = import('@simplewebauthn/server');
const passkeyChallenges = new Map();
const WEBAUTHN_RP_ID = 'goodwater-recipes.fr';
const WEBAUTHN_ORIGIN = 'https://task.goodwater-recipes.fr';

const loginLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 10 });

// Database
const db = new sqlite3.Database(TASKS_DB_PATH);
const authDb = new sqlite3.Database(AUTH_DB_PATH, sqlite3.OPEN_READWRITE, err => {
  if (err) console.error(`Impossible d'ouvrir la base utilisateurs partagée: ${err.message}`);
});

db.serialize(() => {
  db.run('PRAGMA foreign_keys = ON');
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA busy_timeout = 5000');

  db.run(`CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT    NOT NULL,
    title       TEXT    NOT NULL,
    description TEXT    DEFAULT '',
    completed   INTEGER DEFAULT 0,
    position    INTEGER DEFAULT 0,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run("ALTER TABLE tasks ADD COLUMN due_at DATETIME DEFAULT NULL", () => {});
  db.run("ALTER TABLE tasks ADD COLUMN recurrence TEXT DEFAULT 'none'", () => {});
  db.run("ALTER TABLE tasks ADD COLUMN project TEXT DEFAULT ''", () => {});
  db.run("ALTER TABLE tasks ADD COLUMN tags TEXT DEFAULT '[]'", () => {});
  db.run("ALTER TABLE tasks ADD COLUMN priority TEXT DEFAULT 'normal'", () => {});
  db.run("ALTER TABLE tasks ADD COLUMN assigned_to TEXT DEFAULT ''", () => {});

  db.run(`CREATE TABLE IF NOT EXISTS subtasks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    INTEGER NOT NULL,
    title      TEXT    NOT NULL,
    completed  INTEGER DEFAULT 0,
    position   INTEGER DEFAULT 0,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS task_shares (
    task_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (task_id, username),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_tasks_user_position ON tasks(user_id, position, id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to, completed, due_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_subtasks_task_position ON subtasks(task_id, position, id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_task_shares_user ON task_shares(username, task_id)');
});

authDb.run('PRAGMA busy_timeout = 5000');
authDb.serialize(() => {
  authDb.run(`CREATE TABLE IF NOT EXISTS passkeys (
    credential_id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    public_key BLOB NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT DEFAULT '[]',
    device_type TEXT DEFAULT '',
    backed_up INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  authDb.run("ALTER TABLE passkeys ADD COLUMN device_label TEXT DEFAULT ''", () => {});
  authDb.run("ALTER TABLE passkeys ADD COLUMN browser_name TEXT DEFAULT ''", () => {});
  authDb.run("ALTER TABLE passkeys ADD COLUMN user_agent TEXT DEFAULT ''", () => {});
  authDb.run('CREATE INDEX IF NOT EXISTS idx_passkeys_username ON passkeys(username)');
});

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function describeUserAgent(userAgent = '') {
  const ua = cleanText(userAgent, 500);
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

function cleanTags(value) {
  const tags = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return [...new Set(tags.map(tag => cleanText(tag, 30)).filter(Boolean))].slice(0, 10);
}

function cleanTaskMetadata(body) {
  const dueDate = typeof body.dueAt === 'string' && body.dueAt ? new Date(body.dueAt) : null;
  return {
    dueAt: dueDate && !Number.isNaN(dueDate.getTime()) ? dueDate.toISOString() : null,
    recurrence: ['none', 'daily', 'weekly', 'monthly'].includes(body.recurrence) ? body.recurrence : 'none',
    project: cleanText(body.project, 60),
    tags: cleanTags(body.tags),
    priority: ['low', 'normal', 'high'].includes(body.priority) ? body.priority : 'normal',
    assignedTo: cleanText(body.assignedTo, 30)
  };
}

function nextRecurringDate(dueAt, recurrence) {
  const date = dueAt ? new Date(dueAt) : new Date();
  if (recurrence === 'daily') date.setUTCDate(date.getUTCDate() + 1);
  if (recurrence === 'weekly') date.setUTCDate(date.getUTCDate() + 7);
  if (recurrence === 'monthly') date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString();
}

const TASK_ACCESS_SQL = `(t.user_id = ? OR t.assigned_to = ? OR EXISTS (
  SELECT 1 FROM task_shares access_share WHERE access_share.task_id = t.id AND access_share.username = ?
))`;

function createRecurringSuccessor(task, callback) {
  const dueAt = nextRecurringDate(task.due_at, task.recurrence);
  db.run(`INSERT INTO tasks
    (user_id, title, description, completed, position, due_at, recurrence, project, tags, priority, assigned_to)
    VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
    [task.user_id, task.title, task.description, task.position - 0.5, dueAt, task.recurrence,
      task.project, task.tags, task.priority, task.assigned_to],
    function(insertError) {
      if (insertError) return callback(insertError);
      const newTaskId = this.lastID;
      db.run(`INSERT INTO subtasks (task_id, title, completed, position)
        SELECT ?, title, 0, position FROM subtasks WHERE task_id = ?`, [newTaskId, task.id]);
      db.run(`INSERT INTO task_shares (task_id, username)
        SELECT ?, username FROM task_shares WHERE task_id = ?`, [newTaskId, task.id]);
      callback(null, { id: newTaskId, dueAt });
    }
  );
}

function loadLogoAsset() {
  if (!fs.existsSync(LOGO_FILE)) return null;
  const { data, mime } = JSON.parse(fs.readFileSync(LOGO_FILE, 'utf8'));
  if (!/^image\/(?:png|jpeg|gif|webp)$/.test(mime) || typeof data !== 'string') return null;
  return { buffer: Buffer.from(data, 'base64'), mime };
}

function getCookie(req, name) {
  const value = String(req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`));
  return value ? decodeURIComponent(value.slice(name.length + 1)) : '';
}

function setSsoCookie(res, sessionId, maxAge = 86400) {
  res.setHeader('Set-Cookie', `gw_session=${encodeURIComponent(sessionId)}; Domain=.goodwater-recipes.fr; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`);
}

function createSharedSession(req, res, user, callback) {
  const sessionId = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  authDb.run(
    `INSERT INTO sessions (id, username, user_agent, ip, expires_at) VALUES (?, ?, ?, ?, ?)`,
    [sessionId, user.username, String(req.get('user-agent') || '').slice(0, 300), String(req.ip || '').slice(0, 100), expiresAt],
    error => {
      if (error) return callback(error);
      const token = jwt.sign({ username: user.username, role: user.role, sid: sessionId }, JWT_SECRET, { expiresIn: '24h' });
      setSsoCookie(res, sessionId);
      callback(null, token);
    }
  );
}

try { logoAsset = loadLogoAsset(); }
catch (error) { console.error(`Impossible de charger le logo: ${error.message}`); }

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    const sessionId = getCookie(req, 'gw_session');
    if (!sessionId) return res.status(401).json({ error: 'Token requis' });
    return authDb.get(
      `SELECT u.username, u.role, u.blocked_until FROM sessions s
       JOIN users u ON u.username = s.username
       WHERE s.id = ? AND s.revoked_at IS NULL AND datetime(s.expires_at) > datetime('now')`,
      [sessionId],
      (error, user) => {
        if (error) return res.status(500).json({ error: 'Erreur lors de la vérification du compte' });
        if (!user) return res.status(401).json({ error: 'Session expirée' });
        if (user.blocked_until && new Date(user.blocked_until).getTime() > Date.now()) return res.status(403).json({ error: 'Compte temporairement bloqué' });
        req.user = { username: user.username, role: user.role };
        req.sessionId = sessionId;
        authDb.run('UPDATE sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?', [sessionId]);
        next();
      }
    );
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    authDb.get(
      'SELECT username, role, blocked_until FROM users WHERE username = ?',
      [decoded.username],
      (err, user) => {
        if (err) return res.status(500).json({ error: 'Erreur lors de la vérification du compte' });
        if (!user) return res.status(401).json({ error: 'Utilisateur introuvable' });
        if (user.blocked_until && new Date(user.blocked_until).getTime() > Date.now()) {
          return res.status(403).json({ error: 'Compte temporairement bloqué' });
        }
        const acceptToken = () => {
          req.user = { username: user.username, role: user.role };
          req.sessionId = decoded.sid || null;
          next();
        };
        if (!decoded.sid) return acceptToken();
        authDb.get(
          `SELECT id FROM sessions WHERE id = ? AND username = ? AND revoked_at IS NULL
           AND datetime(expires_at) > datetime('now')`,
          [decoded.sid, decoded.username],
          (sessionError, session) => {
            if (sessionError) return res.status(500).json({ error: 'Erreur lors de la vérification de la session' });
            if (!session) return res.status(401).json({ error: 'Session expirée' });
            authDb.run('UPDATE sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?', [decoded.sid]);
            acceptToken();
          }
        );
      }
    );
  }
  catch { res.status(401).json({ error: 'Token invalide' }); }
}

// ── Auth ──────────────────────────────────────────────────────────────────────

app.post('/api/login', loginLimiter, async (req, res) => {
  const username = cleanText(req.body.username, 30);
  const password = typeof req.body.password === 'string' ? req.body.password.slice(0, 128) : '';
  if (!username || !password) return res.status(400).json({ error: 'Identifiants requis' });

  authDb.get(
    'SELECT username, password, role, blocked_until FROM users WHERE username = ?',
    [username],
    async (err, user) => {
      if (err) return res.status(500).json({ error: 'Erreur du serveur' });
      if (!user) return res.status(401).json({ error: 'Identifiants invalides' });
      if (user.blocked_until && new Date(user.blocked_until).getTime() > Date.now()) {
        return res.status(403).json({ error: 'Compte temporairement bloqué' });
      }

      const valid = await bcrypt.compare(password, user.password);
      if (!valid) return res.status(401).json({ error: 'Identifiants invalides' });

      const sessionId = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      authDb.run(
        `INSERT INTO sessions (id, username, user_agent, ip, expires_at) VALUES (?, ?, ?, ?, ?)`,
        [sessionId, user.username, String(req.get('user-agent') || '').slice(0, 300), String(req.ip || '').slice(0, 100), expiresAt],
        sessionError => {
          if (sessionError) return res.status(500).json({ error: 'Erreur lors de la création de la session' });
          const token = jwt.sign({ username: user.username, role: user.role, sid: sessionId }, JWT_SECRET, { expiresIn: '24h' });
          setSsoCookie(res, sessionId);
          res.json({ token, username: user.username, role: user.role });
        }
      );
    }
  );
});

app.post('/api/validate-token', authMiddleware, (req, res) => {
  res.json({ username: req.user.username, role: req.user.role, valid: true });
});

app.post('/api/logout', authMiddleware, (req, res) => {
  const finish = () => {
    setSsoCookie(res, '', 0);
    res.json({ message: 'Déconnexion effectuée' });
  };
  if (!req.sessionId) return finish();
  authDb.run('UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?', [req.sessionId], () => finish());
});

app.post('/api/passkeys/register/options', authMiddleware, async (req, res) => {
  try {
    const { generateRegistrationOptions } = await webauthnPromise;
    authDb.all('SELECT credential_id, transports FROM passkeys WHERE username = ?', [req.user.username], async (error, passkeys) => {
      if (error) return res.status(500).json({ error: 'Erreur lors du chargement des passkeys' });
      const options = await generateRegistrationOptions({
        rpName: 'Goodwater',
        rpID: WEBAUTHN_RP_ID,
        userName: req.user.username,
        userDisplayName: req.user.username,
        userID: crypto.createHash('sha256').update(req.user.username).digest(),
        attestationType: 'none',
        excludeCredentials: passkeys.map(passkey => ({
          id: passkey.credential_id,
          transports: JSON.parse(passkey.transports || '[]')
        })),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' }
      });
      passkeyChallenges.set(`register:${req.user.username}`, { challenge: options.challenge, expires: Date.now() + 5 * 60 * 1000 });
      res.json(options);
    });
  } catch (error) {
    console.error('Passkey registration options:', error);
    res.status(500).json({ error: 'Impossible de préparer la passkey' });
  }
});

app.post('/api/passkeys/register/verify', authMiddleware, async (req, res) => {
  const pending = passkeyChallenges.get(`register:${req.user.username}`);
  if (!pending || pending.expires < Date.now()) return res.status(400).json({ error: 'Demande de passkey expirée' });
  try {
    const { verifyRegistrationResponse } = await webauthnPromise;
    const verification = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge: pending.challenge,
      expectedOrigin: WEBAUTHN_ORIGIN,
      expectedRPID: WEBAUTHN_RP_ID
    });
    if (!verification.verified) return res.status(400).json({ error: 'Passkey non vérifiée' });
    const info = verification.registrationInfo;
    const credential = info.credential;
    const device = describeUserAgent(req.get('user-agent'));
    authDb.run(
      `INSERT INTO passkeys (credential_id, username, public_key, counter, transports, device_type, backed_up, device_label, browser_name, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [credential.id, req.user.username, Buffer.from(credential.publicKey), credential.counter,
        JSON.stringify(credential.transports || req.body.response?.transports || []), info.credentialDeviceType, info.credentialBackedUp ? 1 : 0,
        device.deviceLabel, device.browserName, device.userAgent],
      insertError => {
        if (insertError) return res.status(insertError.code === 'SQLITE_CONSTRAINT' ? 409 : 500).json({ error: 'Cette passkey est déjà enregistrée' });
        passkeyChallenges.delete(`register:${req.user.username}`);
        res.json({ verified: true });
      }
    );
  } catch (error) {
    console.error('Passkey registration verification:', error);
    res.status(400).json({ error: 'Passkey invalide' });
  }
});

app.get('/api/passkeys', authMiddleware, (req, res) => {
  authDb.all(
    `SELECT rowid AS id, device_type AS deviceType, backed_up AS backedUp, created_at AS createdAt,
            device_label AS deviceLabel, browser_name AS browserName
     FROM passkeys WHERE username = ? ORDER BY created_at DESC, rowid DESC`,
    [req.user.username],
    (error, rows) => {
      if (error) return res.status(500).json({ error: 'Impossible de charger les connexions biométriques' });
      res.json(rows.map(row => ({ ...row, backedUp: Boolean(row.backedUp) })));
    }
  );
});

app.delete('/api/passkeys/:id', authMiddleware, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Connexion biométrique invalide' });
  authDb.run('DELETE FROM passkeys WHERE rowid = ? AND username = ?', [id, req.user.username], function(error) {
    if (error) return res.status(500).json({ error: 'Impossible de supprimer la connexion biométrique' });
    if (!this.changes) return res.status(404).json({ error: 'Connexion biométrique introuvable' });
    res.json({ message: 'Connexion biométrique supprimée' });
  });
});

app.post('/api/passkeys/login/options', async (req, res) => {
  const username = cleanText(req.body.username, 30);
  if (!username) return res.status(400).json({ error: "Nom d'utilisateur requis" });
  try {
    const { generateAuthenticationOptions } = await webauthnPromise;
    authDb.all('SELECT credential_id, transports FROM passkeys WHERE username = ?', [username], async (error, passkeys) => {
      if (error) return res.status(500).json({ error: 'Erreur du serveur' });
      if (!passkeys.length) return res.status(404).json({ error: 'Aucune passkey enregistrée pour ce compte' });
      const options = await generateAuthenticationOptions({
        rpID: WEBAUTHN_RP_ID,
        userVerification: 'preferred',
        allowCredentials: passkeys.map(passkey => ({ id: passkey.credential_id, transports: JSON.parse(passkey.transports || '[]') }))
      });
      passkeyChallenges.set(`login:${username}`, { challenge: options.challenge, expires: Date.now() + 5 * 60 * 1000 });
      res.json(options);
    });
  } catch { res.status(500).json({ error: 'Impossible de préparer la connexion' }); }
});

app.post('/api/passkeys/login/verify', async (req, res) => {
  const username = cleanText(req.body.username, 30);
  const response = req.body.response;
  const pending = passkeyChallenges.get(`login:${username}`);
  if (!pending || pending.expires < Date.now() || !response?.id) return res.status(400).json({ error: 'Demande de connexion expirée' });
  authDb.get(
    `SELECT p.*, u.role, u.blocked_until FROM passkeys p JOIN users u ON u.username = p.username
     WHERE p.credential_id = ? AND p.username = ?`,
    [response.id, username],
    async (error, passkey) => {
      if (error) return res.status(500).json({ error: 'Erreur du serveur' });
      if (!passkey) return res.status(401).json({ error: 'Passkey inconnue' });
      if (passkey.blocked_until && new Date(passkey.blocked_until).getTime() > Date.now()) return res.status(403).json({ error: 'Compte temporairement bloqué' });
      try {
        const { verifyAuthenticationResponse } = await webauthnPromise;
        const verification = await verifyAuthenticationResponse({
          response,
          expectedChallenge: pending.challenge,
          expectedOrigin: WEBAUTHN_ORIGIN,
          expectedRPID: WEBAUTHN_RP_ID,
          credential: {
            id: passkey.credential_id,
            publicKey: new Uint8Array(passkey.public_key),
            counter: passkey.counter,
            transports: JSON.parse(passkey.transports || '[]')
          }
        });
        if (!verification.verified) return res.status(401).json({ error: 'Passkey non vérifiée' });
        const device = describeUserAgent(req.get('user-agent'));
        authDb.run(
          `UPDATE passkeys
           SET counter = ?, device_label = ?, browser_name = ?, user_agent = ?
           WHERE credential_id = ?`,
          [verification.authenticationInfo.newCounter, device.deviceLabel, device.browserName, device.userAgent, passkey.credential_id]
        );
        passkeyChallenges.delete(`login:${username}`);
        createSharedSession(req, res, { username, role: passkey.role }, (sessionError, token) => {
          if (sessionError) return res.status(500).json({ error: 'Erreur lors de la création de la session' });
          res.json({ token, username, role: passkey.role });
        });
      } catch (verificationError) {
        console.error('Passkey authentication:', verificationError);
        res.status(401).json({ error: 'Passkey invalide' });
      }
    }
  );
});

app.get('/api/profile', authMiddleware, (req, res) => {
  authDb.get(
    `SELECT username, role, first_name AS firstName, last_name AS lastName, description
     FROM users WHERE username = ?`,
    [req.user.username],
    (err, profile) => {
      if (err) return res.status(500).json({ error: 'Erreur lors du chargement du profil' });
      if (!profile) return res.status(404).json({ error: 'Utilisateur non trouvé' });
      res.json(profile);
    }
  );
});

app.put('/api/profile', authMiddleware, (req, res) => {
  const firstName = typeof req.body.firstName === 'string' ? req.body.firstName.trim().slice(0, 60) : '';
  const lastName = typeof req.body.lastName === 'string' ? req.body.lastName.trim().slice(0, 60) : '';
  const description = typeof req.body.description === 'string' ? req.body.description.trim().slice(0, 500) : '';
  authDb.run(
    'UPDATE users SET first_name = ?, last_name = ?, description = ? WHERE username = ?',
    [firstName, lastName, description, req.user.username],
    function(err) {
      if (err) return res.status(500).json({ error: 'Erreur lors de la mise à jour du profil' });
      if (!this.changes) return res.status(404).json({ error: 'Utilisateur non trouvé' });
      res.json({ username: req.user.username, role: req.user.role, firstName, lastName, description });
    }
  );
});

app.get('/api/users', authMiddleware, (req, res) => {
  authDb.all(
    `SELECT username, first_name AS firstName, last_name AS lastName
     FROM users WHERE username <> ? ORDER BY username`,
    [req.user.username],
    (error, users) => {
      if (error) return res.status(500).json({ error: 'Erreur lors du chargement des utilisateurs' });
      res.json(users);
    }
  );
});

// ── Tasks ─────────────────────────────────────────────────────────────────────

app.get('/api/tasks', authMiddleware, (req, res) => {
  const uid = req.user.username;
  db.all(`SELECT t.* FROM tasks t WHERE ${TASK_ACCESS_SQL} ORDER BY t.position ASC, t.id DESC`, [uid, uid, uid], (err, tasks) => {
    if (err) return res.status(500).json({ error: 'Erreur DB' });
    if (!tasks.length) return res.json([]);

    const ids = tasks.map(t => t.id);
    const placeholders = ids.map(() => '?').join(',');
    db.all(`SELECT * FROM subtasks WHERE task_id IN (${placeholders}) ORDER BY position ASC, id ASC`, ids, (err2, subs) => {
      if (err2) return res.status(500).json({ error: 'Erreur DB' });
      const subMap = {};
      for (const s of subs) {
        if (!subMap[s.task_id]) subMap[s.task_id] = [];
        subMap[s.task_id].push(s);
      }
      db.all(`SELECT task_id, username FROM task_shares WHERE task_id IN (${placeholders}) ORDER BY username`, ids, (shareError, shares) => {
        if (shareError) return res.status(500).json({ error: 'Erreur DB' });
        const shareMap = {};
        for (const share of shares) {
          if (!shareMap[share.task_id]) shareMap[share.task_id] = [];
          shareMap[share.task_id].push(share.username);
        }
        res.json(tasks.map(task => {
          let tags = [];
          try { tags = JSON.parse(task.tags || '[]'); } catch {}
          return {
            ...task,
            tags,
            assignedTo: task.assigned_to || '',
            dueAt: task.due_at,
            sharedWith: shareMap[task.id] || [],
            canManage: task.user_id === uid,
            subtasks: subMap[task.id] || []
          };
        }));
      });
    });
  });
});

app.post('/api/tasks', authMiddleware, (req, res) => {
  const uid = req.user.username;
  const title = cleanText(req.body.title, 200);
  const description = cleanText(req.body.description, 5000);
  const metadata = cleanTaskMetadata(req.body);
  if (!title) return res.status(400).json({ error: 'Titre requis' });

  const createTask = () => db.get('SELECT COALESCE(MIN(position), 0) - 1 AS position FROM tasks WHERE user_id = ?', [uid], (positionError, row) => {
    if (positionError) return res.status(500).json({ error: 'Erreur DB' });
    const position = row.position;
    db.run(`INSERT INTO tasks
      (user_id, title, description, position, due_at, recurrence, project, tags, priority, assigned_to)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uid, title, description, position, metadata.dueAt, metadata.recurrence, metadata.project,
        JSON.stringify(metadata.tags), metadata.priority, metadata.assignedTo],
      function(err) {
        if (err) return res.status(500).json({ error: 'Erreur DB' });
        res.json({
          id: this.lastID, user_id: uid, title, description, completed: 0, position,
          due_at: metadata.dueAt, dueAt: metadata.dueAt, recurrence: metadata.recurrence,
          project: metadata.project, tags: metadata.tags, priority: metadata.priority,
          assigned_to: metadata.assignedTo, assignedTo: metadata.assignedTo,
          sharedWith: [], canManage: true, subtasks: []
        });
      }
    );
  });

  if (!metadata.assignedTo) return createTask();
  authDb.get('SELECT username FROM users WHERE username = ?', [metadata.assignedTo], (userError, user) => {
    if (userError) return res.status(500).json({ error: 'Erreur du serveur' });
    if (!user) return res.status(400).json({ error: 'Utilisateur assigné introuvable' });
    createTask();
  });
});

app.put('/api/tasks/reorder', authMiddleware, (req, res) => {
  const uid = req.user.username;
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : [];
  if (!ids.length || ids.some(id => !Number.isInteger(id) || id <= 0) || new Set(ids).size !== ids.length) {
    return res.status(400).json({ error: 'Ordre des tâches invalide' });
  }

  db.all('SELECT id FROM tasks WHERE user_id = ?', [uid], (readError, rows) => {
    if (readError) return res.status(500).json({ error: 'Erreur DB' });
    const ownedIds = new Set(rows.map(row => row.id));
    if (ids.length !== ownedIds.size || ids.some(id => !ownedIds.has(id))) {
      return res.status(400).json({ error: 'La liste des tâches est incomplète' });
    }

    db.serialize(() => {
      db.run('BEGIN IMMEDIATE');
      const statement = db.prepare('UPDATE tasks SET position = ? WHERE id = ? AND user_id = ?');
      ids.forEach((id, position) => statement.run(position, id, uid));
      statement.finalize(finalizeError => {
        if (finalizeError) {
          return db.run('ROLLBACK', () => res.status(500).json({ error: 'Erreur lors du réordonnancement' }));
        }
        db.run('COMMIT', commitError => {
          if (commitError) return res.status(500).json({ error: 'Erreur lors du réordonnancement' });
          res.json({ message: 'Ordre enregistré' });
        });
      });
    });
  });
});

app.put('/api/tasks/:id/share', authMiddleware, (req, res) => {
  const uid = req.user.username;
  const usernames = [...new Set((Array.isArray(req.body.usernames) ? req.body.usernames : [])
    .map(username => cleanText(username, 30)).filter(username => username && username !== uid))].slice(0, 20);

  db.get('SELECT id FROM tasks WHERE id = ? AND user_id = ?', [req.params.id, uid], (taskError, task) => {
    if (taskError) return res.status(500).json({ error: 'Erreur DB' });
    if (!task) return res.status(403).json({ error: 'Seul le propriétaire peut partager cette tâche' });

    const saveShares = () => db.serialize(() => {
      db.run('BEGIN IMMEDIATE');
      db.run('DELETE FROM task_shares WHERE task_id = ?', [req.params.id], deleteError => {
        if (deleteError) return db.run('ROLLBACK', () => res.status(500).json({ error: 'Erreur de partage' }));
        const statement = db.prepare('INSERT INTO task_shares (task_id, username) VALUES (?, ?)');
        usernames.forEach(username => statement.run(req.params.id, username));
        statement.finalize(finalizeError => {
          if (finalizeError) return db.run('ROLLBACK', () => res.status(500).json({ error: 'Erreur de partage' }));
          db.run('COMMIT', commitError => {
            if (commitError) return res.status(500).json({ error: 'Erreur de partage' });
            res.json({ sharedWith: usernames });
          });
        });
      });
    });

    if (!usernames.length) return saveShares();
    const placeholders = usernames.map(() => '?').join(',');
    authDb.all(`SELECT username FROM users WHERE username IN (${placeholders})`, usernames, (userError, users) => {
      if (userError) return res.status(500).json({ error: 'Erreur du serveur' });
      if (users.length !== usernames.length) return res.status(400).json({ error: 'Un utilisateur est introuvable' });
      saveShares();
    });
  });
});

app.put('/api/tasks/:id', authMiddleware, (req, res) => {
  const uid = req.user.username;
  const { title, description, completed } = req.body;

  db.get(`SELECT t.* FROM tasks t WHERE t.id = ? AND ${TASK_ACCESS_SQL}`, [req.params.id, uid, uid, uid], (err, row) => {
    if (err) return res.status(500).json({ error: 'Erreur DB' });
    if (!row) return res.status(404).json({ error: 'Tâche introuvable' });

    const cols = [], vals = [];
    if (title !== undefined) {
      const cleanTitle = cleanText(title, 200);
      if (!cleanTitle) return res.status(400).json({ error: 'Titre requis' });
      cols.push('title = ?'); vals.push(cleanTitle);
    }
    if (description !== undefined) { cols.push('description = ?'); vals.push(cleanText(description, 5000)); }
    if (completed !== undefined)   { cols.push('completed = ?');   vals.push(completed ? 1 : 0); }

    const metadataFields = ['dueAt', 'recurrence', 'project', 'tags', 'priority', 'assignedTo'];
    const updatesMetadata = metadataFields.some(field => Object.prototype.hasOwnProperty.call(req.body, field));
    if (updatesMetadata && row.user_id !== uid) {
      return res.status(403).json({ error: 'Seul le propriétaire peut modifier ces informations' });
    }
    if (updatesMetadata) {
      const metadata = cleanTaskMetadata({
        dueAt: req.body.dueAt !== undefined ? req.body.dueAt : row.due_at,
        recurrence: req.body.recurrence !== undefined ? req.body.recurrence : row.recurrence,
        project: req.body.project !== undefined ? req.body.project : row.project,
        tags: req.body.tags !== undefined ? req.body.tags : (() => { try { return JSON.parse(row.tags || '[]'); } catch { return []; } })(),
        priority: req.body.priority !== undefined ? req.body.priority : row.priority,
        assignedTo: req.body.assignedTo !== undefined ? req.body.assignedTo : row.assigned_to
      });
      cols.push('due_at = ?', 'recurrence = ?', 'project = ?', 'tags = ?', 'priority = ?', 'assigned_to = ?');
      vals.push(metadata.dueAt, metadata.recurrence, metadata.project, JSON.stringify(metadata.tags), metadata.priority, metadata.assignedTo);
    }
    if (!cols.length) return res.json({ message: 'Rien à mettre à jour' });

    const performUpdate = () => {
      vals.push(req.params.id);
      db.run(`UPDATE tasks SET ${cols.join(', ')} WHERE id = ?`, vals, updateError => {
        if (updateError) return res.status(500).json({ error: 'Erreur DB' });
        const requestedRecurrence = req.body.recurrence !== undefined ? req.body.recurrence : row.recurrence;
        const shouldRecur = completed === true && !row.completed && requestedRecurrence && requestedRecurrence !== 'none';
        if (!shouldRecur) return res.json({ message: 'Tâche mise à jour' });
        db.get('SELECT * FROM tasks WHERE id = ?', [req.params.id], (refreshError, updatedTask) => {
          if (refreshError || !updatedTask) return res.status(500).json({ error: 'Tâche mise à jour, mais récurrence non créée' });
          createRecurringSuccessor(updatedTask, (recurrenceError, nextTask) => {
            if (recurrenceError) return res.status(500).json({ error: 'Tâche terminée, mais récurrence non créée' });
            res.json({ message: 'Tâche mise à jour', nextTask });
          });
        });
      });
    };

    const assignedTo = req.body.assignedTo !== undefined ? cleanText(req.body.assignedTo, 30) : '';
    if (!assignedTo) return performUpdate();
    authDb.get('SELECT username FROM users WHERE username = ?', [assignedTo], (userError, user) => {
      if (userError) return res.status(500).json({ error: 'Erreur du serveur' });
      if (!user) return res.status(400).json({ error: 'Utilisateur assigné introuvable' });
      performUpdate();
    });
  });
});

app.delete('/api/tasks/:id', authMiddleware, (req, res) => {
  const uid = req.user.username;
  db.run('DELETE FROM tasks WHERE id = ? AND user_id = ?', [req.params.id, uid], function(err) {
    if (err) return res.status(500).json({ error: 'Erreur DB' });
    if (!this.changes) return res.status(404).json({ error: 'Tâche introuvable' });
    res.json({ message: 'Tâche supprimée' });
  });
});

// ── Subtasks ──────────────────────────────────────────────────────────────────

app.post('/api/tasks/:id/subtasks', authMiddleware, (req, res) => {
  const uid = req.user.username;
  const title = cleanText(req.body.title, 200);
  if (!title) return res.status(400).json({ error: 'Titre requis' });

  db.get(`SELECT t.id FROM tasks t WHERE t.id = ? AND ${TASK_ACCESS_SQL}`, [req.params.id, uid, uid, uid], (err, row) => {
    if (err) return res.status(500).json({ error: 'Erreur DB' });
    if (!row) return res.status(404).json({ error: 'Tâche introuvable' });
    db.run('INSERT INTO subtasks (task_id, title) VALUES (?, ?)', [req.params.id, title], function(err2) {
      if (err2) return res.status(500).json({ error: 'Erreur DB' });
      res.json({ id: this.lastID, task_id: parseInt(req.params.id), title, completed: 0 });
    });
  });
});

app.put('/api/tasks/:id/subtasks/:sid', authMiddleware, (req, res) => {
  const uid = req.user.username;
  const { title, completed } = req.body;

  db.get(
    `SELECT s.id FROM subtasks s JOIN tasks t ON t.id = s.task_id
     WHERE s.id = ? AND ${TASK_ACCESS_SQL}`,
    [req.params.sid, uid, uid, uid], (err, row) => {
      if (err) return res.status(500).json({ error: 'Erreur DB' });
      if (!row) return res.status(404).json({ error: 'Sous-tâche introuvable' });

      const cols = [], vals = [];
      if (title !== undefined) {
        const cleanTitle = cleanText(title, 200);
        if (!cleanTitle) return res.status(400).json({ error: 'Titre requis' });
        cols.push('title = ?'); vals.push(cleanTitle);
      }
      if (completed !== undefined) { cols.push('completed = ?'); vals.push(completed ? 1 : 0); }
      if (!cols.length) return res.json({ message: 'Rien à mettre à jour' });
      vals.push(req.params.sid);

      db.run(`UPDATE subtasks SET ${cols.join(', ')} WHERE id = ?`, vals, err2 => {
        if (err2) return res.status(500).json({ error: 'Erreur DB' });
        res.json({ message: 'Sous-tâche mise à jour' });
      });
    }
  );
});

app.delete('/api/tasks/:id/subtasks/:sid', authMiddleware, (req, res) => {
  const uid = req.user.username;
  db.get(
    `SELECT s.id FROM subtasks s JOIN tasks t ON t.id = s.task_id
     WHERE s.id = ? AND ${TASK_ACCESS_SQL}`,
    [req.params.sid, uid, uid, uid], (err, row) => {
      if (err) return res.status(500).json({ error: 'Erreur DB' });
      if (!row) return res.status(404).json({ error: 'Sous-tâche introuvable' });
      db.run('DELETE FROM subtasks WHERE id = ?', [req.params.sid], err2 => {
        if (err2) return res.status(500).json({ error: 'Erreur DB' });
        res.json({ message: 'Sous-tâche supprimée' });
      });
    }
  );
});

// ── Profile ───────────────────────────────────────────────────────────────────

app.put('/api/profile/password', authMiddleware, async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  const username = req.user.username;

  if (!currentPassword || !newPassword)
    return res.status(400).json({ error: 'Tous les champs sont requis' });
  if (newPassword !== confirmPassword)
    return res.status(400).json({ error: 'Les mots de passe ne correspondent pas' });
  if (newPassword.length < 8)
    return res.status(400).json({ error: 'Le mot de passe doit faire au moins 8 caractères' });

  authDb.get('SELECT password FROM users WHERE username = ?', [username], async (err, user) => {
    if (err) return res.status(500).json({ error: 'Erreur du serveur' });
    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });

    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) return res.status(401).json({ error: 'Mot de passe actuel incorrect' });

    const hashedPassword = await bcrypt.hash(newPassword, 12);
    authDb.run('UPDATE users SET password = ? WHERE username = ?', [hashedPassword, username], updateError => {
      if (updateError) return res.status(500).json({ error: 'Erreur du serveur' });
      res.json({ message: 'Mot de passe modifié avec succès sur tous les services' });
    });
  });
});

// ── Logo ──────────────────────────────────────────────────────────────────────

app.get('/api/logo', (req, res) => {
  if (!logoAsset) return res.status(404).end();
  res.set('Content-Type', logoAsset.mime);
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(logoAsset.buffer);
});

app.post('/api/logo', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin requis' });
  const { image } = req.body;
  const match = image?.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/);
  if (!match) return res.status(400).json({ error: 'Format invalide (png, jpeg, gif, webp)' });
  const [, mime, data] = match;
  const buffer = Buffer.from(data, 'base64');
  if (!buffer.length || buffer.length > 3 * 1024 * 1024) {
    return res.status(400).json({ error: 'Le logo ne doit pas dépasser 3 Mo' });
  }
  try {
    const temporaryFile = `${LOGO_FILE}.tmp`;
    await fs.writeFile(temporaryFile, JSON.stringify({ data, mime }));
    await fs.rename(temporaryFile, LOGO_FILE);
    logoAsset = { buffer, mime };
    res.json({ message: 'Logo mis à jour' });
  } catch { res.status(500).json({ error: 'Erreur sauvegarde' }); }
});

app.delete('/api/logo', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin requis' });
  try {
    await fs.remove(LOGO_FILE);
    logoAsset = null;
    res.json({ message: 'Logo supprimé' });
  } catch { res.status(500).json({ error: 'Erreur suppression' }); }
});

const server = app.listen(PORT, '127.0.0.1', () => console.log(`Goodwater Task on port ${PORT}`));

function shutdown(signal) {
  console.log(`${signal}: arrêt de Goodwater Task`);
  server.close(() => {
    db.close(() => authDb.close(() => process.exit(0)));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
