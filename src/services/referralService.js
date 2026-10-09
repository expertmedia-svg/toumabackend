const crypto=require('crypto');
const {db}=require('../db/database');
const id=()=>crypto.randomUUID();
function fail(message,status=400){throw Object.assign(new Error(message),{status});}
function settings(){return db.prepare('SELECT * FROM referral_settings ORDER BY version DESC LIMIT 1').get();}
function notify(user,title,message){db.prepare("INSERT INTO notifications(id,user_id,type,title,message) VALUES(?,?,'payment',?,?)").run(id(),user,title,message);}
function credit(user,amount,type,reference,description){
  if(!Number.isSafeInteger(amount)||amount<=0)fail('Crédit invalide');
  let wallet=db.prepare('SELECT * FROM wallets WHERE user_id=?').get(user);
  if(!wallet){db.prepare('INSERT INTO wallets(id,user_id) VALUES(?,?)').run(id(),user);wallet=db.prepare('SELECT * FROM wallets WHERE user_id=?').get(user);}
  db.prepare('UPDATE wallets SET balance=balance+?,total_earned=total_earned+?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(amount,amount,wallet.id);
  const transaction=id();
  db.prepare('INSERT INTO wallet_transactions(id,wallet_id,user_id,type,amount,balance_after,description,reference_type,reference_id) VALUES(?,?,?,?,?,?,?,\'referral\',?)').run(transaction,wallet.id,user,type,amount,wallet.balance+amount,description,reference);
  addLot(user,type,transaction,amount);
}
function addLot(user,type,source,amount){db.prepare('INSERT OR IGNORE INTO wallet_funding_lots(id,user_id,source_type,source_id,remaining) VALUES(?,?,?,?,?)').run(id(),user,type,source,amount);}
function validateCode(code){
  const normalized=typeof code==='string'?code.trim().toUpperCase():'';
  if(!/^[A-Z0-9_-]{3,32}$/.test(normalized))fail('Code de parrainage invalide');
  const user=db.prepare('SELECT * FROM users WHERE UPPER(referral_code)=? AND role=\'contributor\' AND is_suspended=0').get(normalized);
  if(!user)fail('Code de parrainage invalide ou indisponible');
  if(!settings().enabled)fail('Le programme est temporairement indisponible');
  return user;
}
function registerReferral(user,code,req){
  const sponsor=validateCode(code);
  if(sponsor.id===user.id||sponsor.email===user.email||(user.phone&&sponsor.phone&&normalizePhone(user.phone)===normalizePhone(sponsor.phone)))fail('Auto-parrainage interdit');
  const rule=settings(),relation=id();
  db.prepare("INSERT INTO referrals(id,referrer_user_id,referred_user_id,referral_code,bonus_amount,rate_bps,program_version,status) VALUES(?,?,?,?,?,?,?,'active')").run(relation,sponsor.id,user.id,sponsor.referral_code,rule.bonus,rule.rate_bps,rule.version);
  if(rule.bonus>0){
    const bonus=id();
    db.prepare("INSERT INTO referral_bonuses(id,referral_id,user_id,amount,status,credited_at) VALUES(?,?,?,?,'credited',CURRENT_TIMESTAMP)").run(bonus,relation,user.id,rule.bonus);
    credit(user.id,rule.bonus,'referral_welcome',bonus,'Bonus de bienvenue avec code de parrainage');
    notify(user.id,'Bienvenue sur TOUMA !',`Votre bonus de parrainage de ${rule.bonus} F CFA a été crédité.`);
  }
  notify(sponsor.id,'Un nouveau filleul !','Bonne nouvelle ! Un nouvel utilisateur a rejoint TOUMA avec votre code de parrainage.');
  const ipHash=crypto.createHash('sha256').update(req.ip||'unknown').digest('hex');
  db.prepare('INSERT INTO referral_registration_signals(user_id,ip_hash) VALUES(?,?)').run(user.id,ipHash);
  const count=db.prepare("SELECT COUNT(*) n FROM referral_registration_signals WHERE ip_hash=? AND created_at>=datetime('now','-1 hour')").get(ipHash).n;
  if(count>=5)db.prepare("INSERT INTO referral_fraud_signals(id,user_id,kind,details) VALUES(?,?,'shared_registration_network',?)").run(id(),user.id,JSON.stringify({count,note:'Connexion partagée : analyse humaine requise, aucun blocage automatique.'}));
  return rule.bonus;
}
function normalizePhone(phone){const digits=String(phone||'').replace(/\D/g,'');return digits.length===8?'226'+digits:digits.replace(/^00/,'');}
function synchronizeLots(user){
  // Adopt newly credited mission/legacy transactions (also preserves external service integrations).
  for(const t of db.prepare("SELECT t.* FROM wallet_transactions t LEFT JOIN wallet_funding_lots l ON l.source_id=t.id WHERE t.user_id=? AND t.amount>0 AND t.status='completed' AND t.reference_type IS NOT 'withdrawal_reversal' AND l.id IS NULL ORDER BY t.created_at,t.rowid").all(user))addLot(user,t.type,t.id,t.amount);
  const wallet=db.prepare('SELECT * FROM wallets WHERE user_id=?').get(user);
  const remaining=db.prepare('SELECT COALESCE(SUM(remaining),0) n FROM wallet_funding_lots WHERE user_id=?').get(user).n;
  if(remaining<wallet.balance)addLot(user,'unclassified',id(),wallet.balance-remaining);
  if(remaining>wallet.balance)fail('Le registre de provenance nécessite une réconciliation',409);
}
function allocateWithdrawal(user,withdrawal,amount){
  synchronizeLots(user);
  let needed=amount,eligible=0;
  for(const lot of db.prepare('SELECT * FROM wallet_funding_lots WHERE user_id=? AND remaining>0 ORDER BY created_at,rowid').all(user)){
    const used=Math.min(needed,lot.remaining);
    db.prepare('UPDATE wallet_funding_lots SET remaining=remaining-? WHERE id=?').run(used,lot.id);
    db.prepare('INSERT INTO withdrawal_allocations VALUES(?,?,?)').run(withdrawal,lot.id,used);
    if(lot.source_type==='task_reward')eligible+=used;
    needed-=used;if(!needed)break;
  }
  if(needed)fail('Provenance des fonds insuffisante',409);
  db.prepare('UPDATE withdrawals SET eligible_amount=? WHERE id=?').run(eligible,withdrawal);
  const relation=db.prepare('SELECT * FROM referrals WHERE referred_user_id=?').get(user);
  if(relation&&eligible>0){const amount=Number(BigInt(eligible)*BigInt(relation.rate_bps)/10000n);if(amount>0)db.prepare("INSERT INTO referral_commissions(id,referral_id,withdrawal_id,user_id,eligible_amount,rate_bps,amount) VALUES(?,?,?,?,?,?,?)").run(id(),relation.id,withdrawal,relation.referrer_user_id,eligible,relation.rate_bps,amount);}
  const recent=db.prepare("SELECT COUNT(*) n FROM withdrawals WHERE user_id=? AND created_at>=datetime('now','-1 hour')").get(user).n;
  if(recent>=3||amount>=50000)db.prepare("INSERT INTO referral_fraud_signals(id,user_id,kind,details) VALUES(?,?,'withdrawal_activity',?)").run(id(),user,JSON.stringify({withdrawal,amount,recent,note:'Signal indicatif : vérifier le contexte avant toute suspension.'}));
}
function restoreAllocations(withdrawal){for(const allocation of db.prepare('SELECT * FROM withdrawal_allocations WHERE withdrawal_id=?').all(withdrawal))db.prepare('UPDATE wallet_funding_lots SET remaining=remaining+? WHERE id=?').run(allocation.amount,allocation.lot_id);}
function releaseCommission(withdrawal){
  const row=db.prepare('SELECT c.*,r.payments_suspended,u.is_suspended FROM referral_commissions c JOIN referrals r ON r.id=c.referral_id JOIN users u ON u.id=c.user_id WHERE withdrawal_id=?').get(withdrawal);
  if(!row||['credited','cancelled','reversed'].includes(row.status))return;
  const payment=db.prepare('SELECT status FROM withdrawals WHERE id=?').get(withdrawal);
  if(payment.status!=='completed')return;
  if(row.payments_suspended||row.is_suspended){db.prepare("UPDATE referral_commissions SET status='held' WHERE id=?").run(row.id);return;}
  credit(row.user_id,row.amount,'referral_commission',row.id,'Commission de parrainage sur retrait confirmé');
  db.prepare("UPDATE referral_commissions SET status='credited',credited_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id);
  notify(row.user_id,'Commission reçue !',`Félicitations ! Vous avez gagné ${row.amount} F CFA grâce au retrait d'un de vos filleuls.`);
}
function confirmWithdrawal(withdrawal,reference,proof){return db.transaction(()=>{
  if(typeof reference!=='string'||reference.trim().length<6||reference.length>200||typeof proof!=='string'||proof.trim().length<12||proof.length>2000)fail('Référence réelle du paiement et justificatif requis');
  const w=db.prepare('SELECT * FROM withdrawals WHERE id=?').get(withdrawal);if(!w)fail('Retrait introuvable',404);
  if(w.status==='completed'){if(w.transaction_reference!==reference.trim())fail('Retrait déjà confirmé avec une autre référence',409);return {success:true,duplicate:true};}
  if(!['pending','processing'].includes(w.status))fail('Retrait non confirmable');
  const blocked=db.prepare('SELECT 1 FROM referrals WHERE referred_user_id=? AND payments_suspended=1').get(w.user_id);if(blocked)fail('Paiement suspendu pour examen administratif',409);
  db.prepare("UPDATE withdrawals SET status='completed',transaction_reference=?,payment_proof=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(reference.trim(),proof.trim(),w.id);
  const changed=db.prepare('UPDATE wallets SET reserved_balance=reserved_balance-?,total_withdrawn=total_withdrawn+? WHERE user_id=? AND reserved_balance>=?').run(w.amount,w.amount,w.user_id,w.amount).changes;
  if(!changed)fail('Réservation incohérente : réconciliation requise',409);
  db.prepare("UPDATE wallet_transactions SET status='completed' WHERE reference_id=? AND type='withdrawal'").run(w.id);
  releaseCommission(w.id);
  notify(w.user_id,'Retrait confirmé',`Votre retrait de ${w.net_amount} F CFA a été confirmé.`);
  return {success:true,payment_confirmed:true};
}).immediate();}
function rejectWithdrawal(withdrawal,reason){return db.transaction(()=>{
  const w=db.prepare('SELECT * FROM withdrawals WHERE id=?').get(withdrawal);if(!w)fail('Retrait introuvable',404);
  if(['rejected','failed'].includes(w.status))return {success:true,duplicate:true};
  if(!['pending','processing'].includes(w.status))fail('Retrait non annulable');
  const wallet=db.prepare('SELECT * FROM wallets WHERE user_id=?').get(w.user_id);
  db.prepare("UPDATE withdrawals SET status='rejected',failure_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(reason,w.id);
  db.prepare('UPDATE wallets SET balance=balance+?,reserved_balance=reserved_balance-? WHERE user_id=?').run(w.amount,w.amount,w.user_id);
  db.prepare("UPDATE wallet_transactions SET status='failed' WHERE reference_id=? AND type='withdrawal'").run(w.id);
  db.prepare("INSERT INTO wallet_transactions(id,wallet_id,user_id,type,amount,balance_after,description,reference_type,reference_id) VALUES(?,?,?,'adjustment',?,?,'Libération des fonds réservés','withdrawal_reversal',?)").run(id(),wallet.id,w.user_id,w.amount,wallet.balance+w.amount,w.id);
  restoreAllocations(w.id);
  db.prepare("UPDATE referral_commissions SET status='cancelled' WHERE withdrawal_id=? AND status IN ('pending','held')").run(w.id);
  notify(w.user_id,'Retrait annulé',reason);return {success:true};
}).immediate();}
function reverseWithdrawal(withdrawal,reason){return db.transaction(()=>{
  const w=db.prepare('SELECT * FROM withdrawals WHERE id=?').get(withdrawal);if(w?.status==='refunded')return {success:true,duplicate:true};if(!w||w.status!=='completed')fail('Retrait confirmé requis');
  if(typeof reason!=='string'||reason.trim().length<12)fail('Justificatif de remboursement requis');
  const commission=db.prepare('SELECT * FROM referral_commissions WHERE withdrawal_id=?').get(w.id);
  if(commission?.status==='credited'){
    synchronizeLots(commission.user_id);
    const tx=db.prepare("SELECT id FROM wallet_transactions WHERE type='referral_commission' AND reference_id=?").get(commission.id);
    const lot=db.prepare('SELECT * FROM wallet_funding_lots WHERE source_id=?').get(tx.id);
    if(!lot||lot.remaining<commission.amount)fail('Commission déjà dépensée ou réservée : annulez les réservations ou recouvrez les fonds avant régularisation',409);
    const wallet=db.prepare('SELECT * FROM wallets WHERE user_id=?').get(commission.user_id);
    db.prepare('UPDATE wallet_funding_lots SET remaining=remaining-? WHERE id=?').run(commission.amount,lot.id);
    db.prepare('UPDATE wallets SET balance=balance-?,total_earned=total_earned-? WHERE id=?').run(commission.amount,commission.amount,wallet.id);
    db.prepare("INSERT INTO wallet_transactions(id,wallet_id,user_id,type,amount,balance_after,description,reference_type,reference_id) VALUES(?,?,?,'referral_commission_reversal',?,?,'Régularisation du parrainage','referral',?)").run(id(),wallet.id,commission.user_id,-commission.amount,wallet.balance-commission.amount,commission.id);
  }
  if(commission)db.prepare("UPDATE referral_commissions SET status='reversed' WHERE id=?").run(commission.id);
  const wallet=db.prepare('SELECT * FROM wallets WHERE user_id=?').get(w.user_id);
  db.prepare('UPDATE wallets SET balance=balance+?,total_withdrawn=total_withdrawn-? WHERE id=?').run(w.amount,w.amount,wallet.id);
  db.prepare("INSERT INTO wallet_transactions(id,wallet_id,user_id,type,amount,balance_after,description,reference_type,reference_id) VALUES(?,?,?,'adjustment',?,?,'Remboursement du retrait confirmé','withdrawal_reversal',?)").run(id(),wallet.id,w.user_id,w.amount,wallet.balance+w.amount,w.id);
  restoreAllocations(w.id);db.prepare("UPDATE withdrawals SET status='refunded',failure_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(reason,w.id);
  return {success:true};
}).immediate();}
function summary(user,query={}){
  const offset=Number(query.offset||0);if(!Number.isSafeInteger(offset)||offset<0||offset>1000000)fail('Page invalide');
  const rule=settings();
  const relations=db.prepare('SELECT r.*,u.is_suspended FROM referrals r JOIN users u ON u.id=r.referrer_user_id WHERE r.referrer_user_id=? OR r.referred_user_id=?').all(user.id,user.id);
  const children=relations.filter(r=>r.referrer_user_id===user.id);
  const commissions=db.prepare(`SELECT c.id,c.eligible_amount,c.rate_bps,c.amount,c.status,c.created_at,c.credited_at,'Filleul '||SUBSTR(r.id,1,8) AS filleul FROM referral_commissions c JOIN referrals r ON r.id=c.referral_id WHERE c.user_id=? ORDER BY c.created_at DESC,c.rowid DESC LIMIT 200 OFFSET ?`).all(user.id,offset);
  const totals=db.prepare("SELECT COALESCE(SUM(CASE WHEN status='credited' THEN amount ELSE 0 END),0) earned,COALESCE(SUM(CASE WHEN status IN ('pending','held') THEN amount ELSE 0 END),0) pending FROM referral_commissions WHERE user_id=?").get(user.id);
  const active=db.prepare("SELECT COUNT(DISTINCT r.referred_user_id) n FROM referrals r JOIN submissions s ON s.contributor_id=r.referred_user_id WHERE r.referrer_user_id=? AND s.status='validated' AND s.reviewed_at>=datetime('now','-30 days')").get(user.id).n;
  const historyCount=db.prepare('SELECT COUNT(*) n FROM referral_commissions WHERE user_id=?').get(user.id).n;
  return {next_offset:offset+200<historyCount?offset+200:null,commissions_count:historyCount,program_enabled:!!rule.enabled,referral_code:user.referral_code,bonus_amount:rule.bonus,rate_bps:rule.rate_bps,duration:'lifetime',level:1,rounding:'floor',referrals_count:children.length,active_referrals:active,total_commissions:totals.earned,pending_commissions:totals.pending,commissions,restricted:relations.some(r=>r.payments_suspended||r.is_suspended),welcome_bonus:db.prepare('SELECT amount,status FROM referral_bonuses WHERE user_id=?').get(user.id)||null,share_url:null,synced_at:new Date().toISOString()};
}
module.exports={settings,validateCode,registerReferral,normalizePhone,addLot,allocateWithdrawal,restoreAllocations,releaseCommission,confirmWithdrawal,rejectWithdrawal,reverseWithdrawal,summary};
