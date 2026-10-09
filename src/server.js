const express = require('express');
const cors = require('cors');
const path = require('path');
const apiRoutes = require('./routes/api');
const { db } = require('./db/database');
const { authMiddleware } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0';

// Middleware
app.disable('x-powered-by');
if (process.env.TOUMA_TRUST_LOCAL_PROXY === '1') app.set('trust proxy', 'loopback');
app.use(cors({ origin: process.env.TOUMA_ORIGIN ? process.env.TOUMA_ORIGIN.split(',') : ['http://localhost:5173','http://127.0.0.1:5173'], exposedHeaders:['Content-Disposition'] }));
app.use((req,res,next) => {
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Cache-Control','no-store');
  next();
});
const requests = new Map();
app.use('/api', (req,res,next) => {
  const now = Date.now();
  for (const [key,value] of requests) if (value.until < now) requests.delete(key);
  const key = req.ip + (req.path.startsWith('/auth/login') || req.path.startsWith('/auth/register') ? ':auth' : ':api');
  const row = requests.get(key) || {until:now+60000,count:0};
  row.count++; requests.set(key,row);
  if (row.count > (key.endsWith(':auth') ? 15 : 300)) return res.status(429).json({error:'Trop de requêtes. Réessayez dans une minute.'});
  next();
});
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Static files for uploads (evidence photos, icons)
app.get('/uploads/:filename', authMiddleware, (req,res) => {
  const file = db.prepare('SELECT * FROM evidence_files WHERE filename=?').get(req.params.filename);
  if (!file) return res.status(404).end();
  const authorized = ['admin','super_admin','study_manager','quality_controller'].includes(req.user.account_role) || file.user_id === req.user.id ||
    (req.user.role === 'business' && db.prepare(`SELECT s.id FROM submissions s JOIN campaigns c ON c.id=s.campaign_id JOIN organization_members m ON m.organization_id=c.organization_id
     WHERE m.user_id=? AND EXISTS(SELECT 1 FROM json_each(s.evidence) e WHERE json_extract(e.value,'$.url')=?)`).get(req.user.id,'/uploads/'+file.filename));
  if (!authorized) return res.status(403).end();
  res.type(file.mime_type).sendFile(path.join(__dirname,'../uploads',file.filename));
});

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin/referrals', require('./routes/referrals'));
app.use('/api', require('./routes/platform'));
app.use('/api/saas', require('./routes/saas'));
app.use('/api', require('./routes/management'));
app.use('/api', apiRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'TOUMA Micro-Tasks Engine API',
    version: '1.0.0',
    features: ['saas','professional-web','referral-v1'],
    timestamp: new Date().toISOString()
  });
});

// API-only repository; the web dashboards and Flutter are separate clients.

// Error handling middleware
app.use((err, req, res, next) => {
  if(!err.status||err.status>=500)console.error('[TOUMA API ERROR]:', err);
  if(err.code && err.code.startsWith('LIMIT_'))return res.status(400).json({error:'Fichier trop volumineux ou nombre de fichiers non autorisé'});
  res.status(err.status || 500).json({
    error: err.status && err.status < 500 ? err.message : 'Erreur interne du serveur TOUMA'
  });
});

if (require.main === module) {
 const server=app.listen(PORT, HOST);
 server.once('error',err=>{
  console.error(err.code==='EADDRINUSE'?`ERREUR : le port ${PORT} est deja utilise. Arretez l'ancien serveur Touma avant de relancer.`:`ERREUR demarrage : ${err.message}`);
  db.close();process.exitCode=1;
 });
 server.once('listening', () => {
  console.log(`===============================================`);
  console.log(`🚀 TOUMA Backend Engine running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`📦 Database: SQLite WAL mode ready`);
  console.log(`===============================================`);
 });
}

module.exports = app;
