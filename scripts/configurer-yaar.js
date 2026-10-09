const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {db}=require('../src/db/database');
const {hashPassword}=require('../src/middleware/auth');
const C=require('../src/services/saasCampaigns');
const credentialsPath=process.env.TOUMA_CREDENTIALS_PATH||path.resolve(__dirname,'../.touma-runtime/ACCES-TOUMA.txt');
const generated=[];
const title='YAAR+ — Recensement des boutiques et petits commerces';
const body={title,description:'Enregistrer les boutiques et petits commerces de Ouagadougou et Bobo-Dioulasso : nom, téléphone, localisation GPS et trois photos du local.',category:'Recensement',task_type:'free_roam',objective:'Constituer un registre des commerces pour YAAR+.',target_population:'Boutiques et petits commerces',geographic_zone:'Ouagadougou, Bobo-Dioulasso',reward_amount:25,total_budget_amount:100000,max_submissions:4000,estimated_duration_min:5,geo_rules:{required:true},eligibility_rules:{countries:['BF']},validation_rules:{auto_validate:false,allow_bulk:false},evidence_rules:{min_photos:3,max_photos:3},instructions_text:'Rendez-vous au commerce, renseignez son nom et son numéro de téléphone, sélectionnez sa ville et capturez sa position GPS sur place. Prenez trois photos du local : façade, intérieur et enseigne ou autre vue extérieure. Ne recensez pas deux fois le même commerce. Chaque commerce accepté par TOUMA rapporte 25 F CFA.',form_schema:[{id:'shop_name',label:'Nom de la boutique ou du commerce',type:'short_text',required:true,max_length:200},{id:'shop_phone',label:'Numéro de téléphone du commerce',type:'phone',required:true},{id:'shop_city',label:'Ville du commerce',type:'single_choice',required:true,options:['Ouagadougou','Bobo-Dioulasso']},{id:'shop_gps',label:'Localisation GPS du commerce',type:'gps',required:true},{id:'shop_photo_front',label:'Photo 1 — Façade du local',type:'photo',required:true},{id:'shop_photo_inside',label:'Photo 2 — Intérieur du local',type:'photo',required:true},{id:'shop_photo_sign',label:'Photo 3 — Enseigne ou autre vue extérieure',type:'photo',required:true}]};
function account(email,name,role){
 let user=db.prepare('SELECT * FROM users WHERE email=?').get(email);
 if(user){if(user.role!==role&&!(role==='super_admin'&&user.role==='admin'))throw new Error('Compte existant avec un autre rôle : '+email);return user;}
 const id='usr_'+crypto.randomUUID(),password='Touma!'+crypto.randomBytes(15).toString('base64url');
 db.prepare('INSERT INTO users(id,name,email,password_hash,role,referral_code,city) VALUES(?,?,?,?,?,?,?)').run(id,name,email,hashPassword(password),role,crypto.randomBytes(8).toString('hex'),'');
 generated.push({email,password});return db.prepare('SELECT * FROM users WHERE id=?').get(id);
}
try{
 fs.mkdirSync(path.dirname(credentialsPath),{recursive:true});
 const result=db.transaction(()=>{
  const admin=account('admin@touma.bf','Administrateur Touma','super_admin');
  const business=account('yaaradmin@touma.bf','Responsable YAAR+','business');
  let org=db.prepare("SELECT o.* FROM organizations o JOIN organization_members m ON m.organization_id=o.id WHERE m.user_id=? AND o.name='YAAR+' AND m.role='owner'").get(business.id);
  if(!org){const id='org_'+crypto.randomUUID();db.prepare("INSERT INTO organizations(id,name,slug,status,is_verified,contact_email) VALUES(?,'YAAR+',?,'approved',0,?)").run(id,'yaar-'+crypto.randomBytes(5).toString('hex'),business.email);db.prepare("INSERT INTO organization_members(id,organization_id,user_id,role) VALUES(?,?,?,'owner')").run(crypto.randomUUID(),id,business.id);org=db.prepare('SELECT * FROM organizations WHERE id=?').get(id);}
  const req={user:{...admin,account_role:admin.role},ip:'local-setup'};
  let campaign=db.prepare('SELECT * FROM campaigns WHERE organization_id=? AND title=?').get(org.id,title);
  if(!campaign){const id=C.createCampaign(req,body,org.id);C.changeStatus(req,id,'active');campaign=db.prepare('SELECT * FROM campaigns WHERE id=?').get(id);db.prepare('INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(),admin.id,'campaign_create','campaign',id,JSON.stringify({source:'configuration demandée par le propriétaire',declared_budget:100000,payment_confirmed:false}));}
  // No wallet credits, fake financing, invoice payment or submissions are created.
  if(generated.length){const contents=generated.map(c=>`Email : ${c.email}\nMot de passe initial : ${c.password}\n`).join('\n');fs.appendFileSync(credentialsPath,'TOUMA — accès créés le '+new Date().toISOString()+'\n'+contents+'\nChanger ces mots de passe après connexion. Ne pas partager ce fichier.\n\n',{encoding:'utf8',mode:0o600});}
  return {admin_email:admin.email,business_email:business.email,organization_id:org.id,campaign_id:campaign.id,status:campaign.status,budget_declared:campaign.total_budget_amount,reward:campaign.reward_amount,capacity:campaign.max_submissions,new_accounts:generated.length,credentials_file:generated.length?credentialsPath:'Mots de passe existants conservés'};
 }).immediate();
 console.log(JSON.stringify(result,null,2));
}finally{db.close();}
