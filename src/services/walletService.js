class WalletError extends Error { constructor(message) { super(message); this.status=400; } }
const { db } = require('../db/database');
const { v4: uuidv4 } = require('uuid');

/**
 * Validates a submission and credits the contributor's wallet
 */
function validateAndCreditSubmission(submissionId, reviewerId = 'system') {
  // Use SQLite transaction for ACID guarantees
  const tx = db.transaction(() => {
    const sub = db.prepare(`
      SELECT s.*, COALESCE(s.promised_reward, c.reward_amount) as reward_amount, c.title as campaign_title, c.currency
      FROM submissions s
      JOIN campaigns c ON s.campaign_id = c.id
      WHERE s.id = ?
    `).get(submissionId);

    if (!sub) {
      throw new WalletError('Soumission introuvable');
    }

    if (sub.reward_credited) {
      return { success: true, message: 'Déjà validée', sub };
    }
    if(!Number.isSafeInteger(sub.reward_amount) || sub.reward_amount<=0) throw new WalletError('Récompense invalide');

    if (!['submitted', 'under_review'].includes(sub.status)) throw new WalletError('Soumission non validable');

    // 1. Update submission status
    db.prepare(`
      UPDATE submissions
      SET status = 'validated',
          reward_credited = 1,
          reviewer_id = ?,
          reviewed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(reviewerId, submissionId);

    // 2. Fetch or create contributor wallet
    let wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(sub.contributor_id);
    if (!wallet) {
      const newWalletId = 'wal_' + uuidv4();
      db.prepare(`
        INSERT INTO wallets (id, user_id, balance, currency, total_earned, total_withdrawn)
        VALUES (?, ?, 0, 'F CFA', 0, 0)
      `).run(newWalletId, sub.contributor_id);
      wallet = { id: newWalletId, balance: 0, total_earned: 0 };
    }

    const newBalance = wallet.balance + sub.reward_amount;
    const newEarned = wallet.total_earned + sub.reward_amount;

    // 3. Update wallet balance
    db.prepare(`
      UPDATE wallets
      SET balance = ?, total_earned = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(newBalance, newEarned, wallet.id);

    // 4. Insert immutable transaction log
    const txId = 'tx_' + uuidv4();
    db.prepare(`
      INSERT INTO wallet_transactions (
        id, wallet_id, user_id, type, amount, balance_after, description, reference_type, reference_id, status, created_at
      ) VALUES (?, ?, ?, 'task_reward', ?, ?, ?, 'submission', ?, 'completed', CURRENT_TIMESTAMP)
    `).run(
      txId,
      wallet.id,
      sub.contributor_id,
      sub.reward_amount,
      newBalance,
      `Tâche validée : ${sub.campaign_title}`,
      submissionId
    );

    // 5. Update campaign stats
    db.prepare(`
      UPDATE campaigns
      SET completed_submissions = completed_submissions + 1
      WHERE id = ?
    `).run(sub.campaign_id);

    // 6. Send in-app notification
    db.prepare(`
      INSERT INTO notifications (id, user_id, type, title, message, is_read, created_at)
      VALUES (?, ?, 'payment', 'Récompense reçue', ?, 0, CURRENT_TIMESTAMP)
    `).run(
      'notif_' + uuidv4(),
      sub.contributor_id,
      `Vous avez gagné +${sub.reward_amount} F CFA pour la tâche "${sub.campaign_title}"`
    );

    // 7. Update contributor score & reputation level
    updateContributorScore(sub.contributor_id, 5); // +5 points for valid task
    const referral = db.prepare("SELECT * FROM referrals WHERE referred_user_id=? AND status='pending'").get(sub.contributor_id);
    if(referral) {
      const refWallet = db.prepare('SELECT * FROM wallets WHERE user_id=?').get(referral.referrer_user_id);
      if(refWallet && Number.isSafeInteger(referral.bonus_amount) && referral.bonus_amount>0) {
        db.prepare('UPDATE wallets SET balance=balance+?,total_earned=total_earned+? WHERE id=?').run(referral.bonus_amount,referral.bonus_amount,refWallet.id);
        db.prepare("INSERT INTO wallet_transactions(id,wallet_id,user_id,type,amount,balance_after,description,reference_type,reference_id) VALUES(?,?,?,'referral_bonus',?,?,'Première mission validée du filleul','referral',?)").run(uuidv4(),refWallet.id,referral.referrer_user_id,referral.bonus_amount,refWallet.balance+referral.bonus_amount,referral.id);
        db.prepare("UPDATE referrals SET status='rewarded',rewarded_at=CURRENT_TIMESTAMP WHERE id=?").run(referral.id);
      }
    }

    return {
      success: true,
      reward_amount: sub.reward_amount,
      new_balance: newBalance
    };
  });

  return tx.immediate();
}

/**
 * Rejects a submission with a clear, user-friendly reason
 */
function rejectSubmission(submissionId, rejectionReason, reviewerId = 'system') {
  return db.transaction(() => {
    const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId);
    if (!sub) throw new WalletError('Soumission introuvable');
    if (sub.reward_credited || sub.status === 'validated') throw new WalletError('Une soumission créditée ne peut pas être rejetée');
    if (sub.status === 'rejected') return { success: true, already_rejected: true };
    db.prepare("UPDATE submissions SET status='rejected',rejection_reason=?,reviewer_id=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?").run(rejectionReason,reviewerId,submissionId);
    db.prepare("INSERT INTO notifications(id,user_id,type,title,message) VALUES(?,?,'task','Tâche non validée',?)").run(uuidv4(),sub.contributor_id,rejectionReason);
    updateContributorScore(sub.contributor_id,-2);
    return { success: true };
  }).immediate();
}

/**
 * Processes a withdrawal request (Mobile Money: Orange Money, Moov Money, Wave)
 */
function processWithdrawal(userId, amount, operator, phoneNumber, idempotencyKey) {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new WalletError('Montant entier positif requis');
  if (!['Orange Money','Moov Money','Wave'].includes(operator) || typeof phoneNumber !== 'string' || !/^\+?[0-9 ]{8,20}$/.test(phoneNumber)) throw new WalletError('Opérateur ou téléphone invalide');
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 160) throw new WalletError('Identifiant de demande requis');
  const row = db.prepare("SELECT value FROM platform_settings WHERE key='min_withdrawal'").get();
  const minimum = row ? JSON.parse(row.value) : 500;
  if (amount < minimum) throw new WalletError(`Minimum de retrait : ${minimum} F CFA`);
  return db.transaction(() => {
    const prior = db.prepare('SELECT * FROM withdrawals WHERE user_id=? AND idempotency_key=?').get(userId,idempotencyKey);
    if (prior) {
      if (prior.amount !== amount || prior.operator !== operator || prior.phone_number !== phoneNumber) throw new WalletError('Identifiant déjà utilisé pour une autre demande');
      return { success:true, withdrawal_id:prior.id, status:prior.status, is_duplicate_request:true };
    }
    const wallet = db.prepare('SELECT * FROM wallets WHERE user_id=?').get(userId);
    if (!wallet || wallet.balance < amount) throw new WalletError('Solde disponible insuffisant');
    const id = 'wdr_' + uuidv4();
    db.prepare('UPDATE wallets SET balance=balance-?,reserved_balance=reserved_balance+?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(amount,amount,wallet.id);
    db.prepare("INSERT INTO withdrawals(id,user_id,amount,net_amount,operator,phone_number,status,idempotency_key) VALUES(?,?,?,?,?,?,'pending',?)").run(id,userId,amount,amount,operator,phoneNumber,idempotencyKey);
    db.prepare("INSERT INTO wallet_transactions(id,wallet_id,user_id,type,amount,balance_after,description,reference_type,reference_id,status) VALUES(?,?,?,'withdrawal',?,?,?,'withdrawal',?,'pending')").run(uuidv4(),wallet.id,userId,-amount,wallet.balance-amount,`Fonds réservés : ${operator}`,id);
    db.prepare("INSERT INTO notifications(id,user_id,type,title,message) VALUES(?,?,'payment','Demande de retrait enregistrée',?)").run(uuidv4(),userId,'Fonds réservés. Paiement non confirmé ; intégration du prestataire requise.');
    return { success:true,withdrawal_id:id,status:'pending',new_balance:wallet.balance-amount,amount,payment_confirmed:false };
  }).immediate();
}

/**
 * Updates contributor score and recalculates tier
 */
function updateContributorScore(userId, delta) {
  const user = db.prepare('SELECT reputation_score FROM users WHERE id = ?').get(userId);
  if (!user) return;

  const newScore = Math.max(0, user.reputation_score + delta);
  let newLevel = 'Débutant';
  if (newScore >= 200) newLevel = 'Expert';
  else if (newScore >= 150) newLevel = 'Confirmé';
  else if (newScore >= 80) newLevel = 'Fiable';

  db.prepare(`
    UPDATE users
    SET reputation_score = ?, reputation_level = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(newScore, newLevel, userId);
}

module.exports = {
  validateAndCreditSubmission,
  rejectSubmission,
  processWithdrawal,
  updateContributorScore
};
