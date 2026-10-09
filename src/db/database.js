const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const uploadsDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Preserve the demonstration database; new installations start empty.
const dbPath = process.env.TOUMA_DB_PATH || path.join(dataDir, 'touma-live.db');
const db = new Database(dbPath);

// Enable WAL mode and foreign keys for high performance and integrity
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initSchema() {
  db.exec(`
    -- USERS
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      phone TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'contributor', -- 'contributor', 'business', 'admin'
      country TEXT NOT NULL DEFAULT 'Burkina Faso',
      country_code TEXT NOT NULL DEFAULT 'BF',
      city TEXT NOT NULL DEFAULT 'Ouagadougou',
      avatar_url TEXT,
      reputation_level TEXT NOT NULL DEFAULT 'Débutant', -- 'Débutant', 'Fiable', 'Confirmé', 'Expert'
      reputation_score INTEGER NOT NULL DEFAULT 100,
      referral_code TEXT UNIQUE NOT NULL,
      is_verified INTEGER NOT NULL DEFAULT 0,
      is_suspended INTEGER NOT NULL DEFAULT 0,
      suspension_reason TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- ORGANIZATIONS (Clients/Businesses)
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      description TEXT,
      logo_url TEXT,
      industry TEXT,
      balance INTEGER NOT NULL DEFAULT 0, -- Org budget balance in F CFA
      contact_email TEXT,
      contact_phone TEXT,
      is_verified INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- ORGANIZATION MEMBERS
    CREATE TABLE IF NOT EXISTS organization_members (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'owner', -- 'owner', 'manager', 'viewer'
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- CAMPAIGNS (Generic micro-task campaigns)
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL, -- 'Terrain', 'Enquêtes', 'Photos', 'Vérification', 'Digital', 'Vidéos', 'Apps', 'Autres'
      task_type TEXT NOT NULL, -- 'free_roam', 'geo_zone', 'target_point', 'digital', 'survey'
      reward_amount INTEGER NOT NULL, -- Amount in F CFA credited to user
      currency TEXT NOT NULL DEFAULT 'F CFA',
      total_budget_amount INTEGER NOT NULL DEFAULT 100000,
      max_submissions INTEGER NOT NULL DEFAULT 1000,
      completed_submissions INTEGER NOT NULL DEFAULT 0,
      estimated_duration_min INTEGER NOT NULL DEFAULT 5,
      status TEXT NOT NULL DEFAULT 'active', -- 'draft', 'pending_approval', 'active', 'paused', 'completed'
      
      -- Configurable Rules (JSON)
      geo_rules TEXT NOT NULL DEFAULT '{}',       -- { required: bool, radius_m: number, duplicate_dist_m: number, target_coords: {lat, lng} }
      eligibility_rules TEXT NOT NULL DEFAULT '{}', -- { min_reputation: 'Débutant', countries: ['BF'] }
      validation_rules TEXT NOT NULL DEFAULT '{}',  -- { auto_validate: bool, duplicate_check: bool, max_per_user: 50 }
      evidence_rules TEXT NOT NULL DEFAULT '{}',    -- { camera_only: bool, min_photos: 1, max_photos: 3 }
      
      -- Generic Dynamic Form Schema
      form_schema TEXT NOT NULL DEFAULT '[]',     -- Array of Field definitions
      instructions_text TEXT,
      icon_name TEXT DEFAULT 'play',
      badge_color TEXT DEFAULT 'green',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
    );

    -- SUBMISSIONS (Micro-task submissions)
    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      contributor_id TEXT NOT NULL,
      idempotency_key TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'submitted', -- 'draft', 'pending_sync', 'submitted', 'under_review', 'validated', 'rejected'
      rejection_reason TEXT,
      answers TEXT NOT NULL DEFAULT '{}',       -- JSON answers mapping field_id => value
      evidence TEXT NOT NULL DEFAULT '[]',      -- JSON array of photo/file URLs with metadata
      location TEXT NOT NULL DEFAULT '{}',      -- JSON { lat, lng, accuracy, timestamp, is_mock }
      device_info TEXT NOT NULL DEFAULT '{}',   -- JSON { user_agent, platform, ip }
      fraud_flags TEXT NOT NULL DEFAULT '[]',   -- JSON array of raised flags
      fraud_score INTEGER NOT NULL DEFAULT 0,   -- 0 (clean) to 100 (high risk)
      reward_credited INTEGER NOT NULL DEFAULT 0,
      reviewer_id TEXT,
      reviewed_at TEXT,
      submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
      FOREIGN KEY (contributor_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- WALLETS
    CREATE TABLE IF NOT EXISTS wallets (
      id TEXT PRIMARY KEY,
      user_id TEXT UNIQUE NOT NULL,
      balance INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'F CFA',
      total_earned INTEGER NOT NULL DEFAULT 0,
      total_withdrawn INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- WALLET TRANSACTIONS (Persistent wallet journal)
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id TEXT PRIMARY KEY,
      wallet_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL, -- 'task_reward', 'withdrawal', 'referral_bonus', 'adjustment'
      amount INTEGER NOT NULL, -- positive for credits, negative for debits
      balance_after INTEGER NOT NULL,
      description TEXT NOT NULL,
      reference_type TEXT, -- 'submission', 'withdrawal', 'referral'
      reference_id TEXT,
      status TEXT NOT NULL DEFAULT 'completed', -- 'completed', 'pending', 'failed'
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- WITHDRAWALS
    CREATE TABLE IF NOT EXISTS withdrawals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      fee INTEGER NOT NULL DEFAULT 0,
      net_amount INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'F CFA',
      operator TEXT NOT NULL, -- 'Orange Money', 'Moov Money', 'Wave'
      phone_number TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'rejected'
      failure_reason TEXT,
      transaction_reference TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- REFERRALS
    CREATE TABLE IF NOT EXISTS referrals (
      id TEXT PRIMARY KEY,
      referrer_user_id TEXT NOT NULL,
      referred_user_id TEXT NOT NULL UNIQUE,
      referral_code TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'rewarded'
      bonus_amount INTEGER NOT NULL DEFAULT 500,
      rewarded_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (referrer_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (referred_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- NOTIFICATIONS
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'system', -- 'task', 'payment', 'system'
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      data TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- FRAUD SIGNALS
    CREATE TABLE IF NOT EXISTS fraud_signals (
      id TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      signal_type TEXT NOT NULL, -- 'duplicate_coords', 'duplicate_phone', 'speed_anomaly', 'mock_location', 'low_accuracy'
      severity TEXT NOT NULL DEFAULT 'medium', -- 'low', 'medium', 'high'
      details TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- AUDIT LOGS
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      details TEXT NOT NULL DEFAULT '{}',
      ip_address TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- PLATFORM SETTINGS
    CREATE TABLE IF NOT EXISTS platform_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Create helpful indexes
    CREATE INDEX IF NOT EXISTS idx_submissions_campaign ON submissions(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_submissions_contributor ON submissions(contributor_id);
    CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
    CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
    CREATE INDEX IF NOT EXISTS idx_transactions_user ON wallet_transactions(user_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
  `);
}

initSchema();

db.pragma('busy_timeout = 5000');
db.exec(`
 CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS evidence_files (filename TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), mime_type TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
`);
db.transaction(() => {
 if (!db.prepare('SELECT version FROM schema_migrations WHERE version = 1').get()) {
  db.exec(`ALTER TABLE submissions ADD COLUMN promised_reward INTEGER;
   ALTER TABLE wallets ADD COLUMN reserved_balance INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE withdrawals ADD COLUMN idempotency_key TEXT;
   CREATE UNIQUE INDEX idx_withdrawal_idempotency ON withdrawals(user_id, idempotency_key);
   CREATE UNIQUE INDEX idx_reward_once ON wallet_transactions(reference_id) WHERE type = 'task_reward';
   INSERT INTO schema_migrations(version) VALUES (1);`);
 }
}).immediate();

require('./saasMigration')(db);
db.transaction(()=>{
 if(db.prepare('SELECT version FROM schema_migrations WHERE version=3').get())return;
 db.exec(`CREATE TABLE submission_versions (
  id TEXT PRIMARY KEY,submission_id TEXT NOT NULL REFERENCES submissions(id),revision_key TEXT NOT NULL,
  answers TEXT NOT NULL,evidence TEXT NOT NULL,location TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(submission_id,revision_key));
  INSERT INTO submission_versions(id,submission_id,revision_key,answers,evidence,location) SELECT id||'_v1',id,COALESCE(idempotency_key,id),answers,evidence,location FROM submissions;
  INSERT INTO schema_migrations(version) VALUES(3);`);
}).immediate();

db.transaction(()=>{
 if(db.prepare('SELECT version FROM schema_migrations WHERE version=4').get())return;
 db.exec('ALTER TABLE users ADD COLUMN city_confirmed INTEGER NOT NULL DEFAULT 0; INSERT INTO schema_migrations(version) VALUES(4);');
}).immediate();

module.exports = {
  db,
  initSchema
};
