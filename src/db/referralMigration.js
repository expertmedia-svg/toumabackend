module.exports = db => db.transaction(() => {
  if (db.prepare('SELECT version FROM schema_migrations WHERE version=5').get()) return;
  db.exec(`
    ALTER TABLE users ADD COLUMN phone_verified_at TEXT;
    ALTER TABLE users ADD COLUMN normalized_phone TEXT;
    ALTER TABLE referrals ADD COLUMN rate_bps INTEGER NOT NULL DEFAULT 1000;
    ALTER TABLE referrals ADD COLUMN program_version INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE referrals ADD COLUMN payments_suspended INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE referrals ADD COLUMN restriction_reason TEXT;
    ALTER TABLE withdrawals ADD COLUMN eligible_amount INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE withdrawals ADD COLUMN payment_proof TEXT;
    CREATE TABLE referral_codes(user_id TEXT PRIMARY KEY REFERENCES users(id),code TEXT NOT NULL UNIQUE);
    INSERT INTO referral_codes SELECT id,referral_code FROM users;
    CREATE TABLE referral_settings(version INTEGER PRIMARY KEY AUTOINCREMENT,bonus INTEGER NOT NULL,rate_bps INTEGER NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO referral_settings(bonus,rate_bps) VALUES(100,1000);
    CREATE TABLE verified_phone_claims(phone TEXT PRIMARY KEY,user_id TEXT NOT NULL UNIQUE REFERENCES users(id),verified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE phone_challenges(user_id TEXT PRIMARY KEY REFERENCES users(id),phone TEXT NOT NULL,code_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,sent_at INTEGER NOT NULL);
    CREATE TABLE registration_requests(request_key TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),payload_hash TEXT NOT NULL);
    CREATE TABLE referral_bonuses(id TEXT PRIMARY KEY,referral_id TEXT NOT NULL UNIQUE REFERENCES referrals(id),user_id TEXT NOT NULL UNIQUE REFERENCES users(id),amount INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending_activation',credited_at TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE referral_commissions(id TEXT PRIMARY KEY,referral_id TEXT NOT NULL REFERENCES referrals(id),withdrawal_id TEXT NOT NULL UNIQUE REFERENCES withdrawals(id),user_id TEXT NOT NULL REFERENCES users(id),eligible_amount INTEGER NOT NULL,rate_bps INTEGER NOT NULL,amount INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',credited_at TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE wallet_funding_lots(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),source_type TEXT NOT NULL,source_id TEXT NOT NULL UNIQUE,remaining INTEGER NOT NULL CHECK(remaining>=0),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE withdrawal_allocations(withdrawal_id TEXT NOT NULL REFERENCES withdrawals(id),lot_id TEXT NOT NULL REFERENCES wallet_funding_lots(id),amount INTEGER NOT NULL CHECK(amount>0),PRIMARY KEY(withdrawal_id,lot_id));
    CREATE TABLE referral_fraud_signals(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL,details TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',review_note TEXT,reviewed_by TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE referral_registration_signals(user_id TEXT PRIMARY KEY REFERENCES users(id),ip_hash TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE UNIQUE INDEX referral_bonus_once ON wallet_transactions(reference_id) WHERE type='referral_welcome';
    CREATE UNIQUE INDEX referral_commission_once ON wallet_transactions(reference_id) WHERE type='referral_commission';
    CREATE UNIQUE INDEX referral_commission_reversal_once ON wallet_transactions(reference_id) WHERE type='referral_commission_reversal';
    INSERT INTO schema_migrations(version) VALUES(5);
  `);
  const seenPhones=new Set();
  for(const user of db.prepare('SELECT id,phone FROM users WHERE phone IS NOT NULL ORDER BY created_at,rowid').all()){
    const digits=user.phone.replace(/\D/g,'');const phone=digits.length===8?'226'+digits:digits.replace(/^00/,'');
    if(!phone)continue;
    if(seenPhones.has(phone)){db.prepare("INSERT INTO referral_fraud_signals(id,user_id,kind,details) VALUES(?,?,'legacy_shared_phone',?)").run('legacy_phone_'+user.id,user.id,'Anciens comptes partageant un numéro : contrôle humain, aucun blocage automatique.');continue;}
    seenPhones.add(phone);db.prepare('UPDATE users SET normalized_phone=? WHERE id=?').run(phone,user.id);
  }
  db.exec('CREATE UNIQUE INDEX unique_normalized_phone ON users(normalized_phone) WHERE normalized_phone IS NOT NULL');
  // Preserve existing money. Only identifiable mission credits remain commissionable.
  for (const wallet of db.prepare('SELECT * FROM wallets').all()) {
    const credits=db.prepare("SELECT * FROM wallet_transactions WHERE user_id=? AND amount>0 AND status='completed' AND reference_type IS NOT 'withdrawal_reversal' ORDER BY created_at,rowid").all(wallet.user_id);
    let total=0;
    for(const credit of credits){db.prepare('INSERT INTO wallet_funding_lots(id,user_id,source_type,source_id,remaining,created_at) VALUES(?,?,?,?,?,?)').run(credit.id,wallet.user_id,credit.type,credit.id,credit.amount,credit.created_at);total+=credit.amount;}
    const available=wallet.balance+wallet.reserved_balance;
    if(total<available)db.prepare("INSERT INTO wallet_funding_lots(id,user_id,source_type,source_id,remaining) VALUES(?,?,'legacy_unknown',?,?)").run('legacy_'+wallet.id,wallet.user_id,'legacy_'+wallet.id,available-total);
    let spent=Math.max(0,total-available);
    for(const lot of db.prepare('SELECT * FROM wallet_funding_lots WHERE user_id=? ORDER BY created_at,rowid').all(wallet.user_id)){const used=Math.min(spent,lot.remaining);if(used)db.prepare('UPDATE wallet_funding_lots SET remaining=remaining-? WHERE id=?').run(used,lot.id);spent-=used;}
    for(const w of db.prepare("SELECT * FROM withdrawals WHERE user_id=? AND status IN ('pending','processing') ORDER BY created_at,rowid").all(wallet.user_id)){
      let needed=w.amount;
      for(const lot of db.prepare('SELECT * FROM wallet_funding_lots WHERE user_id=? AND remaining>0 ORDER BY created_at,rowid').all(wallet.user_id)){const amount=Math.min(needed,lot.remaining);db.prepare('UPDATE wallet_funding_lots SET remaining=remaining-? WHERE id=?').run(amount,lot.id);db.prepare('INSERT INTO withdrawal_allocations VALUES(?,?,?)').run(w.id,lot.id,amount);needed-=amount;if(!needed)break;}
      // No retroactive commission on withdrawals requested before this migration.
    }
  }
}).immediate();
