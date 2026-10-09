const router = require('express').Router();
const crypto = require('crypto');
const { db } = require('../db/database');
const { authMiddleware,requireRole,audit } = require('../middleware/auth');
router.use(authMiddleware);
router.get('/admin/users',requireRole(['admin']),(req,res)=>res.json(db.prepare('SELECT id,name,email,phone,role,is_suspended,created_at FROM users').all()));
router.put('/admin/users/:id/suspension',requireRole(['admin']),(req,res)=>{
 if (req.params.id===req.user.id || typeof req.body.suspended!=='boolean') return res.status(400).json({error:'Suspension invalide'});
 const target=db.prepare('SELECT role FROM users WHERE id=?').get(req.params.id);
 if(!target)return res.status(404).json({error:'Compte introuvable'});
 if(['admin','super_admin'].includes(target.role)&&req.user.account_role!=='super_admin')return res.status(403).json({error:'Seul le super administrateur peut suspendre un administrateur'});
 db.transaction(()=>{
  db.prepare('UPDATE users SET is_suspended=?,suspension_reason=? WHERE id=?').run(req.body.suspended?1:0,req.body.reason||null,req.params.id);
  if(req.body.suspended) db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.params.id);
  audit(req,'suspension','user',req.params.id,req.body);
 }).immediate();
 res.json({success:true});
});
router.get('/organizations',requireRole(['business','admin']),(req,res)=>res.json(req.user.role==='admin' ? db.prepare('SELECT * FROM organizations').all() : db.prepare('SELECT o.* FROM organizations o JOIN organization_members m ON m.organization_id=o.id WHERE m.user_id=?').all(req.user.id)));
router.post('/admin/organizations',requireRole(['admin']),(req,res)=>{
 const {name,owner_id} = req.body;
 if(typeof name!=='string' || !name.trim() || !db.prepare("SELECT id FROM users WHERE id=? AND role='business'").get(owner_id)) return res.status(400).json({error:'Entreprise et compte Business requis'});
 const id=crypto.randomUUID();
 db.transaction(()=>{
  db.prepare("INSERT INTO organizations(id,name,slug,is_verified,status) VALUES(?,?,?,0,'pending')").run(id,name,id);
  db.prepare('INSERT INTO organization_members(id,organization_id,user_id) VALUES(?,?,?)').run(crypto.randomUUID(),id,owner_id);
  audit(req,'create','organization',id);
 }).immediate();res.status(201).json({id});
});
router.put('/admin/users/:id/role',requireRole(['admin']),(req,res)=>{
 if(!['contributor','business'].includes(req.body.role)) return res.status(400).json({error:'Rôle invalide'});
 db.prepare('UPDATE users SET role=? WHERE id=? AND role != ?').run(req.body.role,req.params.id,'admin');
 audit(req,'role_change','user',req.params.id,{role:req.body.role});res.json({success:true});
});
router.put('/admin/campaigns/:id/status',requireRole(['admin']),(req,res)=>{
 try {
  require('../services/saasCampaigns').changeStatus(req,req.params.id,req.body.status);
  audit(req,'status_change','campaign',req.params.id,req.body);res.json({success:true});
 }catch(e){res.status(e.status||400).json({error:e.message});}
});
router.get('/admin/withdrawals',requireRole(['admin']),(req,res)=>res.json(db.prepare('SELECT * FROM withdrawals ORDER BY created_at DESC').all()));
router.post('/admin/withdrawals/:id/reject',requireRole(['admin']),(req,res)=>{
 try {
  db.transaction(()=>{
   const w=db.prepare('SELECT * FROM withdrawals WHERE id=?').get(req.params.id);
   if(!w || w.status!=='pending') throw new Error('Demande non annulable');
   db.prepare("UPDATE withdrawals SET status='rejected',failure_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(req.body.reason||'Demande annulée',w.id);
   const wallet=db.prepare('SELECT * FROM wallets WHERE user_id=?').get(w.user_id);
   db.prepare('UPDATE wallets SET balance=balance+?,reserved_balance=reserved_balance-? WHERE user_id=?').run(w.amount,w.amount,w.user_id);
   db.prepare("UPDATE wallet_transactions SET status='failed' WHERE reference_id=? AND type='withdrawal'").run(w.id);
   db.prepare("INSERT INTO wallet_transactions(id,wallet_id,user_id,type,amount,balance_after,description,reference_type,reference_id) VALUES(?,?,?,'adjustment',?,?,'Libération des fonds réservés','withdrawal_reversal',?)").run(crypto.randomUUID(),wallet.id,w.user_id,w.amount,wallet.balance+w.amount,w.id);
   audit(req,'reject','withdrawal',w.id);
  }).immediate();res.json({success:true});
 }catch(e){res.status(400).json({error:e.message});}
});
router.get('/admin/transactions',requireRole(['admin']),(req,res)=>res.json(db.prepare('SELECT * FROM wallet_transactions ORDER BY created_at DESC LIMIT 500').all()));
router.get('/admin/audit',requireRole(['admin']),(req,res)=>res.json(db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 500').all()));
router.post('/admin/users/:id/warning',requireRole(['admin']),(req,res)=>{
 if(typeof req.body.message!=='string' || !req.body.message.trim()) return res.status(400).json({error:'Message requis'});
 db.transaction(()=>{
  db.prepare("INSERT INTO notifications(id,user_id,title,message) VALUES(?,?,'Message de l’administration',?)").run(crypto.randomUUID(),req.params.id,req.body.message);
  audit(req,'warning','user',req.params.id);
 }).immediate();res.json({success:true});
});
module.exports=router;
