const assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),{execFileSync}=require('child_process');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'touma-yaar-'));
process.env.TOUMA_DB_PATH=path.join(temp,'test.db');process.env.TOUMA_CREDENTIALS_PATH=path.join(temp,'credentials.txt');
let db,server;
(async()=>{
 try{
  const setup=()=>JSON.parse(execFileSync(process.execPath,[path.resolve(__dirname,'../scripts/configurer-yaar.js')],{env:process.env,encoding:'utf8'}));
  const first=setup(),saved=fs.readFileSync(process.env.TOUMA_CREDENTIALS_PATH,'utf8'),second=setup();
  assert.equal(first.new_accounts,2);assert.equal(second.new_accounts,0);assert.equal(second.campaign_id,first.campaign_id);assert.equal(fs.readFileSync(process.env.TOUMA_CREDENTIALS_PATH,'utf8'),saved);
  db=require('../src/db/database').db;
  assert.equal(db.prepare('SELECT COUNT(*) n FROM wallet_transactions').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM submissions').get().n,0);
  const campaign=db.prepare('SELECT * FROM campaigns').get(),schema=JSON.parse(campaign.form_schema);
  assert.equal(campaign.status,'active');assert.equal(campaign.reward_amount,25);assert.equal(campaign.total_budget_amount,100000);assert.equal(campaign.max_submissions,4000);assert.equal(JSON.parse(campaign.geo_rules).required,true);assert.equal(JSON.parse(campaign.validation_rules).auto_validate,false);
  const {validateDynamicForm}=require('../src/services/formRules'),answers={shop_name:'Commerce de test',shop_phone:'+22670001122',shop_city:'Bobo-Dioulasso',shop_gps:{lat:11.18,lng:-4.29}};
  const proofs=schema.filter(f=>f.type==='photo').map(f=>({field_id:f.id,url:'/uploads/test-'+f.id+'.png'}));
  assert.equal(proofs.length,3);assert.equal(validateDynamicForm(schema,answers,proofs).is_valid,true);
  assert.equal(validateDynamicForm(schema,answers,proofs.slice(0,2)).is_valid,false);assert.equal(validateDynamicForm(schema,{...answers,shop_gps:null},proofs).is_valid,false);assert.equal(validateDynamicForm(schema,{...answers,shop_city:'Autre ville'},proofs).is_valid,false);assert.equal(validateDynamicForm(schema,{...answers,shop_phone:''},proofs).is_valid,false);
  server=require('../src/server').listen(0,'127.0.0.1');await new Promise(r=>server.listening?r():server.once('listening',r));
  const base='http://127.0.0.1:'+server.address().port;
  for(const entry of saved.matchAll(/Email : (.+)\nMot de passe initial : (.+)/g)){
   const response=await fetch(base+'/api/auth/login-web',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:entry[1],password:entry[2]})});assert.equal(response.status,200);const session=await response.json();
   const context=await fetch(base+'/api/saas/context',{headers:{Authorization:'Bearer '+session.token}}).then(r=>r.json());assert.ok(['super_admin','business'].includes(context.user.role));assert.equal(context.organizations[0].name,'YAAR+');
  }
  console.log('PASS YAAR+ real setup: professional logins, idempotent accounts/campaign, 100000/25=4000, GPS/phone/city/3 mandatory photos, no fake funding');
 }finally{if(server)await new Promise(r=>server.close(r));if(db?.open)db.close();fs.rmSync(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
