const assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const Database=require('better-sqlite3');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'touma-migration-tests-'));
process.env.TOUMA_DB_PATH=path.join(temp,'legacy.db');
let upgraded;
try{
 const source=fs.readFileSync(path.join(__dirname,'../src/db/database.js'),'utf8');
 const schema=source.match(/function initSchema\(\) \{\s*db\.exec\(`([\s\S]*?)`\);/)[1];
 const legacy=new Database(process.env.TOUMA_DB_PATH);legacy.exec(schema);
 legacy.prepare('INSERT INTO users(id,name,email,password_hash,referral_code) VALUES(?,?,?,?,?)').run('u','Profil existant','legacy@test.local','preserved-hash','legacy');
 legacy.prepare('INSERT INTO organizations(id,name,slug) VALUES(?,?,?)').run('o','Organisation existante','legacy');
 legacy.prepare('INSERT INTO campaigns(id,organization_id,title,description,category,task_type,reward_amount) VALUES(?,?,?,?,?,?,?)').run('c','o','Campagne existante','Description','Terrain','survey',25);
 legacy.prepare('INSERT INTO submissions(id,campaign_id,contributor_id,idempotency_key,answers) VALUES(?,?,?,?,?)').run('s','c','u','stable-key','{"answer":"réponse existante"}');
 legacy.prepare('INSERT INTO wallets(id,user_id,balance,total_earned) VALUES(?,?,?,?)').run('w','u',25,25);
 legacy.prepare('INSERT INTO wallet_transactions(id,wallet_id,user_id,type,amount,balance_after,description,reference_id) VALUES(?,?,?,?,?,?,?,?)').run('tx','w','u','task_reward',25,25,'Crédit existant','s');legacy.close();
 upgraded=require('../src/db/database').db;
 assert.deepEqual(upgraded.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(v=>v.version),[1,2,3,4,5]);
 assert.equal(upgraded.prepare('SELECT balance FROM wallets').get().balance,25);
 assert.equal(upgraded.prepare('SELECT COUNT(*) n FROM wallet_transactions').get().n,1);
 assert.equal(upgraded.prepare('SELECT password_hash FROM users').get().password_hash,'preserved-hash');
 assert.equal(upgraded.prepare('SELECT city_confirmed FROM users').get().city_confirmed,0);
 assert.equal(upgraded.prepare('SELECT answers FROM submission_versions').get().answers,'{"answer":"réponse existante"}');
 assert.equal(upgraded.prepare('SELECT status FROM organizations').get().status,'approved');
 // Restart applies no duplicate migration and does not duplicate versions or credits.
 upgraded.close();delete require.cache[require.resolve('../src/db/database')];upgraded=require('../src/db/database').db;
 assert.equal(upgraded.prepare('SELECT COUNT(*) n FROM submission_versions').get().n,1);
 assert.equal(upgraded.prepare('SELECT COUNT(*) n FROM wallet_transactions').get().n,1);
 assert.equal(upgraded.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 console.log('PASS legacy database upgrade and restart: accounts, responses and credit preserved; five additive migrations, no invented city');
}finally{if(upgraded?.open)upgraded.close();fs.rmSync(temp,{recursive:true,force:true});}
