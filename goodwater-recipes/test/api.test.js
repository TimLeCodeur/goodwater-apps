// Tests d'intégration de l'API Goodwater Recipes.
const { expect } = require('chai');
const request = require('supertest');
const fs = require('fs-extra');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'test-db.sqlite');
const TEST_RECIPES_DIR = path.join(__dirname, 'test-recipes');
process.env.JWT_SECRET = 'test-secret-key-for-testing-only';
process.env.ADMIN_PASSWORD = 'testAdmin123';
process.env.NODE_ENV = 'test';
process.env.DB_PATH = TEST_DB_PATH;
process.env.RECIPES_DIR = TEST_RECIPES_DIR;

const {
  app,
  closeDatabase,
  initDb,
  sanitizeFilename,
  sanitizeRecipeId,
  serializeRecipeFile,
  validateShoppingItem
} = require('../app');

describe('Goodwater Recipes API', function() {
  this.timeout(10000);
  let adminToken;

  before(async function() {
    await fs.remove(TEST_DB_PATH);
    await fs.remove(TEST_RECIPES_DIR);
    await fs.ensureDir(TEST_RECIPES_DIR);
    await fs.writeFile(
      path.join(TEST_RECIPES_DIR, 'test_recipe.cook'),
      'Pommes découpées\n@pomme{2}\n1. Couper les pommes.',
      'utf-8'
    );
    await initDb();
  });

  after(async function() {
    await closeDatabase();
    await fs.remove(TEST_DB_PATH);
    await fs.remove(TEST_RECIPES_DIR);
  });
  
  describe('Health Check', function() {
    it('should return health status OK', async function() {
      const response = await request(app)
        .get('/api/health')
        .expect(200);
      
      expect(response.body).to.have.property('status', 'OK');
      expect(response.body).to.have.property('timestamp');
    });
  });
  
  describe('Authentication', function() {
    describe('POST /api/login', function() {
      it('should reject login with missing credentials', async function() {
        const response = await request(app)
          .post('/api/login')
          .send({})
          .expect(400);
        
        expect(response.body).to.have.property('error');
      });
      
      it('should reject login with invalid credentials', async function() {
        const response = await request(app)
          .post('/api/login')
          .send({ username: 'nonexistent', password: 'wrongpassword' })
          .expect(401);
        
        expect(response.body).to.have.property('error', 'Identifiants invalides');
      });

      it('should create an authenticated admin session', async function() {
        const response = await request(app)
          .post('/api/login')
          .send({ username: 'admin', password: 'testAdmin123' })
          .expect(200);

        expect(response.body).to.include({ username: 'admin', role: 'admin' });
        expect(response.body.token).to.be.a('string').and.not.empty;
        adminToken = response.body.token;
      });
    });
    
    describe('POST /api/register', function() {
      it('should reject registration with missing fields', async function() {
        const response = await request(app)
          .post('/api/register')
          .send({})
          .expect(400);
        
        expect(response.body).to.have.property('error');
      });
      
      it('should reject registration with short password', async function() {
        const response = await request(app)
          .post('/api/register')
          .send({ username: 'testuser', password: 'short' })
          .expect(400);
        
        expect(response.body).to.have.property('error');
      });
      
      it('should reject registration with invalid username', async function() {
        const response = await request(app)
          .post('/api/register')
          .send({ username: 'invalid user!', password: 'validpass123' })
          .expect(400);
        
        expect(response.body).to.have.property('error');
      });

      it('should reject a non-string password', async function() {
        const response = await request(app)
          .post('/api/register')
          .send({ username: 'testuser', password: 12345678 })
          .expect(400);

        expect(response.body).to.have.property('error');
      });
    });
  });
  
  describe('Recipe API', function() {
    describe('GET /api/recipes', function() {
      it('should require authentication', async function() {
        const response = await request(app)
          .get('/api/recipes')
          .expect(401);
        
        expect(response.body).to.have.property('error', 'Jeton d’accès requis');
      });

      it('should return recipes to an authenticated user', async function() {
        const response = await request(app)
          .get('/api/recipes')
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);

        expect(response.body).to.be.an('array').with.length(1);
        expect(response.body[0]).to.include({ id: 'test_recipe', title: 'Pommes découpées' });
      });
    });
    
    describe('POST /api/recipes', function() {
      it('should reject creation without authentication', async function() {
        const response = await request(app)
          .post('/api/recipes')
          .send({ title: 'Test', content: 'Test content' })
          .expect(401);
        
        expect(response.body).to.have.property('error', 'Jeton d’accès requis');
      });
    });
  });

  describe('Unknown API route', function() {
    it('should return a JSON 404 response', async function() {
      const response = await request(app).get('/api/does-not-exist').expect(404);
      expect(response.body).to.deep.equal({ error: 'Route API introuvable' });
    });
  });
});

describe('Utility Functions', function() {
  describe('sanitizeFilename', function() {
    it('should sanitize special characters', function() {
      expect(sanitizeFilename('Crème brûlée 123 !')).to.equal('creme_brulee_123');
    });

    it('should reject unsafe characters in an existing id', function() {
      expect(sanitizeRecipeId('../../Ma recette.cook')).to.equal('marecettecook');
    });
  });

  describe('serializeRecipeFile', function() {
    it('should not duplicate the recipe title', function() {
      expect(serializeRecipeFile('Soupe', 'Soupe\n@eau{1%l}')).to.equal('Soupe\n@eau{1%l}\n');
    });
  });

  describe('validateShoppingItem', function() {
    it('should normalize a valid item', function() {
      expect(validateShoppingItem({ name: ' Crème ', quantity: '2', unit: ' POT ' })).to.deep.equal({
        name: 'Crème', normalizedName: 'creme', quantity: 2, unit: 'pot'
      });
    });

    it('should reject invalid quantities', function() {
      expect(validateShoppingItem({ name: 'Farine', quantity: 0, unit: 'g' })).to.equal(null);
    });
  });
});
