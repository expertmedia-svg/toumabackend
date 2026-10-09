const router=require('express').Router();
const {db}=require('../db/database');
const {authMiddleware,requireRole,audit}=require('../middleware/auth');
const service=require('../services/referralService');
const wrap=fn=>(req,res)=>{try{fn(req,res);}catch(e){res.status(e.status||400).json({error:e.code?.includes('CONSTRAINT')?'Référence déjà utilisée ou opération invalide':e.message});}};
router.use(authMiddleware,requireRole(['admin']));
function scope(query,dateField='r.created_at'){
 const clauses=[],params=[];
 for(const [operator,key] of [['>=','from'],['<=','to']])if(query[key]){if(!/^\d{4}-\d{2}-\d{2}$/.test(query[key]))throw new Error('Date invalide');clauses.push(`DATE(${dateField}) ${operator} ?`);params.push(query[key]);}
 if(query.q){clauses.push('(UPPER(r.referral_code) LIKE ? OR p.email LIKE ? OR u.email LIKE ? OR r.referrer_user_id=? OR r.referred_user_id=?)');const text=String(query.q).slice(0,150);params.push('%'+text.toUpperCase()+'%','%'+text+'%','%'+text+'%',text,text);}
 if(query.status){clauses.push('r.payments_suspended=?');params.push(query.status==='suspended'?1:0);}
 return {where:clauses.length?' WHERE '+clauses.join(' AND '):'',params};
}
const relationQuery='SELECT r.*,p.name sponsor,p.email sponsor_email,u.name child,u.email child_email FROM referrals r JOIN users p ON p.id=r.referrer_user_id JOIN users u ON u.id=r.referred_user_id';
router.get('/',wrap((req,res)=>{
 const s=scope(req.query),relations=db.prepare(relationQuery+s.where+' ORDER BY r.created_at DESC').all(...s.params);
 const financialScope=scope(req.query,'COALESCE(c.credited_at,c.created_at)'),bonusScope=scope(req.query,'b.credited_at');
 let commissions=db.prepare('SELECT c.*,p.name sponsor FROM referral_commissions c JOIN referrals r ON r.id=c.referral_id JOIN users p ON p.id=r.referrer_user_id JOIN users u ON u.id=r.referred_user_id'+financialScope.where+' ORDER BY c.created_at DESC').all(...financialScope.params);
 if(req.query.commission_status)commissions=commissions.filter(c=>c.status===req.query.commission_status);
 const bonuses=db.prepare('SELECT b.* FROM referral_bonuses b JOIN referrals r ON r.id=b.referral_id JOIN users p ON p.id=r.referrer_user_id JOIN users u ON u.id=r.referred_user_id'+bonusScope.where).all(...bonusScope.params);
 const signals=db.prepare('SELECT f.*,u.email FROM referral_fraud_signals f JOIN users u ON u.id=f.user_id ORDER BY f.created_at DESC LIMIT 300').all().filter(f=>!req.query.q||relations.some(r=>r.referrer_user_id===f.user_id||r.referred_user_id===f.user_id));
 const active=relations.filter(r=>db.prepare("SELECT 1 FROM submissions WHERE contributor_id=? AND status='validated' AND reviewed_at>=datetime('now','-30 days') LIMIT 1").get(r.referred_user_id)).length;
 const bonus=bonuses.filter(b=>b.status==='credited').reduce((sum,b)=>sum+b.amount,0),paid=commissions.filter(c=>c.status==='credited').reduce((sum,c)=>sum+c.amount,0),timeline={};
 for(const r of relations){const day=r.created_at.slice(0,10);timeline[day]=(timeline[day]||0)+1;}
 res.json({settings:service.settings(),relations:relations.slice(0,500),commissions:commissions.slice(0,1000),signals,timeline:Object.entries(timeline).sort().map(([date,count])=>({date,count})),stats:{sponsors:new Set(relations.map(r=>r.referrer_user_id)).size,children:relations.length,active_children:active,bonuses:bonus,commissions:paid,pending:commissions.filter(c=>['pending','held'].includes(c.status)).reduce((sum,c)=>sum+c.amount,0),cost:bonus+paid,flagged:signals.filter(s=>s.status==='open').length},limit:500});
}));
router.get('/export',wrap((req,res)=>{
 const s=scope(req.query),rows=db.prepare(relationQuery+s.where+' ORDER BY r.created_at DESC').all(...s.params);
 const quote=value=>'"'+String(value??'').replace(/^[=+@-]/,"'$&").replace(/"/g,'""')+'"';
 const cs=scope(req.query,'COALESCE(c.credited_at,c.created_at)'),bs=scope(req.query,'b.credited_at');
 const commissions=db.prepare('SELECT c.*,r.referral_code,p.name sponsor,u.name child FROM referral_commissions c JOIN referrals r ON r.id=c.referral_id JOIN users p ON p.id=r.referrer_user_id JOIN users u ON u.id=r.referred_user_id'+cs.where+' ORDER BY c.created_at').all(...cs.params).filter(c=>!req.query.commission_status||c.status===req.query.commission_status);
 const bonuses=db.prepare('SELECT b.*,r.referral_code,p.name sponsor,u.name child FROM referral_bonuses b JOIN referrals r ON r.id=b.referral_id JOIN users p ON p.id=r.referrer_user_id JOIN users u ON u.id=r.referred_user_id'+bs.where+' ORDER BY b.created_at').all(...bs.params);
 const lines=[['Type','Identifiant','Code','Parrain','Filleul','Date','Retrait','Part éligible','Montant FCFA','Taux %','Statut'],...rows.map(r=>['relation',r.id,r.referral_code,r.sponsor,r.child,r.created_at,'','','',r.rate_bps/100,r.payments_suspended?'suspended':'active']),...bonuses.map(b=>['bonus',b.id,b.referral_code,b.sponsor,b.child,b.credited_at,'','',b.amount,'',b.status]),...commissions.map(c=>['commission',c.id,c.referral_code,c.sponsor,c.child,c.credited_at||c.created_at,c.withdrawal_id,c.eligible_amount,c.amount,c.rate_bps/100,c.status])];
 audit(req,'export','referrals',null,req.query);res.setHeader('Content-Disposition','attachment; filename="touma-parrainage.csv"');res.type('text/csv; charset=utf-8').send('\ufeff'+lines.map(row=>row.map(quote).join(';')).join('\r\n'));
}));
router.get('/:id/detail',wrap((req,res)=>{
 const relation=db.prepare(relationQuery+' WHERE r.id=?').get(req.params.id);if(!relation)return res.status(404).json({error:'Relation introuvable'});
 res.json({relation,bonuses:db.prepare('SELECT * FROM referral_bonuses WHERE referral_id=?').all(relation.id),commissions:db.prepare('SELECT * FROM referral_commissions WHERE referral_id=?').all(relation.id),transactions:db.prepare('SELECT id,user_id,type,amount,balance_after,reference_id,status,created_at FROM wallet_transactions WHERE user_id IN (?,?) ORDER BY created_at DESC LIMIT 200').all(relation.referrer_user_id,relation.referred_user_id),audit:db.prepare("SELECT * FROM audit_logs WHERE entity_type='referral' AND entity_id=? ORDER BY created_at DESC LIMIT 100").all(relation.id)});
}));
router.put('/settings',wrap((req,res)=>{
 const {bonus,rate_bps,enabled}=req.body;
 if(!Number.isSafeInteger(bonus)||bonus<0||bonus>100000||!Number.isSafeInteger(rate_bps)||rate_bps<0||rate_bps>10000||typeof enabled!=='boolean')throw new Error('Bonus, pourcentage ou activation invalide');
 db.transaction(()=>{db.prepare('INSERT INTO referral_settings(bonus,rate_bps,enabled) VALUES(?,?,?)').run(bonus,rate_bps,enabled?1:0);audit(req,'settings_version','referral',null,{bonus,rate_bps,enabled});}).immediate();res.json(service.settings());
}));
router.put('/:id/suspension',wrap((req,res)=>{
 if(typeof req.body.suspended!=='boolean'||typeof req.body.reason!=='string'||req.body.reason.trim().length<8)throw new Error('Décision et motif requis');
 db.transaction(()=>{
  const relation=db.prepare('SELECT * FROM referrals WHERE id=?').get(req.params.id);if(!relation)throw new Error('Relation introuvable');
  db.prepare('UPDATE referrals SET payments_suspended=?,restriction_reason=? WHERE id=?').run(req.body.suspended?1:0,req.body.reason,relation.id);
  if(!req.body.suspended)for(const c of db.prepare("SELECT withdrawal_id FROM referral_commissions WHERE referral_id=? AND status='held'").all(relation.id))service.releaseCommission(c.withdrawal_id);
  audit(req,'payment_suspension','referral',relation.id,req.body);
 }).immediate();res.json({success:true});
}));
router.put('/signals/:id/review',wrap((req,res)=>{
 if(!['dismissed','confirmed'].includes(req.body.status)||typeof req.body.note!=='string'||req.body.note.trim().length<8)throw new Error('Décision et note de révision requises');
 db.transaction(()=>{const changes=db.prepare('UPDATE referral_fraud_signals SET status=?,review_note=?,reviewed_by=? WHERE id=?').run(req.body.status,req.body.note,req.user.id,req.params.id).changes;if(!changes)throw new Error('Signalement introuvable');audit(req,'fraud_review','fraud_signal',req.params.id,req.body);}).immediate();res.json({success:true});
}));
for(const action of ['confirm','refund'])router.post('/withdrawals/:id/'+action,wrap((req,res)=>{
 const result=db.transaction(()=>{const result=action==='confirm'?service.confirmWithdrawal(req.params.id,req.body.reference,req.body.proof):service.reverseWithdrawal(req.params.id,req.body.reason);audit(req,action==='confirm'?'payment_confirmation':'payment_refund','withdrawal',req.params.id,req.body);return result;}).immediate();res.json(result);
}));
module.exports=router;
