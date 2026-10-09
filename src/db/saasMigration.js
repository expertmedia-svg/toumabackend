module.exports = function migrateSaas(db) {
  db.transaction(() => {
    if (db.prepare('SELECT version FROM schema_migrations WHERE version=2').get()) return;
    db.exec(`
      ALTER TABLE organizations ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
      ALTER TABLE organizations ADD COLUMN address TEXT;
      ALTER TABLE organizations ADD COLUMN registration_number TEXT;
      ALTER TABLE campaigns ADD COLUMN objective TEXT NOT NULL DEFAULT '';
      ALTER TABLE campaigns ADD COLUMN target_population TEXT NOT NULL DEFAULT '';
      ALTER TABLE campaigns ADD COLUMN geographic_zone TEXT NOT NULL DEFAULT '';
      ALTER TABLE campaigns ADD COLUMN starts_at TEXT;
      ALTER TABLE campaigns ADD COLUMN ends_at TEXT;
      ALTER TABLE campaigns ADD COLUMN published_at TEXT;
      UPDATE organizations SET status=CASE WHEN is_verified=1 THEN 'approved' ELSE 'pending' END;
      UPDATE campaigns SET published_at=created_at WHERE status IN ('active','paused','completed');
      CREATE TABLE studies (
        id TEXT PRIMARY KEY, reference TEXT UNIQUE NOT NULL, organization_id TEXT NOT NULL REFERENCES organizations(id),
        created_by TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, sector TEXT NOT NULL,
        product TEXT NOT NULL, objectives TEXT NOT NULL, key_questions TEXT NOT NULL,
        target_population TEXT NOT NULL, regions TEXT NOT NULL, sample_size INTEGER NOT NULL,
        indicative_budget INTEGER NOT NULL, desired_date TEXT, status TEXT NOT NULL DEFAULT 'new',
        assigned_to TEXT REFERENCES users(id), campaign_id TEXT REFERENCES campaigns(id),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE study_events (
        id TEXT PRIMARY KEY, study_id TEXT NOT NULL REFERENCES studies(id), user_id TEXT NOT NULL REFERENCES users(id),
        kind TEXT NOT NULL, body TEXT NOT NULL, internal INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE proposals (
        id TEXT PRIMARY KEY, study_id TEXT NOT NULL REFERENCES studies(id), version INTEGER NOT NULL,
        title TEXT NOT NULL, scope TEXT NOT NULL, methodology TEXT NOT NULL,
        amount INTEGER NOT NULL, sample_size INTEGER NOT NULL, delivery_date TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft', created_by TEXT NOT NULL REFERENCES users(id),
        decided_by TEXT REFERENCES users(id), decided_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(study_id,version)
      );
      CREATE TABLE business_documents (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), study_id TEXT REFERENCES studies(id),
        uploaded_by TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL, filename TEXT UNIQUE NOT NULL,
        original_name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
        internal INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE reports (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), campaign_id TEXT NOT NULL REFERENCES campaigns(id),
        study_id TEXT REFERENCES studies(id), title TEXT NOT NULL, snapshot TEXT NOT NULL,
        methodology TEXT NOT NULL, limitations TEXT NOT NULL, conclusions TEXT NOT NULL, recommendations TEXT NOT NULL,
        created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE invoices (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), study_id TEXT REFERENCES studies(id),
        reference TEXT UNIQUE NOT NULL, description TEXT NOT NULL, amount INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'unpaid', due_date TEXT, provider_reference TEXT,
        created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE support_tickets (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), created_by TEXT NOT NULL REFERENCES users(id),
        subject TEXT NOT NULL, message TEXT NOT NULL, response TEXT, status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE submission_reviews (
        id TEXT PRIMARY KEY, submission_id TEXT NOT NULL REFERENCES submissions(id), user_id TEXT NOT NULL REFERENCES users(id),
        action TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX idx_studies_org ON studies(organization_id,status);
      CREATE INDEX idx_reports_org ON reports(organization_id,created_at);
      CREATE INDEX idx_documents_org ON business_documents(organization_id,study_id);
      CREATE INDEX idx_study_events ON study_events(study_id,created_at);
      CREATE INDEX idx_submissions_time ON submissions(submitted_at);
      CREATE INDEX idx_campaigns_org ON campaigns(organization_id,status);
      INSERT INTO schema_migrations(version) VALUES(2);
    `);
  }).immediate();
};
