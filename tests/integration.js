const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const crypto=require('crypto');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'touma-tests-'));
process.env.TOUMA_DB_PATH=path.join(temp,'test.db');
const app=require('../src/server');
const {db}=require('../src/db/database');
const {hashPassword,createSession}=require('../src/middleware/auth');
const server=app.listen(0,'127.0.0.1');
let passed=0;const uploadNames=[];
async function run(){
 await new Promise(resolve=>server.listening?resolve():server.once('listening',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 async function call(route,{token,method='GET',body,status=200}={}){
  const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});
  const data=await r.json();assert.equal(r.status,status,`${method} ${route}: ${JSON.stringify(data)}`);return data;
 }
 async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
 function account(id,role){db.prepare('INSERT INTO users(id,name,email,password_hash,role,referral_code) VALUES(?,?,?,?,?,?)').run(id,id,id+'@test.local',hashPassword('test-password-123'),role,id);return createSession(id);}
 const admin=account('admin','admin'),business=account('business','business'),otherBusiness=account('other-business','business');
 db.prepare("INSERT INTO organizations(id,name,slug,status) VALUES(?,?,?,'approved')").run('org','Test organisation','org');
 db.prepare('INSERT INTO organization_members(id,organization_id,user_id) VALUES(?,?,?)').run('member','org','business');
 let contributor,other,photo;
 await test('Authentication: anonymous/header forgery denied, register/login/session revoke',async()=>{
  await call('/api/auth/me',{status:401});
  const forged=await fetch(base+'/api/admin/stats',{headers:{'x-user-id':'admin'}});assert.equal(forged.status,401);
  contributor=(await call('/api/auth/register',{method:'POST',body:{name:'Contributor',email:'contributor@test.local',password:'test-password-123'},status:201})).token;
  other=(await call('/api/auth/register',{method:'POST',body:{name:'Other',email:'other@test.local',password:'test-password-123'},status:201})).token;
  const logged=await call('/api/auth/login',{method:'POST',body:{email:'contributor@test.local',password:'test-password-123'}});
  await call('/api/auth/logout',{method:'POST',token:logged.token});await call('/api/auth/me',{token:logged.token,status:401});
  assert.equal((await call('/api/wallet',{token:contributor})).wallet.balance,0);
 });
 await test('Server permissions: contributor cannot create, review, configure or edit wallet',async()=>{
  await call('/api/campaigns',{method:'POST',token:contributor,body:{title:'illegal'},status:403});
  await call('/api/submissions',{token:contributor,status:403});
  await call('/api/submissions/no/validate',{method:'POST',token:contributor,status:403});
  await call('/api/admin/settings',{token:contributor,status:403});
  const res=await fetch(base+'/api/wallet',{method:'PUT',headers:{Authorization:'Bearer '+contributor,'Content-Type':'application/json'},body:'{"balance":99999}'});assert.equal(res.status,404);
 });
 async function campaign(reward,schema,geo={},auto=false,type='survey'){
  const created=await call('/api/campaigns',{method:'POST',token:business,body:{title:'Integration campaign',description:'Real test fixture, isolated database',category:'Enquêtes',task_type:type,reward_amount:reward,total_budget_amount:1000,form_schema:schema,geo_rules:geo,validation_rules:{auto_validate:auto,max_per_user:20}},status:201});
  await call('/api/admin/campaigns/'+created.campaign_id+'/status',{method:'PUT',token:admin,body:{status:'active'}});
  return created.campaign_id;
 }
 const merchantSchema=[{id:'store_name',type:'short_text',label:'Nom',required:true},{id:'merchant_phone',type:'phone',label:'Téléphone',required:true},{id:'photo',type:'photo',label:'Photo',required:true},{id:'gps',type:'gps',label:'GPS',required:true}];
 await test('Evidence: authenticated upload, private access and actual file ownership',async()=>{
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFoQAAAAASUVORK5CYII=','base64');
  const f=new FormData();f.append('photo',new Blob([bytes],{type:'image/png'}),'proof.png');
  const r=await fetch(base+'/api/upload',{method:'POST',headers:{Authorization:'Bearer '+contributor},body:f});assert.equal(r.status,200);photo=await r.json();uploadNames.push(photo.filename);
  assert.equal((await fetch(base+photo.url)).status,401);
  assert.equal((await fetch(base+photo.url,{headers:{Authorization:'Bearer '+other}})).status,403);
  assert.equal((await fetch(base+photo.url,{headers:{Authorization:'Bearer '+contributor}})).status,200);
 });
 let merchantId,subId;
 await test('YAAR+ 25 F CFA: campaign, photo/GPS answers, review, exact persistent reward',async()=>{
  merchantId=await campaign(25,merchantSchema,{required:true},false,'free_roam');
  const loc={lat:12.3686,lng:-1.5275,accuracy:6};
  const result=await call('/api/submissions',{method:'POST',token:contributor,body:{campaign_id:merchantId,idempotency_key:crypto.randomUUID(),answers:{store_name:'Commerce test',merchant_phone:'+22670123456',gps:loc},location:loc,evidence:[{field_id:'photo',url:photo.url}]},status:201});
  subId=result.submission_id;assert.equal(result.reward_credited,false);
  assert.equal((await call('/api/wallet',{token:contributor})).pending_earnings,25);
  await call('/api/submissions/'+subId+'/validate',{method:'POST',token:admin});
  const wallet=await call('/api/wallet',{token:contributor});assert.equal(wallet.wallet.balance,25);assert.equal(wallet.transactions.length,1);
  const reopened=new (require('better-sqlite3'))(process.env.TOUMA_DB_PATH,{readonly:true});assert.equal(reopened.prepare('SELECT balance FROM wallets WHERE user_id=?').get(wallet.wallet.user_id).balance,25);reopened.close();
 });
 await test('Financial security: concurrent double validation, rejected transition, immutable reward',async()=>{
  await Promise.all(Array.from({length:8},()=>call('/api/submissions/'+subId+'/validate',{method:'POST',token:admin})));
  await call('/api/submissions/'+subId+'/reject',{method:'POST',token:admin,body:{reason:'retry exploit'},status:400});
  await call('/api/submissions/'+subId+'/validate',{method:'POST',token:admin});
  assert.equal((await call('/api/wallet',{token:contributor})).wallet.balance,25);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM wallet_transactions WHERE reference_id=? AND type='task_reward'").get(subId).n,1);
 });
 await test('Survey 100 F CFA: no GPS, strict boolean/rating/comment, auto-validation pays',async()=>{
  const id=await campaign(100,[{id:'yes',type:'boolean',label:'Oui/non',required:true},{id:'rating',type:'rating',label:'Note',required:true},{id:'comment',type:'long_text',label:'Commentaire',required:true}],{},true);
  await call('/api/submissions',{method:'POST',token:contributor,body:{campaign_id:id,idempotency_key:crypto.randomUUID(),answers:{yes:'true',rating:9,comment:'invalid'}},status:400});
  const result=await call('/api/submissions',{method:'POST',token:contributor,body:{campaign_id:id,idempotency_key:crypto.randomUUID(),answers:{yes:false,rating:5,comment:'Avis test'}},status:201});assert.equal(result.reward_credited,true);
  assert.equal((await call('/api/wallet',{token:contributor})).wallet.balance,125);
 });
 await test('Field target: GPS zone enforced and required photo preserved',async()=>{
  const id=await campaign(25,merchantSchema,{required:true,target_coords:{lat:12.3686,lng:-1.5275},radius_m:50},false,'target_point');
  const make=loc=>({campaign_id:id,idempotency_key:crypto.randomUUID(),answers:{store_name:'Target',merchant_phone:'+22670987654',gps:loc},location:loc,evidence:[{field_id:'photo',url:photo.url}]});
  await call('/api/submissions',{method:'POST',token:contributor,body:make({lat:13,lng:-1}),status:400});
  const result=await call('/api/submissions',{method:'POST',token:contributor,body:make({lat:12.3686,lng:-1.5275}),status:201});
  await call('/api/submissions/'+result.submission_id+'/validate',{method:'POST',token:admin});
  assert.equal((await call('/api/wallet',{token:contributor})).wallet.balance,150);
 });
 await test('Offline batch API: invalid item refused, stable replay once, ownership enforced',async()=>{
  const id=await campaign(100,[{id:'answer',type:'short_text',label:'Réponse',required:true}],{},false);
  const item={campaign_id:id,idempotency_key:crypto.randomUUID(),local_id:'local-durable',answers:{answer:'Saved offline'}};
  const invalid={...item,local_id:'invalid',idempotency_key:crypto.randomUUID(),answers:{}};
  const result=await call('/api/submissions/batch-sync',{method:'POST',token:contributor,body:{queue:[item,invalid]}});
  assert.equal(result.results[0].status,'synced');assert.equal(result.results[1].status,'error');
  await Promise.all(Array.from({length:5},()=>call('/api/submissions/batch-sync',{method:'POST',token:contributor,body:{queue:[item]}})));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM submissions WHERE idempotency_key=?').get(item.idempotency_key).n,1);
  await call('/api/submissions',{method:'POST',token:other,body:item,status:400});
 });
 await test('Business isolation: unrelated organisation cannot list or review results',async()=>{
  assert.equal((await call('/api/submissions',{token:otherBusiness})).length,0);
  assert.equal((await call('/api/business/stats',{token:otherBusiness})).total_submissions,0);
  await call('/api/submissions/'+subId+'/validate',{method:'POST',token:otherBusiness,status:403});
  assert.equal((await call('/api/campaigns',{token:otherBusiness})).length,0);
 });
 await test('Withdrawals: pending reservation, idempotence, cancellation, no fake payment',async()=>{
  await call('/api/admin/settings',{method:'PUT',token:admin,body:{min_withdrawal:50}});
  const data={amount:50,operator:'Orange Money',phone_number:'+22670123456',idempotency_key:crypto.randomUUID()};
  await call('/api/wallet/withdraw',{method:'POST',token:contributor,body:{...data,amount:50.5},status:400});
  const result=await call('/api/wallet/withdraw',{method:'POST',token:contributor,body:data});assert.equal(result.status,'pending');assert.equal(result.payment_confirmed,false);
  await call('/api/wallet/withdraw',{method:'POST',token:contributor,body:data});
  const w=await call('/api/wallet',{token:contributor});assert.equal(w.wallet.balance,100);assert.equal(w.wallet.reserved_balance,50);assert.equal(w.wallet.total_withdrawn,0);
  await call('/api/admin/withdrawals/'+result.withdrawal_id+'/reject',{method:'POST',token:admin,body:{reason:'Provider not configured'}});
  assert.equal((await call('/api/wallet',{token:contributor})).wallet.balance,150);
  await call('/api/admin/withdrawals/'+result.withdrawal_id+'/reject',{method:'POST',token:admin,status:400});
 });
 await test('Admin management: roles, organisations, warning, settings, audit and suspension persist',async()=>{
  const list=await call('/api/admin/users',{token:admin});const uid=list.find(u=>u.email==='other@test.local').id;
  await call('/api/admin/users/'+uid+'/role',{method:'PUT',token:admin,body:{role:'business'}});
  const org=await call('/api/admin/organizations',{method:'POST',token:admin,body:{name:'Organisation créée par API',owner_id:uid},status:201});
  assert((await call('/api/organizations',{token:other})).some(x=>x.id===org.id));
  await call('/api/admin/users/'+uid+'/warning',{method:'POST',token:admin,body:{message:'Contrôle réel des preuves'}});
  const notifs=await call('/api/notifications',{token:other});assert.equal(notifs.length,1);
  await call('/api/notifications/'+notifs[0].id+'/read',{method:'PUT',token:other});assert.equal((await call('/api/notifications',{token:other}))[0].is_read,1);
  assert((await call('/api/admin/audit',{token:admin})).length>0);
  await call('/api/admin/users/'+uid+'/suspension',{method:'PUT',token:admin,body:{suspended:true}});
  await call('/api/auth/me',{token:other,status:401});
 });
 await test('Dynamic forms: conditional branches, strict dates, choices and consent',async()=>{
  const {validateDynamicForm,validateSchema}=require('../src/services/formRules');
  const schema=[{id:'open',type:'boolean',label:'Ouvert',required:true},{id:'hours',type:'time',label:'Heure',required:true,condition:{field_id:'open',operator:'equals',value:true}},{id:'closed_reason',type:'text',label:'Raison',required:true,condition:{field_id:'open',value:false}},{id:'date',type:'date',label:'Date',required:true},{id:'consent',type:'consent',label:'Consentement',required:true},{id:'choices',type:'multiple_choice',label:'Choix',options:['a','b'],required:true}];
  assert.deepEqual(validateSchema(schema),[]);
  assert.equal(validateDynamicForm(schema,{open:false,closed_reason:'Fermé',date:'2026-10-08',consent:true,choices:['a']}).is_valid,true);
  assert.equal(validateDynamicForm(schema,{open:true,hours:'99:99',date:'2026-02-31',consent:false,choices:['other']}).is_valid,false);
  assert.equal(validateDynamicForm([{id:'photo',type:'photo',label:'Photo',required:true}],{},[{field_id:'wrong',url:photo.url}]).is_valid,false);
 });
 await test('Financial reservations: concurrent requests cannot overspend; refunds are atomic',async()=>{
  const make=()=>call('/api/wallet/withdraw',{method:'POST',token:contributor,body:{amount:100,operator:'Wave',phone_number:'+22670123456',idempotency_key:crypto.randomUUID()},status:200});
  const requests=await Promise.allSettled([make(),make()]);assert.equal(requests.filter(x=>x.status==='fulfilled').length,1);
  const w=await call('/api/wallet',{token:contributor});assert.equal(w.wallet.balance,50);assert.equal(w.wallet.reserved_balance,100);
  const id=requests.find(x=>x.status==='fulfilled').value.withdrawal_id;
  await call('/api/admin/withdrawals/'+id+'/reject',{method:'POST',token:admin});assert.equal((await call('/api/wallet',{token:contributor})).wallet.balance,150);
 });
 console.log(`${passed} integration scenarios passed; database isolated: ${temp}`);
}
run().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{
 server.close();db.close();
 for(const name of uploadNames)fs.unlinkSync(path.join(__dirname,'../uploads',name));
 fs.rmSync(temp,{recursive:true,force:true});
});
