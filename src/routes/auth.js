const router = require('express').Router();
const crypto = require('crypto');
const { db } = require('../db/database');
const { hashPassword, verifyPassword, createSession, authMiddleware, audit } = require('../middleware/security');
function registerAccount(req,res,business=false) {
 const { name, password, phone, referral_code } = req.body;
 const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
 if (typeof name !== 'string' || !name.trim() || name.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof password !== 'string' || password.length < 12 || password.length > 256 || (phone && !/^\+?[0-9 ]{8,20}$/.test(phone)))
  return res.status(400).json({ error: 'Nom, email valide et mot de passe de 12 caractères minimum requis.' });
 if(business&&(typeof req.body.company_name!=='string'||!req.body.company_name.trim()||req.body.company_name.length>200))return res.status(400).json({error:'Nom de votre entreprise requis'});
 try {
  const id = 'usr_' + crypto.randomUUID();
  const passwordHash = hashPassword(password);
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
   if (referral_code) {
    const referrer = db.prepare('SELECT id FROM users WHERE referral_code = ?').get(referral_code);
    if (!referrer) throw new Error('Code inconnu');
    const setting=db.prepare("SELECT value FROM platform_settings WHERE key='referral_reward'").get();
    const bonus=setting?JSON.parse(setting.value):500;
    db.prepare('INSERT INTO referrals(id,referrer_user_id,referred_user_id,referral_code,bonus_amount) VALUES(?,?,?,?,?)').run(crypto.randomUUID(), referrer.id, id, referral_code,bonus);
   }
  }).immediate();
  res.status(201).json({ token: createSession(id), user_id: id });
 } catch (err) {
  res.status(400).json({ error: err.message.includes('UNIQUE') ? 'Email ou téléphone déjà enregistré' : 'Inscription refusée. Vérifiez le code de parrainage.' });
 }
}
router.post('/register',(req,res)=>registerAccount(req,res));
router.post('/register-enterprise',(req,res)=>registerAccount(req,res,true));
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
 try{db.transaction(()=>{db.prepare('UPDATE users SET name=?,city=?,city_confirmed=?,phone=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(name,city,req.body.city!==undefined?(city?1:0):req.user.city_confirmed,phone||null,req.user.id);audit(req,'profile_update','user',req.user.id);}).immediate();res.json({success:true});}catch(e){if(e.code?.includes('CONSTRAINT'))return res.status(400).json({error:'Téléphone déjà utilisé'});throw e;}
});
module.exports = router;
