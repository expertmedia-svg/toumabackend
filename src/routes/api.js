const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const { db } = require('../db/database');
const { submit } = require('../services/submissionService');
const { authMiddleware, requireRole, audit } = require('../middleware/auth');
const { analyzeSubmissionFraud } = require('../services/antiFraudService');
const { validateDynamicForm } = require('../services/formValidationService');
const { validateAndCreditSubmission, rejectSubmission, processWithdrawal } = require('../services/walletService');

// Multer storage configuration
const uploadsDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${Date.now()}-${uuidv4()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// ==========================================
// 1. AUTH & USERS
// ==========================================

router.get('/auth/me', authMiddleware, (req, res) => {
  const user = req.user;
  const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(user.id) || { balance: 0, total_earned: 0 };
  const unreadNotifs = db.prepare('SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0').get(user.id);

  res.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      account_role: user.account_role,
      country: user.country,
      city: user.city_confirmed?user.city:'',
      avatar_url: user.avatar_url,
      reputation_level: user.reputation_level,
      reputation_score: user.reputation_score,
      referral_code: user.referral_code,
      is_verified: !!user.is_verified
    },
    wallet: {
      balance: wallet.balance,
      total_earned: wallet.total_earned,
      total_withdrawn: wallet.total_withdrawn || 0,
      currency: wallet.currency || 'F CFA'
    },
    unread_notifications_count: unreadNotifs.count
  });
});

// ==========================================
// 2. CAMPAIGNS (Generic Micro-Tasks)
// ==========================================

router.get('/campaigns', authMiddleware, (req, res) => {
  const { category, type } = req.query;
  let query = req.user.role === 'contributor' ? "SELECT * FROM campaigns WHERE status = 'active' AND (starts_at IS NULL OR starts_at<=DATE('now')) AND (ends_at IS NULL OR ends_at>=DATE('now')) AND organization_id IN (SELECT id FROM organizations WHERE status!='suspended')" : 'SELECT * FROM campaigns WHERE 1=1';
  const params = [];
  if (req.user.role === 'business') {
    query += " AND organization_id IN (SELECT m.organization_id FROM organization_members m JOIN organizations o ON o.id=m.organization_id WHERE m.user_id=? AND o.status!='suspended')";
    params.push(req.user.id);
  }

  if (category && category !== 'Toutes') {
    query += ' AND category = ?';
    params.push(category);
  }
  if (type) {
    query += ' AND task_type = ?';
    params.push(type);
  }

  query += ' ORDER BY created_at DESC';
  const campaigns = db.prepare(query).all(...params);

  // Parse JSON columns
  const formatted = campaigns.map(c => ({
    ...c,
    geo_rules: JSON.parse(c.geo_rules || '{}'),
    eligibility_rules: JSON.parse(c.eligibility_rules || '{}'),
    validation_rules: JSON.parse(c.validation_rules || '{}'),
    evidence_rules: JSON.parse(c.evidence_rules || '{}'),
    form_schema: JSON.parse(c.form_schema || '[]')
  }));

  res.json(req.user.role === 'contributor' ? formatted.filter(c=>(!c.eligibility_rules.countries?.length||c.eligibility_rules.countries.includes(req.user.country_code))&&(!c.eligibility_rules.min_reputation||['Débutant','Fiable','Confirmé','Expert'].indexOf(req.user.reputation_level)>=['Débutant','Fiable','Confirmé','Expert'].indexOf(c.eligibility_rules.min_reputation))) : formatted);
});

router.get('/campaigns/:id', authMiddleware, (req, res) => {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) {
    return res.status(404).json({ error: 'Campagne introuvable' });
  }

  if(req.user.role==='contributor'){
    const today=new Date().toISOString().slice(0,10),rules=JSON.parse(campaign.eligibility_rules||'{}');
    const org=db.prepare('SELECT status FROM organizations WHERE id=?').get(campaign.organization_id);
    if(campaign.status!=='active'||!org||org.status==='suspended'||(campaign.starts_at&&campaign.starts_at>today)||(campaign.ends_at&&campaign.ends_at<today)||(rules.countries?.length&&!rules.countries.includes(req.user.country_code))||(rules.min_reputation&&['Débutant','Fiable','Confirmé','Expert'].indexOf(req.user.reputation_level)<['Débutant','Fiable','Confirmé','Expert'].indexOf(rules.min_reputation)))return res.status(404).json({error:'Campagne indisponible'});
  }
  if(req.user.role==='business'&&db.prepare('SELECT status FROM organizations WHERE id=?').get(campaign.organization_id)?.status==='suspended')return res.status(403).json({error:'Organisation suspendue'});
  if (req.user.role === 'business' && !db.prepare('SELECT id FROM organization_members WHERE organization_id=? AND user_id=?').get(campaign.organization_id,req.user.id)) return res.status(403).json({error:'Accès refusé'});
  res.json({
    ...campaign,
    geo_rules: JSON.parse(campaign.geo_rules || '{}'),
    eligibility_rules: JSON.parse(campaign.eligibility_rules || '{}'),
    validation_rules: JSON.parse(campaign.validation_rules || '{}'),
    evidence_rules: JSON.parse(campaign.evidence_rules || '{}'),
    form_schema: JSON.parse(campaign.form_schema || '[]')
  });
});

// Compatibility route shared with the SaaS campaign service.
router.post('/campaigns', authMiddleware, requireRole(['business','admin']), (req,res,next)=>{
 try {
  const C=require('../services/saasCampaigns');
  const membership=db.prepare("SELECT organization_id FROM organization_members WHERE user_id=? AND role IN ('owner','manager')").get(req.user.id);
  const org=req.user.role==='admin'?(req.body.organization_id||membership?.organization_id):membership?.organization_id;
  const campaignId=db.transaction(()=>{
   const campaignId=C.createCampaign(req,req.body,org,'pending_approval');
   if(req.user.role==='admin')C.changeStatus(req,campaignId,'active');
   audit(req,'create','campaign',campaignId);
   return campaignId;
  }).immediate();
  res.status(201).json({success:true,campaign_id:campaignId});
 }catch(e){next(e);}
});

// ==========================================
// 3. SUBMISSIONS & OFFLINE SYNC
// ==========================================

router.post('/submissions', authMiddleware, requireRole(['contributor']), (req, res) => {
  try { res.status(201).json(submit(req.user, req.body)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/submissions/batch-sync', authMiddleware, requireRole(['contributor']), (req, res) => {
  const queue = req.body.queue;
  if (!Array.isArray(queue) || queue.length > 100) return res.status(400).json({ error:'File invalide (100 éléments maximum)' });
  const results = queue.map(item => {
    try { return { local_id:item.local_id, ...submit(req.user,item), status:'synced' }; }
    catch (err) { return { local_id:item?.local_id, status:'error', error:err.message }; }
  });
  res.json({success:true,results});
});

// Contributor's own submissions
router.get('/submissions/my', authMiddleware, (req, res) => {
  const submissions = db.prepare(`
    SELECT s.*, c.title as campaign_title, c.reward_amount, c.currency, c.category, c.icon_name, c.badge_color
    FROM submissions s
    JOIN campaigns c ON s.campaign_id = c.id
    WHERE s.contributor_id = ?
    ORDER BY s.created_at DESC
  `).all(req.user.id);

  res.json(submissions.map(s => ({
    ...s,
    answers: JSON.parse(s.answers || '{}'),
    evidence: JSON.parse(s.evidence || '[]'),
    location: JSON.parse(s.location || '{}'),
    fraud_flags: JSON.parse(s.fraud_flags || '[]')
  })));
});

// Admin & Business: Submissions list
router.get('/submissions', authMiddleware, requireRole(['business','admin']), (req, res) => {
  const { campaign_id, status } = req.query;
  let query = `
    SELECT s.*, c.title as campaign_title, c.reward_amount, c.currency, u.name as contributor_name, u.phone as contributor_phone
    FROM submissions s
    JOIN campaigns c ON s.campaign_id = c.id
    JOIN users u ON s.contributor_id = u.id
    WHERE 1=1
  `;
  const params = [];
  if (req.user.role === 'business') { query += ' AND c.organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = ?)'; params.push(req.user.id); }
  if (campaign_id) {
    query += ' AND s.campaign_id = ?';
    params.push(campaign_id);
  }
  if (status) {
    query += ' AND s.status = ?';
    params.push(status);
  }
  query += ' ORDER BY s.created_at DESC LIMIT 100';

  const rows = db.prepare(query).all(...params);
  res.json(rows.map(r => ({
    ...r,
    answers: JSON.parse(r.answers || '{}'),
    evidence: JSON.parse(r.evidence || '[]'),
    location: JSON.parse(r.location || '{}'),
    fraud_flags: JSON.parse(r.fraud_flags || '[]')
  })));
});

// Validation pipeline (Admin & Business approval)
router.post('/submissions/:id/validate', authMiddleware, requireRole(['business','admin']), (req, res) => {
  try {
    if (req.user.role === 'business' && !db.prepare(`SELECT s.id FROM submissions s JOIN campaigns c ON c.id=s.campaign_id JOIN organization_members m ON m.organization_id=c.organization_id WHERE s.id=? AND m.user_id=? AND m.role IN ('owner','manager')`).get(req.params.id,req.user.id)) return res.status(403).json({error:'Accès refusé'});
    const result = validateAndCreditSubmission(req.params.id, req.user.id);
    audit(req,'validate','submission',req.params.id);
    res.json({ success: true, result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/submissions/:id/reject', authMiddleware, requireRole(['business','admin']), (req, res) => {
  const { reason = 'Informations ou photos non exploitables' } = req.body;
  try {
    if (req.user.role === 'business' && !db.prepare(`SELECT s.id FROM submissions s JOIN campaigns c ON c.id=s.campaign_id JOIN organization_members m ON m.organization_id=c.organization_id WHERE s.id=? AND m.user_id=? AND m.role IN ('owner','manager')`).get(req.params.id,req.user.id)) return res.status(403).json({error:'Accès refusé'});
    const result = rejectSubmission(req.params.id, reason, req.user.id);
    audit(req,'reject','submission',req.params.id);
    res.json({ success: true, result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// 4. WALLET & WITHDRAWALS
// ==========================================

router.get('/wallet', authMiddleware, (req, res) => {
  const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(req.user.id) || { balance: 0, total_earned: 0 };
  const transactions = db.prepare(`
    SELECT * FROM wallet_transactions
    WHERE user_id = ?
    ORDER BY created_at DESC LIMIT 50
  `).all(req.user.id);

  const settingsRow = db.prepare("SELECT value FROM platform_settings WHERE key = 'min_withdrawal'").get();
  const minWithdrawal = settingsRow ? JSON.parse(settingsRow.value) : 500;

  res.json({
    wallet,
    transactions,
    pending_earnings: db.prepare("SELECT COALESCE(SUM(COALESCE(s.promised_reward,c.reward_amount)),0) amount FROM submissions s JOIN campaigns c ON c.id=s.campaign_id WHERE s.contributor_id=? AND s.status IN ('submitted','under_review')").get(req.user.id).amount,
    withdrawals: db.prepare('SELECT * FROM withdrawals WHERE user_id=? ORDER BY created_at DESC').all(req.user.id),
    payment_integration: 'not_configured',
    min_withdrawal: minWithdrawal
  });
});

router.post('/wallet/withdraw', authMiddleware, requireRole(['contributor']), (req, res) => {
  const { amount, operator, phone_number } = req.body;

  if (!amount || !operator || !phone_number) {
    return res.status(400).json({ error: 'Montant, opérateur et numéro requis' });
  }

  try {
    const result = processWithdrawal(req.user.id, amount, operator, phone_number, req.body.idempotency_key);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// 5. REFERRAL & NOTIFICATIONS
// ==========================================

router.get('/referral', authMiddleware, (req,res)=>res.json(require('../services/referralService').summary(req.user,req.query)));

router.get('/notifications', authMiddleware, (req, res) => {
  const notifs = db.prepare(`
    SELECT * FROM notifications
    WHERE user_id = ?
    ORDER BY created_at DESC LIMIT 50
  `).all(req.user.id);

  res.json(notifs);
});

router.put('/notifications/:id/read', authMiddleware, (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ success: true });
});

router.put('/notifications/mark-all-read', authMiddleware, (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ success: true });
});

// ==========================================
// 6. UPLOAD EVIDENCE (Photo / Camera)
// ==========================================

router.post('/upload', authMiddleware, upload.single('photo'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Aucun fichier téléchargé' });
  }
  const bytes = fs.readFileSync(req.file.path);
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const isWebp = bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP';
  const isMp4 = bytes.toString('ascii',4,8) === 'ftyp';
  const isWebm = bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
  const isWav = bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WAVE';
  const isOgg = bytes.toString('ascii',0,4)==='OggS';
  const isMp3 = bytes.toString('ascii',0,3)==='ID3' || (bytes[0]===0xff && (bytes[1]&0xe0)===0xe0);
  const mediaType = typeof req.file.mimetype === 'string' && /^(audio|video)\//.test(req.file.mimetype) ? req.file.mimetype.split('/')[0] : 'video';
  const mime = isJpeg ? 'image/jpeg' : isPng ? 'image/png' : isWebp ? 'image/webp' : isMp4 ? mediaType+'/mp4' : isWebm ? mediaType+'/webm' : isWav ? 'audio/wav' : isOgg ? 'audio/ogg' : isMp3 ? 'audio/mpeg' : null;
  if (!mime) { fs.unlinkSync(req.file.path); return res.status(400).json({error:'Format accepté : JPEG, PNG, WebP, MP4, WebM, WAV, OGG ou MP3'}); }
  const sha = require('crypto').createHash('sha256').update(bytes).digest('hex');
  db.prepare('INSERT INTO evidence_files(filename,user_id,mime_type,sha256,size) VALUES(?,?,?,?,?)').run(req.file.filename,req.user.id,mime,sha,req.file.size);
  const fileUrl = `/uploads/${req.file.filename}`;
  res.json({
    url: fileUrl,
    filename: req.file.filename,
    size: req.file.size,
    mimetype: req.file.mimetype
  });
});

// ==========================================
// 7. BUSINESS & ADMIN DASHBOARD METRICS
// ==========================================

router.get('/business/stats', authMiddleware, requireRole(['business','admin']), (req, res) => {
  const scope = req.user.role === 'admin' ? '' : ' WHERE organization_id IN (SELECT organization_id FROM organization_members WHERE user_id=?)';
  const args = req.user.role === 'admin' ? [] : [req.user.id];
  const campaigns = db.prepare('SELECT * FROM campaigns' + scope).all(...args);
  const ids = campaigns.map(c=>c.id);
  const scoped = db.prepare('SELECT * FROM submissions WHERE campaign_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids));
  const submissionsCount = scoped.length;
  const validatedCount = scoped.filter(s=>s.status==='validated').length;
  const rejectedCount = scoped.filter(s=>s.status==='rejected').length;

  // Submissions per day (last 7 days)
  const submissionsByDay = db.prepare(`
    SELECT DATE(created_at) as date, COUNT(*) as count
    FROM submissions
    WHERE campaign_id IN (SELECT value FROM json_each(?))
    GROUP BY DATE(created_at)
    ORDER BY date DESC LIMIT 7
  `).all(JSON.stringify(ids));

  res.json({
    campaigns_count: campaigns.length,
    total_budget: campaigns.reduce((sum,c)=>sum+c.total_budget_amount,0),
    total_credited: db.prepare("SELECT COALESCE(SUM(t.amount),0) amount FROM wallet_transactions t JOIN submissions s ON s.id=t.reference_id WHERE t.type='task_reward' AND s.campaign_id IN (SELECT value FROM json_each(?))").get(JSON.stringify(ids)).amount,
    active_campaigns_count: campaigns.filter(c => c.status === 'active').length,
    total_submissions: submissionsCount,
    validated_submissions: validatedCount,
    rejected_submissions: rejectedCount,
    validation_rate: submissionsCount > 0 ? Math.round((validatedCount / submissionsCount) * 100) : 100,
    submissions_by_day: submissionsByDay
  });
});

router.get('/admin/stats', authMiddleware, requireRole(['admin']), (req, res) => {
  const usersCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  const contributorsCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'contributor'").get().count;
  const totalSubmissions = db.prepare('SELECT COUNT(*) as count FROM submissions').get().count;
  const fraudSignalsCount = db.prepare('SELECT COUNT(*) as count FROM fraud_signals').get().count;
  const totalPaidOut = db.prepare("SELECT SUM(amount) as sum FROM wallet_transactions WHERE type = 'task_reward'").get().sum || 0;
  const totalWithdrawn = db.prepare("SELECT SUM(amount) as sum FROM withdrawals WHERE status = 'completed'").get().sum || 0;

  const pendingSubmissions = db.prepare("SELECT COUNT(*) as count FROM submissions WHERE status IN ('submitted', 'under_review')").get().count;

  res.json({
    total_users: usersCount,
    contributors_count: contributorsCount,
    total_submissions: totalSubmissions,
    pending_submissions: pendingSubmissions,
    fraud_signals_count: fraudSignalsCount,
    total_paid_out: totalPaidOut,
    total_withdrawn: totalWithdrawn
  });
});

router.get('/admin/fraud-signals', authMiddleware, requireRole(['admin']), (req, res) => {
  const signals = db.prepare(`
    SELECT f.*, u.name as user_name, u.phone as user_phone, s.campaign_id, c.title as campaign_title
    FROM fraud_signals f
    JOIN users u ON f.user_id = u.id
    JOIN submissions s ON f.submission_id = s.id
    JOIN campaigns c ON s.campaign_id = c.id
    ORDER BY f.created_at DESC LIMIT 50
  `).all();

  res.json(signals.map(s => ({
    ...s,
    details: JSON.parse(s.details || '{}')
  })));
});

router.get('/admin/settings', authMiddleware, requireRole(['admin']), (req, res) => {
  const rows = db.prepare('SELECT * FROM platform_settings').all();
  const settings = {};
  rows.forEach(r => {
    try {
      settings[r.key] = JSON.parse(r.value);
    } catch {
      settings[r.key] = r.value;
    }
  });
  res.json(settings);
});

router.put('/admin/settings', authMiddleware, requireRole(['admin']), (req, res) => {
  const insertSetting = db.prepare(`
    INSERT OR REPLACE INTO platform_settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
  `);

  if (!Number.isSafeInteger(req.body.min_withdrawal) || req.body.min_withdrawal < 1) return res.status(400).json({error:'Minimum entier positif requis'});
  for (const [key, value] of Object.entries(req.body)) {
    if (!['min_withdrawal','referral_reward','platform_currency','auto_validation_threshold_score'].includes(key)) continue;
    insertSetting.run(key, JSON.stringify(value));
  }

  res.json({ success: true, settings: req.body });
});

module.exports = router;
