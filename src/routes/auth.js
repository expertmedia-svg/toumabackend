const router = require('express').Router();
const crypto = require('crypto');
const { db } = require('../db/database');
const { hashPassword, verifyPassword, createSession, authMiddleware, audit } = require('../middleware/security');
const referral=require('../services/referralService');
function registerAccount(req,res,business=false) {
 const { name, password, phone, referral_code } = req.body;
 const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
 if (typeof name !== 'string' || !name.trim() || name.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof password !== 'string' || password.length < 12 || password.length > 256 || (phone && !/^\+?[0-9 ]{8,20}$/.test(phone)))
  return res.status(400).json({ error: 'Nom, email valide et mot de passe de 12 caractères minimum requis.' });
 if(business&&(typeof req.body.company_name!=='string'||!req.body.company_name.trim()||req.body.company_name.length>200))return res.status(400).json({error:'Nom de votre entreprise requis'});
 try {
  const requestKey=req.body.registration_key;
  if(requestKey!==undefined&&(typeof requestKey!=='string'||requestKey.length<16||requestKey.length>160))return res.status(400).json({error:'Identifiant d’inscription invalide'});
  const normalizedPhone=phone?referral.normalizePhone(phone):null;
  const payloadHash=crypto.createHash('sha256').update(JSON.stringify({name:name.trim(),email,password,phone:normalizedPhone,code:typeof referral_code==='string'?referral_code.trim().toUpperCase():null,city:req.body.city||'',company:req.body.company_name||'',business})).digest('hex');
  if(requestKey){const previous=db.prepare('SELECT * FROM registration_requests WHERE request_key=?').get(requestKey);if(previous){
   if(previous.payload_hash!==payloadHash)return res.status(409).json({error:'Identifiant utilisé pour une autre inscription'});
   const existing=db.prepare('SELECT * FROM users WHERE id=?').get(previous.user_id);if(existing.is_suspended)return res.status(403).json({error:'Compte suspendu'});
   const bonus=db.prepare('SELECT amount FROM referral_bonuses WHERE user_id=?').get(existing.id);
   return res.status(201).json({token:createSession(existing.id),user_id:existing.id,bonus_credited:bonus?.amount||0,duplicate:true});
  }}
  if(normalizedPhone&&db.prepare('SELECT id FROM users WHERE normalized_phone=?').get(normalizedPhone))return res.status(400).json({error:'Téléphone déjà enregistré'});
  const id = 'usr_' + crypto.randomUUID();
  const passwordHash = hashPassword(password);
  let bonusCredited=0;
  db.transaction(() => {
   const city=typeof req.body.city==='string'?req.body.city.trim():'';
   if(city.length>150)throw new Error('Ville trop longue');
   db.prepare('INSERT INTO users(id,name,email,phone,password_hash,referral_code,city,city_confirmed) VALUES(?,?,?,?,?,?,?,?)').run(id, name.trim(), email, phone || null, passwordHash, crypto.randomBytes(6).toString('hex').toUpperCase(),city,city?1:0);
   if(business){
    db.prepare("UPDATE users SET role='business' WHERE id=?").run(id);
    const org='org_'+crypto.randomUUID();
    db.prepare("INSERT INTO organizations(id,name,slug,is_verified,status,contact_email) VALUES(?,?,?,0,'pending',?)").run(org,req.body.company_name.trim(),org,email);
    db.prepare("INSERT INTO organization_members(id,organization_id,user_id,role) VALUES(?,?,?,'owner')").run(crypto.randomUUID(),org,id);
   }
   db.prepare('INSERT INTO wallets(id,user_id) VALUES(?,?)').run(crypto.randomUUID(), id);
   db.prepare('UPDATE users SET normalized_phone=? WHERE id=?').run(normalizedPhone,id);
   db.prepare('INSERT INTO referral_codes SELECT id,referral_code FROM users WHERE id=?').run(id);
   if(referral_code){if(business)throw new Error('Parrainage réservé aux contributeurs');bonusCredited=referral.registerReferral({id,email,phone},referral_code,req);}
   if(requestKey)db.prepare('INSERT INTO registration_requests VALUES(?,?,?)').run(requestKey,id,payloadHash);
   req.user={id};audit(req,'register','user',id,{referral:!!referral_code,bonus:bonusCredited});
  }).immediate();
  res.status(201).json({ token: createSession(id), user_id: id,bonus_credited:bonusCredited });
 } catch (err) {
  res.status(400).json({ error: err.message.includes('UNIQUE') ? 'Email ou téléphone déjà enregistré' : 'Inscription refusée. Vérifiez le code de parrainage.' });
 }
}
router.post('/register',(req,res)=>registerAccount(req,res));
router.post('/register-enterprise',(req,res)=>registerAccount(req,res,true));
const codeAttempts=new Map();
router.post('/referral-code',(req,res)=>{
 const now=Date.now();for(const [key,row] of codeAttempts)if(row.until<now)codeAttempts.delete(key);
 const row=codeAttempts.get(req.ip)||{count:0,until:now+60000};row.count++;codeAttempts.set(req.ip,row);
 if(row.count>15)return res.status(429).json({error:'Trop de tentatives. Réessayez dans une minute.'});
 try{referral.validateCode(req.body.code);const rule=referral.settings();res.json({valid:true,bonus_amount:rule.bonus,rate_bps:rule.rate_bps});}catch(e){res.status(e.status||400).json({valid:false,error:e.message});}
});
router.post(['/login','/login-web'], (req, res) => {
 const { email, password } = req.body;
 if (typeof email !== 'string' || typeof password !== 'string' || password.length > 256) return res.status(400).json({ error: 'Identifiants invalides' });
 const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());
 const stored = user?.password_hash || hashPassword('invalid-account-password');
 if (!verifyPassword(password, stored) || !user || user.is_suspended) return res.status(401).json({ error: 'Identifiants invalides' });
 if(req.path==='/login-web'&&!['admin','super_admin','study_manager','quality_controller','business','business_collaborator'].includes(user.role))return res.status(403).json({error:'Ce compte contributeur utilise Touma Mobile. Connectez-vous avec un compte Admin ou Entreprise.'});
 req.user = user;
 audit(req, 'login', 'user', user.id);
 res.json({ token: createSession(user.id), user_id: user.id });
});
router.post('/logout', authMiddleware, (req, res) => {
 db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.sessionHash);
 res.json({ success: true });
});
router.put('/password', authMiddleware, (req, res) => {
 const { current_password, password } = req.body;
 if (typeof current_password !== 'string' || current_password.length > 256 || typeof password !== 'string' || password.length < 12 || password.length > 256 || !verifyPassword(current_password, req.user.password_hash))
  return res.status(400).json({ error: 'Mot de passe actuel incorrect ou nouveau mot de passe trop court' });
 db.transaction(() => {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.user.id);
  audit(req, 'password_change', 'user', req.user.id);
 }).immediate();
 res.json({ success: true });
});
router.put('/profile',authMiddleware,(req,res)=>{
 const name=typeof req.body.name==='string'?req.body.name.trim():req.user.name;
 const city=typeof req.body.city==='string'?req.body.city.trim():req.user.city;
 const phone=req.body.phone===undefined?req.user.phone:req.body.phone;
 if(!name||name.length>120||typeof city!=='string'||city.length>150||(phone&& (typeof phone!=='string'||!/^\+?[0-9 ]{8,20}$/.test(phone))))return res.status(400).json({error:'Nom, ville ou téléphone invalide'});
 try{db.transaction(()=>{const normalized=phone?referral.normalizePhone(phone):null;if(normalized&&db.prepare('SELECT id FROM users WHERE normalized_phone=? AND id<>?').get(normalized,req.user.id))throw Object.assign(new Error('Téléphone déjà utilisé'),{code:'CONSTRAINT'});db.prepare('UPDATE users SET name=?,city=?,city_confirmed=?,phone=?,normalized_phone=?,phone_verified_at=CASE WHEN phone IS ? THEN phone_verified_at ELSE NULL END,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(name,city,req.body.city!==undefined?(city?1:0):req.user.city_confirmed,phone||null,normalized,phone||null,req.user.id);audit(req,'profile_update','user',req.user.id);}).immediate();res.json({success:true});}catch(e){if(e.code?.includes('CONSTRAINT'))return res.status(400).json({error:'Téléphone déjà utilisé'});throw e;}
});
module.exports = router;
