const router=require('express').Router();
const crypto=require('crypto');
const fs=require('fs');
const path=require('path');
const multer=require('multer');
const {db}=require('../db/database');
const {authMiddleware,audit}=require('../middleware/auth');
const A=require('../services/saasAccess');
const C=require('../services/saasCampaigns');
const Analytics=require('../services/saasAnalytics');
const {validateAndCreditSubmission,rejectSubmission}=require('../services/walletService');
const MANAGE=[...A.MANAGERS,'business'];
const ALL=[...A.STAFF,'business','business_collaborator'];
const handler=fn=>async(req,res,next)=>{try{await fn(req,res);}catch(e){next(e);}};
const id=prefix=>prefix+'_'+crypto.randomUUID();
const notify=(user,title,message)=>db.prepare('INSERT INTO notifications(id,user_id,title,message) VALUES(?,?,?,?)').run(id('notif'),user,title,message);
function notifyOrg(org,title,message){db.prepare('SELECT DISTINCT user_id FROM organization_members WHERE organization_id=?').all(org).forEach(m=>notify(m.user_id,title,message));}
function notifyStaff(title,message){db.prepare("SELECT id FROM users WHERE role IN ('admin','super_admin','study_manager') AND is_suspended=0").all().forEach(u=>notify(u.id,title,message));}
function studyEvent(req,study,kind,body,internal=false){db.prepare('INSERT INTO study_events(id,study_id,user_id,kind,body,internal) VALUES(?,?,?,?,?,?)').run(id('event'),study,req.user.id,kind,body,internal?1:0);}
function scopedList(req,table,extra=''){const org=A.orgScope(req,req.query.organization_id);return {where:org?' WHERE organization_id=?':' WHERE 1=1',args:org?[org]:[],extra};}
router.use(authMiddleware,A.allow(ALL));
router.get('/context',handler((req,res)=>{
 const accountRole=A.role(req);
 const organizations=A.staff(req)?db.prepare('SELECT * FROM organizations ORDER BY name').all():db.prepare('SELECT o.*,m.role membership_role FROM organizations o JOIN organization_members m ON m.organization_id=o.id WHERE m.user_id=? ORDER BY o.name').all(req.user.id);
 res.json({user:{id:req.user.id,name:req.user.name,email:req.user.email,phone:req.user.phone,city:req.user.city_confirmed?req.user.city:'',role:accountRole,avatar_url:req.user.avatar_url},organizations,permissions:{admin:A.admin(req),studies:A.MANAGERS.includes(accountRole)||['business','business_collaborator'].includes(accountRole),campaign_write:MANAGE.includes(accountRole),quality:A.STAFF.includes(accountRole),settings:A.admin(req),finance:A.admin(req),reports:accountRole!=='quality_controller'||A.staff(req)}});
}));
router.get('/dashboard',handler((req,res)=>res.json(Analytics.dashboard(req,req.query))));
router.get('/search',handler((req,res)=>{
 const term=A.text(req.query.q,'Recherche',100);const org=A.orgScope(req,req.query.organization_id);
 const like='%'+term+'%';
 const campaigns=db.prepare('SELECT id,title,organization_id,status FROM campaigns WHERE title LIKE ?'+(org?' AND organization_id=?':'')+' LIMIT 20').all(...(org?[like,org]:[like]));
 const studies=A.role(req)==='quality_controller'?[]:db.prepare('SELECT id,title,reference,status FROM studies WHERE title LIKE ?'+(org?' AND organization_id=?':'')+' LIMIT 20').all(...(org?[like,org]:[like]));
 const organizations=A.admin(req)?db.prepare('SELECT id,name,status FROM organizations WHERE name LIKE ? LIMIT 20').all(like):[];
 const users=A.admin(req)?db.prepare('SELECT id,name,email,role FROM users WHERE name LIKE ? OR email LIKE ? LIMIT 20').all(like,like):[];
 res.json({campaigns,studies,organizations,users});
}));
router.get('/campaigns',handler((req,res)=>{
 const org=A.orgScope(req,req.query.organization_id);const args=org?[org]:[];let where=org?' WHERE c.organization_id=?':' WHERE 1=1';
 if(req.query.status){where+=' AND c.status=?';args.push(req.query.status);}
 if(req.query.q){where+=' AND c.title LIKE ?';args.push('%'+req.query.q+'%');}
 const result=A.list(`SELECT c.*,o.name organization_name,(SELECT COUNT(*) FROM submissions s WHERE s.campaign_id=c.id) realized,(SELECT COUNT(*) FROM submissions s WHERE s.campaign_id=c.id AND s.status='validated') validated FROM campaigns c JOIN organizations o ON o.id=c.organization_id${where} ORDER BY c.created_at DESC,c.rowid DESC`,args,req.query);
 result.items=result.items.map(C.formatCampaign);res.json(result);
}));
router.post('/campaigns',A.allow(MANAGE),handler((req,res)=>db.transaction(()=>{
 const status=req.body.save_draft?'draft':'pending_approval';
 const campaignId=C.createCampaign(req,req.body,req.body.organization_id,status);
 audit(req,'create','campaign',campaignId,{status});
 if(status==='pending_approval')notifyStaff('Campagne à approuver',req.body.title);
 res.status(201).json({id:campaignId,status});
}).immediate()));
router.put('/campaigns/:id',A.allow(MANAGE),handler((req,res)=>db.transaction(()=>{C.editCampaign(req,req.params.id,req.body);audit(req,'edit','campaign',req.params.id);res.json({success:true});}).immediate()));
router.post('/campaigns/:id/status',A.allow(MANAGE),handler((req,res)=>db.transaction(()=>{
 C.changeStatus(req,req.params.id,req.body.status);audit(req,'status_change','campaign',req.params.id,{status:req.body.status});
 const campaign=db.prepare('SELECT * FROM campaigns WHERE id=?').get(req.params.id);notifyOrg(campaign.organization_id,'Statut de campagne',campaign.title+' : '+req.body.status);
 res.json({success:true});
}).immediate()));
router.post('/campaigns/:id/duplicate',A.allow(MANAGE),handler((req,res)=>db.transaction(()=>{
 const original=A.resource(req,'campaigns',req.params.id,true);const campaignId=C.createCampaign(req,{...C.formatCampaign(original),title:original.title+' — copie'},original.organization_id,'draft');audit(req,'duplicate','campaign',campaignId,{source:original.id});res.status(201).json({id:campaignId});
}).immediate()));
router.get('/campaigns/:id/analysis',handler((req,res)=>res.json(Analytics.campaignAnalysis(req,req.params.id,req.query))));

router.get('/studies',A.allow([...A.MANAGERS,'business','business_collaborator']),handler((req,res)=>{
 const scope=scopedList(req,'studies');let where=scope.where.replaceAll('organization_id','s.organization_id');const args=scope.args;
 if(req.query.status){where+=' AND s.status=?';args.push(req.query.status);}
 res.json(A.list(`SELECT s.*,o.name organization_name,u.name manager_name FROM studies s JOIN organizations o ON o.id=s.organization_id LEFT JOIN users u ON u.id=s.assigned_to${where} ORDER BY s.created_at DESC,s.rowid DESC`,args,req.query));
}));
router.post('/studies',A.allow(MANAGE),handler((req,res)=>{
 const org=A.orgScope(req,req.body.organization_id,true);if(!org||!db.prepare('SELECT id FROM organizations WHERE id=?').get(org))A.fail('Entreprise requise');
 const b=req.body,studyId=id('study'),reference='ETU-'+new Date().getUTCFullYear()+'-'+crypto.randomBytes(5).toString('hex').toUpperCase();
 const data={title:A.text(b.title,'Projet',200),sector:A.text(b.sector,'Secteur',150),product:A.text(b.product,'Produit',2000),objectives:A.text(b.objectives,'Objectifs'),key_questions:A.text(b.key_questions,'Questions principales'),target_population:A.text(b.target_population,'Population',2000),regions:A.text(b.regions,'Régions',2000),sample_size:A.integer(b.sample_size,'Échantillon',1,1000000),indicative_budget:A.integer(b.indicative_budget,'Budget indicatif',0),desired_date:A.date(b.desired_date,'Date souhaitée',true)};
 db.transaction(()=>{
  const keys=Object.keys(data);db.prepare(`INSERT INTO studies(id,reference,organization_id,created_by,${keys.join(',')}) VALUES(?,?,?,?,${keys.map(()=>'?').join(',')})`).run(studyId,reference,org,req.user.id,...Object.values(data));
  studyEvent(req,studyId,'created','Demande reçue');audit(req,'create','study',studyId,{reference});notifyStaff('Nouvelle demande d’étude',reference+' — '+data.title);
 }).immediate();res.status(201).json({id:studyId,reference,status:'new'});
}));
router.get('/studies/:id',A.allow([...A.MANAGERS,'business','business_collaborator']),handler((req,res)=>{
 const study=A.resource(req,'studies',req.params.id);const isStaff=A.staff(req);
 const proposals=db.prepare('SELECT * FROM proposals WHERE study_id=?'+(isStaff?'':" AND status != 'draft'")+' ORDER BY version DESC').all(study.id);
 const events=db.prepare('SELECT e.*,u.name author FROM study_events e JOIN users u ON u.id=e.user_id WHERE study_id=?'+(isStaff?'':' AND internal=0')+' ORDER BY e.created_at,e.rowid').all(study.id);
 const documents=db.prepare('SELECT * FROM business_documents WHERE study_id=?'+(isStaff?'':' AND internal=0')+' ORDER BY created_at').all(study.id);
 res.json({...study,proposals,events,documents,payment_confirmed:false});
}));
router.post('/studies/:id/events',A.allow(MANAGE),handler((req,res)=>{
 const study=A.resource(req,'studies',req.params.id,true);const internal=req.body.internal===true;
 if(internal&&!A.MANAGERS.includes(A.role(req)))A.fail('Notes internes réservées à TOUMA',403);
 const body=A.text(req.body.body,'Message');
 db.transaction(()=>{studyEvent(req,study.id,internal?'note':'message',body,internal);audit(req,'message','study',study.id,{internal});if(!internal){if(A.staff(req))notifyOrg(study.organization_id,'Message sur votre étude',study.reference);else notifyStaff('Message client',study.reference);}}).immediate();res.status(201).json({success:true});
}));
router.put('/studies/:id',A.allow(A.MANAGERS),handler((req,res)=>{
 const study=A.resource(req,'studies',req.params.id,true);
 const transitions={new:['analyzing','refused'],analyzing:['preparing','refused'],preparing:['negotiating','refused'],proposal_sent:['negotiating','refused'],negotiating:['preparing','refused'],accepted:['executing'],refused:[],executing:['completed'],completed:[]};
 if(req.body.status&&req.body.status!==study.status&&!(transitions[study.status]||[]).includes(req.body.status))A.fail('Transition réservée au workflow de proposition ou de campagne');
 if(req.body.status==='executing'&&(!study.campaign_id||db.prepare('SELECT status FROM campaigns WHERE id=?').get(study.campaign_id)?.status!=='active'))A.fail('Publier la campagne avant l’exécution');
 if(req.body.status==='completed'&&!db.prepare('SELECT id FROM reports WHERE study_id=?').get(study.id))A.fail('Générer un rapport avant de terminer');
 const manager=req.body.assigned_to===undefined?study.assigned_to:req.body.assigned_to||null;
 if(manager&&!db.prepare("SELECT id FROM users WHERE id=? AND role IN ('admin','super_admin','study_manager') AND is_suspended=0").get(manager))A.fail('Gestionnaire invalide');
 db.transaction(()=>{db.prepare('UPDATE studies SET status=?,assigned_to=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(req.body.status||study.status,manager,study.id);studyEvent(req,study.id,'status',req.body.status||'Gestionnaire affecté');audit(req,'update','study',study.id,req.body);notifyOrg(study.organization_id,'Suivi de votre étude',study.reference+' : '+(req.body.status||study.status));}).immediate();res.json({success:true});
}));
router.post('/studies/:id/proposals',A.allow(A.MANAGERS),handler((req,res)=>{
 const study=A.resource(req,'studies',req.params.id,true);if(['accepted','executing','completed','refused'].includes(study.status))A.fail('Étude non ouverte à une proposition');
 const b=req.body;const proposal={title:A.text(b.title,'Titre',200),scope:A.text(b.scope,'Périmètre'),methodology:A.text(b.methodology,'Méthodologie'),amount:A.integer(b.amount,'Devis',1),sample_size:A.integer(b.sample_size,'Échantillon',1,1000000),delivery_date:A.date(b.delivery_date,'Livraison')};
 const proposalId=id('proposal');db.transaction(()=>{
 const version=db.prepare('SELECT COALESCE(MAX(version),0)+1 v FROM proposals WHERE study_id=?').get(study.id).v;
 db.prepare('INSERT INTO proposals(id,study_id,version,title,scope,methodology,amount,sample_size,delivery_date,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)').run(proposalId,study.id,version,...Object.values(proposal),req.user.id);
 db.prepare("UPDATE studies SET status='preparing',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(study.id);studyEvent(req,study.id,'proposal','Proposition version '+version+' en préparation',true);audit(req,'proposal_create','study',study.id,{proposal_id:proposalId});
 }).immediate();res.status(201).json({id:proposalId});
}));
router.post('/proposals/:id/send',A.allow(A.MANAGERS),handler((req,res)=>db.transaction(()=>{
 const proposal=db.prepare('SELECT * FROM proposals WHERE id=?').get(req.params.id);if(!proposal)A.fail('Proposition introuvable',404);
 const study=A.resource(req,'studies',proposal.study_id,true);if(proposal.status!=='draft'||['accepted','executing','completed','refused'].includes(study.status))A.fail('Proposition non envoyable');
 db.prepare("UPDATE proposals SET status='superseded' WHERE study_id=? AND status='sent'").run(study.id);
 db.prepare("UPDATE proposals SET status='sent' WHERE id=?").run(proposal.id);db.prepare("UPDATE studies SET status='proposal_sent',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(study.id);
 studyEvent(req,study.id,'proposal_sent','Proposition version '+proposal.version+' disponible');audit(req,'proposal_send','study',study.id,{proposal_id:proposal.id});notifyOrg(study.organization_id,'Proposition disponible',study.reference);res.json({success:true});
}).immediate()));
router.post('/proposals/:id/decision',A.allow(['business']),handler((req,res)=>db.transaction(()=>{
 const proposal=db.prepare('SELECT * FROM proposals WHERE id=?').get(req.params.id);if(!proposal)A.fail('Proposition introuvable',404);
 const study=A.resource(req,'studies',proposal.study_id,true);if(!['accepted','refused'].includes(req.body.decision))A.fail('Décision invalide');
 if(proposal.status===req.body.decision){res.json({success:true,payment_confirmed:false});return;}
 if(proposal.status!=='sent'||!['proposal_sent','negotiating'].includes(study.status))A.fail('Proposition non ouverte à une décision');
 db.prepare('UPDATE proposals SET status=?,decided_by=?,decided_at=CURRENT_TIMESTAMP WHERE id=?').run(req.body.decision,req.user.id,proposal.id);
 db.prepare('UPDATE studies SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(req.body.decision,study.id);studyEvent(req,study.id,'decision','Proposition '+req.body.decision+' — aucun paiement confirmé');audit(req,'proposal_decision','study',study.id,{decision:req.body.decision});notifyStaff('Décision client',study.reference+' : '+req.body.decision);res.json({success:true,payment_confirmed:false});
}).immediate()));
router.post('/studies/:id/campaign',A.allow(A.MANAGERS),handler((req,res)=>db.transaction(()=>{
 const study=A.resource(req,'studies',req.params.id,true);
 if(study.campaign_id){res.json({id:study.campaign_id,duplicate:true});return;}
 if(study.status!=='accepted')A.fail('Une proposition acceptée est requise');
 const campaignId=C.createCampaign(req,{...req.body,objective:study.objectives,target_population:study.target_population,geographic_zone:study.regions},study.organization_id,'pending_approval');
 db.prepare('UPDATE studies SET campaign_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(campaignId,study.id);studyEvent(req,study.id,'campaign','Campagne créée, en attente d’approbation');audit(req,'study_conversion','campaign',campaignId,{study_id:study.id});res.status(201).json({id:campaignId});
}).immediate()));

const documentsDir=path.join(__dirname,'../../private-documents');
const documentUpload=multer({storage:multer.diskStorage({destination:(req,file,cb)=>{fs.mkdirSync(documentsDir,{recursive:true});cb(null,documentsDir);},filename:(req,file,cb)=>cb(null,crypto.randomUUID()+'.bin')}),limits:{fileSize:15*1024*1024,files:1}});
router.post('/documents',A.allow(MANAGE),documentUpload.single('document'),handler((req,res)=>{
 try {
  if(!req.file)A.fail('Document requis');
  const study=req.body.study_id?A.resource(req,'studies',req.body.study_id,true):null;
  const org=A.orgScope(req,study?.organization_id||req.body.organization_id,true);if(!org||!db.prepare('SELECT id FROM organizations WHERE id=?').get(org))A.fail('Entreprise requise');
  const internal=req.body.internal==='true';if(internal&&!A.staff(req))A.fail('Document interne réservé à TOUMA',403);
  const bytes=fs.readFileSync(req.file.path);const mime=bytes.subarray(0,5).toString()==='%PDF-'?'application/pdf':bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'image/jpeg':null;
  if(!mime)A.fail('Documents acceptés : PDF, PNG, JPEG');
  const documentId=id('doc');const kind=['attachment','contract'].includes(req.body.kind)?req.body.kind:'attachment';
  db.transaction(()=>{db.prepare('INSERT INTO business_documents(id,organization_id,study_id,uploaded_by,kind,filename,original_name,mime_type,size,sha256,internal) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(documentId,org,study?.id||null,req.user.id,kind,req.file.filename,path.basename(req.file.originalname).slice(0,200),mime,req.file.size,crypto.createHash('sha256').update(bytes).digest('hex'),internal?1:0);audit(req,'upload','document',documentId);}).immediate();res.status(201).json({id:documentId,name:req.file.originalname});
 }catch(e){if(req.file)fs.unlinkSync(req.file.path);throw e;}
}));
router.get('/documents',A.allow([...A.MANAGERS,'business','business_collaborator']),handler((req,res)=>{
 const scope=scopedList(req,'business_documents');let where=scope.where;if(!A.staff(req))where+=' AND internal=0';
 res.json(A.list('SELECT * FROM business_documents'+where+' ORDER BY created_at DESC',scope.args,req.query));
}));
router.get('/documents/:id/download',A.allow([...A.MANAGERS,'business','business_collaborator']),handler((req,res)=>{
 const doc=A.resource(req,'business_documents',req.params.id);if(doc.internal&&!A.staff(req))A.fail('Document privé',403);
 res.type(doc.mime_type).download(path.join(documentsDir,doc.filename),doc.original_name);
}));

router.get('/submissions',handler((req,res)=>{
 const org=A.orgScope(req,req.query.organization_id);let where=org?' WHERE c.organization_id=?':' WHERE 1=1';const args=org?[org]:[];
 for(const [key,column] of [['campaign_id','s.campaign_id'],['status','s.status'],['region','u.city']])if(req.query[key]){where+=' AND '+column+'=?';args.push(req.query[key]);if(key==='region')where+=' AND u.city_confirmed=1';}
 if(req.query.from){where+=' AND DATE(s.submitted_at)>=?';args.push(A.date(req.query.from,'Début'));}if(req.query.to){where+=' AND DATE(s.submitted_at)<=?';args.push(A.date(req.query.to,'Fin'));}
 const result=A.list(`SELECT s.*,c.title campaign_title,c.form_schema,c.organization_id,COALESCE(s.promised_reward,c.reward_amount) reward_amount,u.name contributor_name,CASE WHEN u.city_confirmed=1 THEN u.city END city,(SELECT COUNT(*) FROM submissions old WHERE old.contributor_id=s.contributor_id AND old.status='validated') contributor_validated FROM submissions s JOIN campaigns c ON c.id=s.campaign_id JOIN users u ON u.id=s.contributor_id${where} ORDER BY s.submitted_at DESC,s.rowid DESC`,args,req.query);
 result.items=result.items.map(s=>({...s,answers:JSON.parse(s.answers),evidence:JSON.parse(s.evidence),location:JSON.parse(s.location),fraud_flags:JSON.parse(s.fraud_flags),form_schema:JSON.parse(s.form_schema),versions:db.prepare('SELECT * FROM submission_versions WHERE submission_id=? ORDER BY created_at,rowid').all(s.id).map(v=>({...v,answers:JSON.parse(v.answers),evidence:JSON.parse(v.evidence),location:JSON.parse(v.location)})),review_history:db.prepare('SELECT r.*,u.name reviewer FROM submission_reviews r JOIN users u ON u.id=r.user_id WHERE submission_id=? ORDER BY r.created_at,r.rowid').all(s.id)}));res.json(result);
}));
router.post('/submissions/:id/review',A.allow(A.STAFF),handler((req,res)=>db.transaction(()=>{
 const sub=db.prepare('SELECT * FROM submissions WHERE id=?').get(req.params.id);if(!sub)A.fail('Soumission introuvable',404);
 const action=req.body.action;if(!['validate','reject','correction','flag'].includes(action))A.fail('Action invalide');
 const reason=action==='validate'?null:A.text(req.body.reason,'Motif',2000);
 let result;
 if(action==='validate')result=validateAndCreditSubmission(sub.id,req.user.id);
 if(action==='reject')result=rejectSubmission(sub.id,reason,req.user.id);
 if(action==='correction'){
  if(sub.reward_credited||!['submitted','under_review','correction_requested'].includes(sub.status))A.fail('Soumission non corrigeable');
  db.prepare("UPDATE submissions SET status='correction_requested',rejection_reason=?,reviewer_id=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?").run(reason,req.user.id,sub.id);notify(sub.contributor_id,'Correction demandée',reason);
 }
 if(action==='flag'){
  db.prepare('INSERT INTO fraud_signals(id,submission_id,user_id,signal_type,severity,details) VALUES(?,?,?,?,?,?)').run(id('fraud'),sub.id,sub.contributor_id,'manual_flag','medium',JSON.stringify({reason}));
  if(!sub.reward_credited)db.prepare("UPDATE submissions SET status='under_review',fraud_flags=?,fraud_score=MAX(fraud_score,50) WHERE id=?").run(JSON.stringify([...JSON.parse(sub.fraud_flags),'manual_flag']),sub.id);
 }
 db.prepare('INSERT INTO submission_reviews(id,submission_id,user_id,action,reason) VALUES(?,?,?,?,?)').run(id('review'),sub.id,req.user.id,action,reason);audit(req,action,'submission',sub.id,{reason});res.json({success:true,result});
}).immediate()));
router.post('/submissions/bulk-validate',A.allow(A.STAFF),handler((req,res)=>db.transaction(()=>{
 const ids=req.body.ids;if(!Array.isArray(ids)||!ids.length||ids.length>50||new Set(ids).size!==ids.length)A.fail('Sélection invalide (1 à 50)');
 const rows=ids.map(subId=>{const s=db.prepare('SELECT s.*,c.validation_rules FROM submissions s JOIN campaigns c ON c.id=s.campaign_id WHERE s.id=?').get(subId);if(!s||s.status!=='submitted'||JSON.parse(s.fraud_flags).length||JSON.parse(s.validation_rules).allow_bulk!==true)A.fail('Validation groupée non autorisée pour cette sélection');return s;});
 rows.forEach(s=>{validateAndCreditSubmission(s.id,req.user.id);db.prepare('INSERT INTO submission_reviews(id,submission_id,user_id,action) VALUES(?,?,?,?)').run(id('review'),s.id,req.user.id,'bulk_validate');audit(req,'bulk_validate','submission',s.id);});res.json({success:true,count:rows.length});
}).immediate()));

router.get('/organizations',A.allow([...A.MANAGERS,'business','business_collaborator']),handler((req,res)=>{
 const org=A.orgScope(req,req.query.organization_id);const args=org?[org]:[];let where=org?' WHERE o.id=?':' WHERE 1=1';if(req.query.q){where+=' AND o.name LIKE ?';args.push('%'+req.query.q+'%');}
 const result=A.list(`SELECT o.*,(SELECT COUNT(*) FROM campaigns c WHERE c.organization_id=o.id) campaigns_count,(SELECT COALESCE(SUM(t.amount),0) FROM wallet_transactions t JOIN submissions s ON s.id=t.reference_id JOIN campaigns c ON c.id=s.campaign_id WHERE t.type='task_reward' AND c.organization_id=o.id) spent FROM organizations o${where} ORDER BY o.created_at DESC`,args,req.query);res.json(result);
}));
router.get('/organizations/:id/members',A.allow([...A.MANAGERS,'business','business_collaborator']),handler((req,res)=>{A.resource(req,'organizations',req.params.id);res.json(db.prepare('SELECT m.id,m.user_id,m.role,u.name,u.email,u.is_suspended,u.role account_role FROM organization_members m JOIN users u ON u.id=m.user_id WHERE m.organization_id=? ORDER BY u.name').all(req.params.id));}));
router.put('/organizations/:id',A.allow([...A.MANAGERS,'business']),handler((req,res)=>{
 const org=db.prepare('SELECT * FROM organizations WHERE id=?').get(req.params.id);if(!org)A.fail('Entreprise introuvable',404);A.orgScope(req,org.id,true);
 if(req.body.status!==undefined&&!A.admin(req))A.fail('Approbation réservée à l’administration',403);
 const status=req.body.status||org.status;if(!['pending','approved','suspended'].includes(status))A.fail('Statut entreprise invalide');
 const name=A.text(req.body.name??org.name,'Nom',200),email=A.text(req.body.contact_email??org.contact_email,'Email',200,true),phone=A.text(req.body.contact_phone??org.contact_phone,'Téléphone',30,true);
 if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))A.fail('Email invalide');
 db.transaction(()=>{db.prepare('UPDATE organizations SET name=?,status=?,is_verified=?,contact_email=?,contact_phone=?,industry=?,address=?,registration_number=? WHERE id=?').run(name,status,status==='approved'?1:0,email,phone,A.text(req.body.industry??org.industry,'Secteur',150,true),A.text(req.body.address??org.address,'Adresse',1000,true),A.text(req.body.registration_number??org.registration_number,'Immatriculation',200,true),org.id);audit(req,'update','organization',org.id,{status});notifyOrg(org.id,'Compte entreprise',status);}).immediate();res.json({success:true});
}));
router.post('/organizations/:id/members',A.allow(['admin','super_admin','business']),handler((req,res)=>{
 const orgId=req.params.id;A.orgScope(req,orgId,true);if(!db.prepare('SELECT id FROM organizations WHERE id=?').get(orgId))A.fail('Entreprise introuvable',404);
 if(!A.admin(req)&&!db.prepare("SELECT id FROM organization_members WHERE organization_id=? AND user_id=? AND role='owner'").get(orgId,req.user.id))A.fail('Propriétaire requis',403);
 const memberRole=req.body.role;if(!['owner','manager','viewer'].includes(memberRole))A.fail('Rôle membre invalide');
 const user=db.prepare("SELECT * FROM users WHERE email=? AND role IN ('business','business_collaborator')").get(A.text(req.body.email,'Email',200).toLowerCase());if(!user)A.fail('Compte entreprise enregistré requis');
 if(db.prepare('SELECT id FROM organization_members WHERE organization_id=? AND user_id=?').get(orgId,user.id))A.fail('Membre déjà présent');
 db.transaction(()=>{db.prepare('INSERT INTO organization_members(id,organization_id,user_id,role) VALUES(?,?,?,?)').run(id('member'),orgId,user.id,memberRole);audit(req,'member_add','organization',orgId,{user_id:user.id,role:memberRole});notify(user.id,'Accès entreprise',orgId);}).immediate();res.status(201).json({success:true});
}));
router.delete('/organizations/:id/members/:member',A.allow(['admin','super_admin','business']),handler((req,res)=>{
 A.orgScope(req,req.params.id,true);const member=db.prepare('SELECT * FROM organization_members WHERE id=? AND organization_id=?').get(req.params.member,req.params.id);if(!member)A.fail('Membre introuvable',404);
 if(!A.admin(req)&&!db.prepare("SELECT id FROM organization_members WHERE organization_id=? AND user_id=? AND role='owner'").get(req.params.id,req.user.id))A.fail('Propriétaire requis',403);
 if(member.role==='owner'&&db.prepare("SELECT COUNT(*) n FROM organization_members WHERE organization_id=? AND role='owner'").get(req.params.id).n<=1)A.fail('Conserver au moins un propriétaire');
 db.transaction(()=>{db.prepare('DELETE FROM organization_members WHERE id=?').run(member.id);audit(req,'member_remove','organization',req.params.id,{user_id:member.user_id});}).immediate();res.json({success:true});
}));
router.get('/users',A.allow(A.MANAGERS),handler((req,res)=>{
 const args=[];let where=' WHERE 1=1';if(req.query.role){where+=' AND u.role=?';args.push(req.query.role);}if(req.query.q){where+=' AND (u.name LIKE ? OR u.email LIKE ?)';args.push('%'+req.query.q+'%','%'+req.query.q+'%');}
 res.json(A.list('SELECT u.id,u.name,u.email,u.phone,CASE WHEN u.city_confirmed=1 THEN u.city END city,u.role,u.is_suspended,u.created_at,u.reputation_score FROM users u'+where+' ORDER BY u.created_at DESC',args,req.query));
}));
router.put('/users/:id/role',A.allow(['admin','super_admin']),handler((req,res)=>{
 const user=db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);if(!user)A.fail('Utilisateur introuvable',404);
 const newRole=req.body.role;if(![...ALL,'contributor'].includes(newRole))A.fail('Rôle inconnu');
 if(req.params.id===req.user.id)A.fail('Votre propre rôle ne peut pas être changé ici');
 if(A.role(req)!=='super_admin'&&(['admin','super_admin'].includes(newRole)||['admin','super_admin'].includes(user.role)))A.fail('Super administrateur requis',403);
 db.transaction(()=>{db.prepare('UPDATE users SET role=? WHERE id=?').run(newRole,user.id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);audit(req,'role_change','user',user.id,{role:newRole});}).immediate();res.json({success:true});
}));
router.get('/finance',A.allow(['admin','super_admin']),handler((req,res)=>{
 const wallets=A.list('SELECT w.*,u.name,u.email FROM wallets w JOIN users u ON u.id=w.user_id ORDER BY w.updated_at DESC',[],req.query);
 const totals=db.prepare('SELECT COALESCE(SUM(balance),0) available,COALESCE(SUM(reserved_balance),0) reserved,COALESCE(SUM(total_earned),0) earned,COALESCE(SUM(total_withdrawn),0) withdrawn FROM wallets').get();
 const ledger=db.prepare('SELECT COALESCE(SUM(amount),0) net FROM wallet_transactions').get();
 const discrepancies=db.prepare('SELECT w.user_id,w.balance,COALESCE(SUM(t.amount),0) ledger_balance FROM wallets w LEFT JOIN wallet_transactions t ON t.wallet_id=w.id GROUP BY w.id HAVING w.balance!=ledger_balance').all();
 res.json({wallets,totals,ledger_net:ledger.net,discrepancies,payment_integration:'required'});
}));
router.get('/withdrawals',A.allow(['admin','super_admin']),handler((req,res)=>{
 const args=[];let where='';if(req.query.status){where=' WHERE w.status=?';args.push(req.query.status);}res.json(A.list('SELECT w.*,u.name FROM withdrawals w JOIN users u ON u.id=w.user_id'+where+' ORDER BY w.created_at DESC',args,req.query));
}));
router.get('/transactions',A.allow(['admin','super_admin']),handler((req,res)=>res.json(A.list('SELECT t.*,u.name FROM wallet_transactions t JOIN users u ON u.id=t.user_id ORDER BY t.created_at DESC',[],req.query))));
router.get('/audit',A.allow(['admin','super_admin']),handler((req,res)=>res.json(A.list('SELECT a.*,u.name actor FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC,a.rowid DESC',[],req.query))));
router.get('/invoices',A.allow([...A.MANAGERS,'business','business_collaborator']),handler((req,res)=>{const scope=scopedList(req,'invoices');res.json(A.list('SELECT * FROM invoices'+scope.where+' ORDER BY created_at DESC',scope.args,req.query));}));
router.post('/invoices',A.allow(A.MANAGERS),handler((req,res)=>{
 const org=req.body.organization_id;if(!db.prepare('SELECT id FROM organizations WHERE id=?').get(org))A.fail('Entreprise requise');
 const invoiceId=id('invoice'),reference='FAC-'+crypto.randomBytes(6).toString('hex').toUpperCase();const description=A.text(req.body.description,'Objet',2000),amount=A.integer(req.body.amount,'Montant',1),due=A.date(req.body.due_date,'Échéance',true);
 const study=req.body.study_id?A.resource(req,'studies',req.body.study_id):null;if(study&&study.organization_id!==org)A.fail('Étude étrangère');
 db.transaction(()=>{db.prepare('INSERT INTO invoices(id,organization_id,study_id,reference,description,amount,due_date,created_by) VALUES(?,?,?,?,?,?,?,?)').run(invoiceId,org,study?.id||null,reference,description,amount,due,req.user.id);audit(req,'invoice_create','invoice',invoiceId);notifyOrg(org,'Nouvelle facture',reference);}).immediate();res.status(201).json({id:invoiceId,reference,status:'unpaid'});
}));
router.get('/support',A.allow([...A.MANAGERS,'business','business_collaborator']),handler((req,res)=>{const scope=scopedList(req,'support_tickets');res.json(A.list('SELECT * FROM support_tickets'+scope.where+' ORDER BY created_at DESC',scope.args,req.query));}));
router.post('/support',A.allow(MANAGE),handler((req,res)=>{
 const org=A.orgScope(req,req.body.organization_id,true);if(!org)A.fail('Entreprise requise');const ticketId=id('ticket');const subject=A.text(req.body.subject,'Objet',200),message=A.text(req.body.message,'Message');
 db.transaction(()=>{db.prepare('INSERT INTO support_tickets(id,organization_id,created_by,subject,message) VALUES(?,?,?,?,?)').run(ticketId,org,req.user.id,subject,message);audit(req,'support_create','ticket',ticketId);notifyStaff('Support entreprise',subject);}).immediate();res.status(201).json({id:ticketId});
}));
router.put('/support/:id',A.allow(A.MANAGERS),handler((req,res)=>{
 const ticket=A.resource(req,'support_tickets',req.params.id);const response=A.text(req.body.response,'Réponse');const status=req.body.status||'answered';if(!['answered','closed'].includes(status))A.fail('Statut invalide');db.transaction(()=>{db.prepare('UPDATE support_tickets SET response=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(response,status,ticket.id);audit(req,'support_answer','ticket',ticket.id);notifyOrg(ticket.organization_id,'Réponse du support',ticket.subject);}).immediate();res.json({success:true});
}));
router.put('/settings',A.allow(['admin','super_admin']),handler((req,res)=>{
 const settings=req.body;const allowed={monthly_validation_goal:[1,1000000],min_withdrawal:[1,10000000],referral_reward:[0,10000000]};
 for(const [key,value] of Object.entries(settings)){if(!allowed[key])A.fail('Paramètre non autorisé');A.integer(value,key,...allowed[key]);}
 db.transaction(()=>{for(const [key,value] of Object.entries(settings))db.prepare('INSERT INTO platform_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP').run(key,JSON.stringify(value));audit(req,'settings_update','settings',null,settings);}).immediate();res.json({success:true});
}));
router.use(require('./saasReports'));
module.exports=router;
