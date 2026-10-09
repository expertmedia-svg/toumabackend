const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'touma-saas-tests-'));
process.env.TOUMA_DB_PATH=path.join(temp,'test.db');
const app=require('../src/server'),{db}=require('../src/db/database'),{hashPassword,createSession}=require('../src/middleware/auth');
const server=app.listen(0,'127.0.0.1');let passed=0;const documents=[],media=[];
async function run(){
 await new Promise(r=>server.listening?r():server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 const account=(id,role)=>{db.prepare('INSERT INTO users(id,name,email,password_hash,role,referral_code) VALUES(?,?,?,?,?,?)').run(id,id,id+'@test.local',hashPassword('test-password-123'),role,id);return createSession(id);};
 const superAdmin=account('super','super_admin'),admin=account('admin','admin'),manager=account('manager','study_manager'),quality=account('quality','quality_controller'),business=account('client','business'),other=account('other','business'),viewer=account('viewer','business_collaborator'),contributor=account('contributor','contributor');
 db.prepare('INSERT INTO wallets(id,user_id) VALUES(?,?)').run('wallet','contributor');
 for(const [org,user] of [['org-a','client'],['org-b','other']]){db.prepare("INSERT INTO organizations(id,name,slug,status) VALUES(?,?,?,'approved')").run(org,org,org);db.prepare('INSERT INTO organization_members(id,organization_id,user_id) VALUES(?,?,?)').run(org,org,user);}
 db.prepare("INSERT INTO organization_members(id,organization_id,user_id,role) VALUES(?,?,?,'viewer')").run('viewer-member','org-a','viewer');
 async function call(route,{token=admin,body,method='GET',status=200}={}){const r=await fetch(base+'/api'+route,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});let data;try{data=await r.json();}catch{data={};}assert.equal(r.status,status,method+' '+route+' '+JSON.stringify(data));return data;}
 async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
 const campaignPayload={organization_id:'org-a',title:'Satisfaction réelle',description:'Questionnaire collecté pour les tests',category:'Satisfaction',task_type:'survey',reward_amount:25,total_budget_amount:250,max_submissions:10,geo_rules:{required:false},validation_rules:{allow_bulk:true,max_per_user:10},form_schema:[{id:'satisfied',label:'Êtes-vous satisfait ?',type:'boolean',required:true},{id:'rating',label:'Note',type:'rating',required:true},{id:'comment',label:'Commentaire',type:'long_text',condition:{field_id:'satisfied',operator:'equals',value:false},required:true}]};
 let campaignId,studyId,proposalId,reportId,subId;
 await test('Professional web authentication excludes contributors and creates only pending businesses',async()=>{
  await call('/auth/login-web',{method:'POST',body:{email:'contributor@test.local',password:'test-password-123'},status:403});
  await call('/auth/login',{method:'POST',body:{email:'contributor@test.local',password:'test-password-123'}});
  const registered=await call('/auth/register-enterprise',{method:'POST',body:{name:'Entreprise nouvelle',company_name:'Organisation nouvelle',email:'new-company@test.local',password:'test-password-123',role:'super_admin'},status:201});
  assert.equal(db.prepare('SELECT role FROM users WHERE id=?').get(registered.user_id).role,'business');
  assert.equal(db.prepare('SELECT o.status FROM organizations o JOIN organization_members m ON m.organization_id=o.id WHERE m.user_id=?').get(registered.user_id).status,'pending');
 });
 await test('Roles and pagination: specialized roles enforced; collaborator cannot mutate',async()=>{
  assert.equal((await call('/saas/context',{token:superAdmin})).user.role,'super_admin');
  await call('/saas/settings',{token:manager,method:'PUT',body:{monthly_validation_goal:100},status:403});
  await call('/saas/finance',{token:quality,status:403});
  await call('/saas/studies',{token:quality,status:403});
  await call('/saas/campaigns',{token:viewer,method:'POST',body:campaignPayload,status:403});
  await call('/campaigns',{token:viewer,method:'POST',body:campaignPayload,status:403});
  await call('/saas/campaigns?page_size=1000',{token:business,status:400});
  await call('/saas/users/manager/role',{token:admin,method:'PUT',body:{role:'super_admin'},status:403});
  await call('/saas/settings',{token:superAdmin,method:'PUT',body:{monthly_validation_goal:100,min_withdrawal:1,referral_reward:0}});
 });
 await test('Profile geography: default city is never a declared response region',async()=>{
  assert.equal((await call('/auth/me',{token:contributor})).user.city,'');
  assert.equal((await call('/saas/context',{token:business})).user.city,'');
  await call('/auth/profile',{token:contributor,method:'PUT',body:{name:'Contributeur réel de test',city:'Bobo-Dioulasso',phone:'+22670001122'}});
  assert.equal((await call('/auth/me',{token:contributor})).user.city,'Bobo-Dioulasso');
  await call('/admin/users/super/suspension',{token:admin,method:'PUT',body:{suspended:true},status:403});
 });
 await test('Autonomous campaign: server draft, update, approval, mobile eligibility and calendar',async()=>{
  campaignId=(await call('/saas/campaigns',{token:business,method:'POST',body:{...campaignPayload,save_draft:true},status:201})).id;
  assert.equal((await call('/campaigns',{token:contributor})).length,0);
  await call('/saas/campaigns/'+campaignId,{token:business,method:'PUT',body:{objective:'Mesurer la satisfaction'}});
  await call('/saas/campaigns/'+campaignId+'/status',{token:business,method:'POST',body:{status:'pending_approval'}});
  await call('/saas/campaigns/'+campaignId+'/status',{token:business,method:'POST',body:{status:'active'},status:403});
  await call('/saas/campaigns/'+campaignId+'/status',{token:admin,method:'POST',body:{status:'active'}});
  assert.equal((await call('/campaigns',{token:contributor}))[0].id,campaignId);
  const future=(await call('/saas/campaigns',{token:business,method:'POST',body:{...campaignPayload,title:'Future',starts_at:'2099-01-01',ends_at:'2099-12-31'},status:201})).id;
  await call('/saas/campaigns/'+future+'/status',{method:'POST',body:{status:'active'}});
  assert.equal((await call('/campaigns',{token:contributor})).some(c=>c.id===future),false);
  await call('/campaigns/'+future,{token:contributor,status:404});
  await call('/submissions',{token:contributor,method:'POST',body:{campaign_id:future,idempotency_key:crypto.randomUUID(),answers:{satisfied:true,rating:5}},status:400});
 });
 await test('Generic mobile submission, quality review and exact reward once under concurrent retries',async()=>{
  subId=(await call('/submissions',{token:contributor,method:'POST',body:{campaign_id:campaignId,idempotency_key:crypto.randomUUID(),answers:{satisfied:false,rating:3,comment:'À améliorer'}},status:201})).submission_id;
  await Promise.all(Array.from({length:4},()=>call('/saas/submissions/'+subId+'/review',{token:quality,method:'POST',body:{action:'validate'}})));
  assert.equal((await call('/wallet',{token:contributor})).wallet.balance,25);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM wallet_transactions WHERE type='task_reward'").get().n,1);
  await call('/saas/submissions/'+subId+'/review',{token:quality,method:'POST',body:{action:'reject',reason:'Après crédit'},status:400});
  await call('/saas/campaigns/'+campaignId,{token:business,method:'PUT',body:{reward_amount:999},status:400});
  const analysis=await call('/saas/campaigns/'+campaignId+'/analysis',{token:business});assert.equal(analysis.validated,1);assert.equal(analysis.questions.find(q=>q.id==='rating').mean,3);
 });
 await test('Bulk quality: all-or-nothing rules, correction and audit history',async()=>{
  const make=async()=> (await call('/submissions',{token:contributor,method:'POST',body:{campaign_id:campaignId,idempotency_key:crypto.randomUUID(),answers:{satisfied:true,rating:4}},status:201})).submission_id;
  const a=await make(),b=await make();
  await call('/saas/submissions/'+b+'/review',{token:quality,method:'POST',body:{action:'flag',reason:'À vérifier'}});
  await call('/saas/submissions/bulk-validate',{token:quality,method:'POST',body:{ids:[a,b]},status:400});assert.equal(db.prepare('SELECT reward_credited FROM submissions WHERE id=?').get(a).reward_credited,0);
  await call('/saas/submissions/bulk-validate',{token:quality,method:'POST',body:{ids:[a]}});
  await call('/saas/submissions/'+b+'/review',{token:quality,method:'POST',body:{action:'correction',reason:'Préciser la réponse'}});
  assert.equal(db.prepare('SELECT status FROM submissions WHERE id=?').get(b).status,'correction_requested');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM submission_reviews WHERE submission_id=?').get(b).n,2);
  const original=db.prepare('SELECT * FROM submissions WHERE id=?').get(b);
  const revision={campaign_id:campaignId,idempotency_key:original.idempotency_key,resubmit:true,revision_key:crypto.randomUUID(),answers:{satisfied:true,rating:5}};
  const corrected=await call('/submissions',{token:contributor,method:'POST',body:revision,status:201});assert.equal(corrected.submission_id,b);assert.equal(corrected.status,'under_review');
  await call('/submissions',{token:contributor,method:'POST',body:revision,status:201});assert.equal(db.prepare('SELECT COUNT(*) n FROM submission_versions WHERE submission_id=?').get(b).n,2);
  await call('/saas/submissions/'+b+'/review',{token:quality,method:'POST',body:{action:'validate'}});
  assert.equal(db.prepare("SELECT COUNT(*) n FROM wallet_transactions WHERE reference_id=? AND type='task_reward'").get(b).n,1);
 });
 await test('Turnkey study: reference, internal note, proposal draft visibility, send and client acceptance',async()=>{
  const study=await call('/saas/studies',{token:business,method:'POST',body:{organization_id:'org-a',title:'Étude clé en main',sector:'Services',product:'Service local',objectives:'Mesurer la satisfaction',key_questions:'Quels besoins ?',target_population:'Clients',regions:'Ouagadougou',sample_size:10,indicative_budget:1000,desired_date:'2026-12-01'},status:201});studyId=study.id;assert.ok(study.reference.startsWith('ETU-'));
  await call('/saas/studies/'+studyId,{token:manager,method:'PUT',body:{status:'analyzing',assigned_to:'manager'}});
  await call('/saas/studies/'+studyId+'/events',{token:manager,method:'POST',body:{body:'Note confidentielle interne',internal:true},status:201});
  await call('/saas/studies/'+studyId+'/events',{token:business,method:'POST',body:{body:'Précision client'},status:201});
  proposalId=(await call('/saas/studies/'+studyId+'/proposals',{token:manager,method:'POST',body:{title:'Proposition version 1',scope:'Collecter dix réponses',methodology:'Questionnaire et contrôle qualité',amount:1000,sample_size:10,delivery_date:'2026-12-01'},status:201})).id;
  const privateView=await call('/saas/studies/'+studyId,{token:business});assert.equal(privateView.proposals.length,0);assert.equal(privateView.events.some(e=>e.internal),false);
  assert.equal((await fetch(base+'/api/saas/proposals/'+proposalId+'/pdf',{headers:{Authorization:'Bearer '+business}})).status,403);
  await call('/saas/proposals/'+proposalId+'/send',{token:manager,method:'POST'});
  await call('/saas/proposals/'+proposalId+'/decision',{token:viewer,method:'POST',body:{decision:'accepted'},status:403});
  assert.equal((await call('/saas/proposals/'+proposalId+'/decision',{token:business,method:'POST',body:{decision:'accepted'}})).payment_confirmed,false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices').get().n,0);
 });
 await test('Turnkey conversion idempotent; collection, validation and persistent report',async()=>{
  const converted=await call('/saas/studies/'+studyId+'/campaign',{token:manager,method:'POST',body:{...campaignPayload,title:'Collecte étude clé en main'},status:201});
  assert.equal((await call('/saas/studies/'+studyId+'/campaign',{token:manager,method:'POST',body:campaignPayload})).id,converted.id);
  await call('/saas/campaigns/'+converted.id+'/status',{method:'POST',body:{status:'active'}});
  await call('/saas/studies/'+studyId,{token:manager,method:'PUT',body:{status:'executing'}});
  const contribution=await call('/submissions',{token:contributor,method:'POST',body:{campaign_id:converted.id,idempotency_key:crypto.randomUUID(),answers:{satisfied:true,rating:5}},status:201});
  await call('/saas/submissions/'+contribution.submission_id+'/review',{token:quality,method:'POST',body:{action:'validate'}});
  reportId=(await call('/saas/reports',{token:manager,method:'POST',body:{campaign_id:converted.id,study_id:studyId},status:201})).id;
  const snapshot=await call('/saas/reports/'+reportId,{token:business});assert.equal(snapshot.snapshot.analysis.validated,1);assert.equal(snapshot.snapshot.responses[0].answers.rating,5);
  await call('/saas/studies/'+studyId,{token:manager,method:'PUT',body:{status:'completed'}});
 });
 await test('Real exports: PDF signatures, CSV answers, Excel workbook parsed and proposal PDF',async()=>{
  for(const format of ['pdf','csv','xlsx']){
   const r=await fetch(base+'/api/saas/reports/'+reportId+'/export?format='+format,{headers:{Authorization:'Bearer '+business}});assert.equal(r.status,200);const bytes=Buffer.from(await r.arrayBuffer());
   if(format==='pdf')assert.equal(bytes.subarray(0,5).toString(),'%PDF-');
   if(format==='csv'){assert.ok(bytes.toString().includes('Réponses JSON'));assert.ok(bytes.toString().includes('rating'));}
   if(format==='xlsx'){const workbook=new (require('exceljs').Workbook)();await workbook.xlsx.load(bytes);assert.equal(workbook.getWorksheet('Contributions').getCell('E2').value,'validated');}
  }
  const r=await fetch(base+'/api/saas/proposals/'+proposalId+'/pdf',{headers:{Authorization:'Bearer '+business}});assert.equal(r.status,200);assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0,5).toString(),'%PDF-');
 });
 await test('Strict tenant isolation across studies, reports, exports, members and writes',async()=>{
  await call('/saas/studies/'+studyId,{token:other,status:403});await call('/saas/reports/'+reportId,{token:other,status:403});
  assert.equal((await call('/saas/reports',{token:other})).total,0);
  await call('/saas/organizations/org-a/members',{token:other,status:403});
  await call('/saas/campaigns/'+campaignId+'/analysis',{token:other,status:403});
  await call('/saas/studies/'+studyId+'/events',{token:other,method:'POST',body:{body:'Intrusion'},status:403});
  assert.equal((await fetch(base+'/api/saas/reports/'+reportId+'/export',{headers:{Authorization:'Bearer '+other}})).status,403);
 });
 await test('Private commercial documents: persisted PDF metadata, internal and tenant access',async()=>{
  const form=new FormData();form.append('document',new Blob([Buffer.from('%PDF-1.4\n% Test fixture document\n%%EOF')],{type:'application/pdf'}),'contract.pdf');form.append('study_id',studyId);form.append('internal','true');
  const r=await fetch(base+'/api/saas/documents',{method:'POST',headers:{Authorization:'Bearer '+manager},body:form});assert.equal(r.status,201);const uploaded=await r.json();const stored=db.prepare('SELECT * FROM business_documents WHERE id=?').get(uploaded.id);documents.push(stored.filename);
  assert.equal((await fetch(base+'/api/saas/documents/'+uploaded.id+'/download',{headers:{Authorization:'Bearer '+business}})).status,403);
  assert.equal((await fetch(base+'/api/saas/documents/'+uploaded.id+'/download',{headers:{Authorization:'Bearer '+manager}})).status,200);
  assert.equal((await call('/saas/studies/'+studyId,{token:business})).documents.length,0);
 });
 await test('Finance reconciliation, pending withdrawal cancellation and invoice never paid',async()=>{
  assert.equal((await call('/saas/finance')).discrepancies.length,0);
  const w=await call('/wallet/withdraw',{token:contributor,method:'POST',body:{amount:25,operator:'Orange Money',phone_number:'+22670123456',idempotency_key:crypto.randomUUID()}});
  assert.equal((await call('/saas/finance')).discrepancies.length,0);
  await call('/admin/withdrawals/'+w.withdrawal_id+'/reject',{method:'POST',body:{reason:'Annulation de test'}});
  assert.equal((await call('/saas/finance')).discrepancies.length,0);
  const invoice=await call('/saas/invoices',{token:manager,method:'POST',body:{organization_id:'org-a',study_id:studyId,description:'Prestation',amount:1000},status:201});assert.equal(invoice.status,'unpaid');
  assert.equal((await call('/saas/invoices',{token:business})).items[0].provider_reference,null);
  const dashboard=await call('/saas/dashboard');assert.equal(dashboard.kpis.payments_completed,0);assert.equal(dashboard.monthly_goal,100);
 });
 await test('Audio evidence: actual WAV bytes persist and specialized quality access remains private',async()=>{
  const audioCampaign=(await call('/saas/campaigns',{token:business,method:'POST',body:{...campaignPayload,title:'Collecte audio',form_schema:[{id:'voice',label:'Enregistrement',type:'audio',required:true}]},status:201})).id;
  await call('/saas/campaigns/'+audioCampaign+'/status',{method:'POST',body:{status:'active'}});
  const wav=Buffer.alloc(204);wav.write('RIFF');wav.writeUInt32LE(196,4);wav.write('WAVE',8);wav.write('fmt ',12);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(160,40);
  const form=new FormData();form.append('photo',new Blob([wav],{type:'audio/wav'}),'test.wav');
  const uploaded=await fetch(base+'/api/upload',{method:'POST',headers:{Authorization:'Bearer '+contributor},body:form});assert.equal(uploaded.status,200);const proof=await uploaded.json();media.push(proof.filename);
  const id=(await call('/submissions',{token:contributor,method:'POST',body:{campaign_id:audioCampaign,idempotency_key:crypto.randomUUID(),answers:{voice:proof.url},evidence:[{field_id:'voice',url:proof.url}]},status:201})).submission_id;
  for(const token of [quality,manager,business]){const read=await fetch(base+proof.url,{headers:{Authorization:'Bearer '+token}});assert.equal(read.status,200);assert.equal(read.headers.get('content-type'),'audio/wav');assert.deepEqual(Buffer.from(await read.arrayBuffer()),wav);}
  assert.equal((await fetch(base+proof.url,{headers:{Authorization:'Bearer '+other}})).status,403);
  assert.equal((await call('/saas/submissions?campaign_id='+audioCampaign,{token:quality})).items[0].id,id);
 });
 await test('Support requests, messages and read-only collaborator; organization suspension enforced',async()=>{
  const ticket=await call('/saas/support',{token:business,method:'POST',body:{organization_id:'org-a',subject:'Question',message:'Besoin de précisions'},status:201});
  await call('/saas/support/'+ticket.id,{token:manager,method:'PUT',body:{response:'Réponse réelle',status:'answered'}});
  assert.equal((await call('/saas/support',{token:viewer})).items[0].response,'Réponse réelle');
  await call('/saas/organizations/org-a',{method:'PUT',body:{status:'suspended'}});
  await call('/saas/context',{token:business,status:403});
  await call('/submissions',{token:contributor,method:'POST',body:{campaign_id:campaignId,idempotency_key:crypto.randomUUID(),answers:{satisfied:true,rating:3}},status:400});
 });
 console.log(passed+' SaaS integration scenarios passed');
}
run().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await new Promise(r=>server.close(r));db.close();for(const filename of media)fs.unlinkSync(path.join(__dirname,'../uploads',filename));for(const filename of documents)fs.unlinkSync(path.join(__dirname,'../private-documents',filename));fs.rmSync(temp,{recursive:true,force:true});});
