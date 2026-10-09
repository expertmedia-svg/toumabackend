const crypto = require('crypto');
const { db } = require('../db/database');
const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');
function hashPassword(password) {
 const salt = crypto.randomBytes(16).toString('hex');
 return `scrypt:${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}
function verifyPassword(password, stored) {
 const [scheme, salt, digest] = (stored || '').split(':');
 if (scheme !== 'scrypt' || !salt || !digest) return false;
 const expected = Buffer.from(digest, 'hex');
 const actual = crypto.scryptSync(password, salt, 64);
 return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}
function createSession(userId) {
 const token = crypto.randomBytes(32).toString('hex');
 db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
 db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hashToken(token), userId, Date.now() + 86400000);
 return token;
}
function authMiddleware(req, res, next) {
 const token = (req.headers.authorization || '').match(/^Bearer ([a-f0-9]{64})$/)?.[1];
 const user = token && db.prepare(`SELECT u.* FROM users u JOIN sessions s ON s.user_id = u.id WHERE s.token_hash = ? AND s.expires_at > ?`).get(hashToken(token), Date.now());
 if (!user) return res.status(401).json({ error: 'Session absente ou expirée. Connectez-vous.' });
 if (user.is_suspended) return res.status(403).json({ error: 'Compte suspendu' });
 req.user = user;
 req.user.account_role = user.role;
 if (user.role === 'super_admin') req.user.role = 'admin';
 if (user.role === 'business_collaborator') req.user.role = 'business';
 if (req.user.role==='business') {
  const organizations=db.prepare('SELECT o.status FROM organizations o JOIN organization_members m ON m.organization_id=o.id WHERE m.user_id=?').all(user.id);
  if(organizations.length && organizations.every(o=>o.status==='suspended'))return res.status(403).json({error:'Organisation suspendue'});
 }
 req.sessionHash = hashToken(token);
 next();
}
function requireRole(roles) {
 return (req, res, next) => roles.includes(req.user?.role) && !(req.user.account_role === 'business_collaborator' && req.method !== 'GET') ? next() : res.status(403).json({ error: 'Accès non autorisé' });
}
function audit(req, action, type, id, details = {}) {
 db.prepare('INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,details,ip_address) VALUES(?,?,?,?,?,?,?)')
  .run(crypto.randomUUID(), req.user?.id || null, action, type, id, JSON.stringify(details), req.ip);
}
module.exports = { authMiddleware, requireRole, hashPassword, verifyPassword, createSession, audit };
