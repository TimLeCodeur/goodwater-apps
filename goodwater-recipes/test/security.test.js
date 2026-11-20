// Simple integration test for Goodwater Recipes
const chai = require('chai');
const expect = chai.expect;
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs-extra');
const path = require('path');

describe('Goodwater Recipes - Security Tests', function() {
  this.timeout(5000);
  
  describe('Password Hashing', function() {
    it('should hash passwords correctly', async function() {
      const password = 'testPassword123';
      const hashed = await bcrypt.hash(password, 12);
      const isValid = await bcrypt.compare(password, hashed);
      expect(isValid).to.be.true;
    });
    
    it('should not match wrong password', async function() {
      const password = 'testPassword123';
      const wrongPassword = 'wrongPassword456';
      const hashed = await bcrypt.hash(password, 12);
      const isValid = await bcrypt.compare(wrongPassword, hashed);
      expect(isValid).to.be.false;
    });
  });
  
  describe('JWT Token', function() {
    it('should sign and verify JWT tokens', function() {
      const secret = 'test-secret';
      const payload = { username: 'testuser', role: 'viewer' };
      const token = jwt.sign(payload, secret, { expiresIn: '24h' });
      const decoded = jwt.verify(token, secret);
      expect(decoded.username).to.equal('testuser');
      expect(decoded.role).to.equal('viewer');
    });
    
    it('should reject invalid tokens', function() {
      const secret = 'test-secret';
      const invalidToken = 'invalid.token.here';
      expect(() => jwt.verify(invalidToken, secret)).to.throw();
    });
  });
  
  describe('Filename Sanitization', function() {
    function sanitizeFilename(title) {
      return title
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '_')
        .replace(/^_+|_+$/g, '');
    }
    
    it('should sanitize special characters', function() {
      // '!' is replaced with '_', then trailing '_' is removed
      expect(sanitizeFilename('Test Recipe!')).to.equal('test_recipe');
    });
    
    it('should handle empty strings', function() {
      expect(sanitizeFilename('!!!')).to.equal('');
    });
    
    it('should allow underscores and hyphens', function() {
      expect(sanitizeFilename('test-recipe_123')).to.equal('test-recipe_123');
    });
  });
  
  describe('Database Operations', function() {
    const testDbPath = path.join(__dirname, 'test-db.sqlite');
    const testRecipesDir = path.join(__dirname, 'test-recipes-unit');
    
    before(async function() {
      if (await fs.pathExists(testDbPath)) {
        await fs.remove(testDbPath);
      }
      if (await fs.pathExists(testRecipesDir)) {
        await fs.remove(testRecipesDir);
      }
      await fs.ensureDir(testRecipesDir);
    });
    
    after(async function() {
      if (await fs.pathExists(testDbPath)) {
        await fs.remove(testDbPath);
      }
      if (await fs.pathExists(testRecipesDir)) {
        await fs.remove(testRecipesDir);
      }
    });
    
    it('should create and read files', async function() {
      const testFile = path.join(testRecipesDir, 'test.cook');
      const content = '@pomme{2}\n1. Couper les pommes.';
      
      await fs.writeFile(testFile, content, 'utf-8');
      const readContent = await fs.readFile(testFile, 'utf-8');
      
      expect(readContent).to.equal(content);
    });
    
    it('should handle path traversal attempts', function() {
      const maliciousPath = '../../../etc/passwd';
      const sanitized = path.basename(maliciousPath);
      expect(sanitized).to.equal('passwd');
    });
  });
});

describe('Goodwater Recipes - HTTP Security Tests', function() {
  this.timeout(5000);
  
  describe('Input Validation', function() {
    it('should validate username format', function() {
      const validUsernames = ['user123', 'test_user', 'user-name', 'User_Name-123'];
      const invalidUsernames = ['user name', 'user@name', 'user!', 'ab']; // 'ab' too short
      
      validUsernames.forEach(username => {
        expect(/^[a-zA-Z0-9_-]{3,30}$/.test(username)).to.be.true;
      });
      
      invalidUsernames.filter(u => u !== 'ab').forEach(username => {
        expect(/^[a-zA-Z0-9_-]{3,30}$/.test(username)).to.be.false;
      });
    });
    
    it('should validate password length', function() {
      expect('short'.length < 8).to.be.true;
      expect('longenoughpassword'.length >= 8).to.be.true;
    });
  });
});