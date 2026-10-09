const router=require('express').Router();
const crypto=require('crypto');
const PDFDocument=require('pdfkit');
const ExcelJS=require('exceljs');
const {db}=require('../db/database');
const {audit}=require('../middleware/auth');
const A=require('../services/saasAccess');
const {campaignAnalysis}=require('../services/saasAnalytics');
const handler=fn=>async(req,res,next)=>{try{await fn(req,res);}catch(e){next(e);}};
function pdfBuffer(write) {
 return new Promise((resolve,reject)=>{
  const doc=new PDFDocument({size:'A4',margin:44,info:{Title:'TOUMA — Études et résultats',Author:'TOUMA'}}),chunks=[];
  doc.on('data',b=>chunks.push(b));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);
  try{write(doc);doc.end();}catch(e){doc.destroy();reject(e);}
 });
}
function section(doc,title,body){doc.moveDown().fontSize(13).fillColor('#005044').text(title);doc.moveDown(.35).fontSize(10).fillColor('#344054').text(body||'Non renseigné');}
function fileResponse(res,buffer,type,name){res.type(res.req.get('Accept')==='application/octet-stream'?'application/octet-stream':type).set('Content-Disposition',`attachment; filename="${name}"`).send(buffer);}
function csvCell(value){let v=String(value??'');if(/^[=+@-]/.test(v))v="'"+v;return '"'+v.replaceAll('"','""')+'"';}
function reportRows(snapshot){return [['ID','Campagne','Contributeur','Région','Statut','Date','Récompense F CFA','Réponses JSON','Preuves JSON','GPS JSON'],...snapshot.responses.map(s=>[s.id,snapshot.analysis.title,s.contributor_name,s.city,s.status,s.submitted_at,s.reward_amount,JSON.stringify(s.answers),JSON.stringify(s.evidence),JSON.stringify(s.location)])];}
router.get('/reports',handler((req,res)=>{
 const org=A.orgScope(req,req.query.organization_id);res.json(A.list('SELECT r.id,r.title,r.campaign_id,r.study_id,r.organization_id,r.created_at,c.title campaign_title,o.name organization_name FROM reports r JOIN campaigns c ON c.id=r.campaign_id JOIN organizations o ON o.id=r.organization_id'+(org?' WHERE r.organization_id=?':'')+' ORDER BY r.created_at DESC,r.rowid DESC',org?[org]:[],req.query));
}));
router.post('/reports',A.allow([...A.MANAGERS,'business']),handler((req,res)=>{
 const campaign=A.resource(req,'campaigns',req.body.campaign_id,true);
 const analysis=campaignAnalysis(req,campaign.id,req.body);
 if(!analysis.validated)A.fail('Un rapport nécessite au moins une réponse validée');
 const study=req.body.study_id?A.resource(req,'studies',req.body.study_id,true):db.prepare('SELECT * FROM studies WHERE campaign_id=?').get(campaign.id);
 if(study&&study.campaign_id!==campaign.id)A.fail('Cette étude ne correspond pas à la campagne');
 const args=[campaign.id,analysis.from,analysis.to];let where=' WHERE s.campaign_id=? AND DATE(s.submitted_at) BETWEEN ? AND ?';
 if(analysis.region){where+=' AND u.city=? AND u.city_confirmed=1';args.push(analysis.region);}if(analysis.status){where+=' AND s.status=?';args.push(analysis.status);}
 const responses=db.prepare('SELECT s.id,s.status,s.answers,s.evidence,s.location,s.submitted_at,COALESCE(s.promised_reward,c.reward_amount) reward_amount,u.name contributor_name,CASE WHEN u.city_confirmed=1 THEN u.city END city FROM submissions s JOIN users u ON u.id=s.contributor_id JOIN campaigns c ON c.id=s.campaign_id'+where+' ORDER BY s.submitted_at,s.rowid').all(...args).map(s=>({...s,answers:JSON.parse(s.answers),evidence:JSON.parse(s.evidence),location:JSON.parse(s.location)}));
 const reportId='report_'+crypto.randomUUID(),snapshot={analysis,responses,organization:db.prepare('SELECT name,industry FROM organizations WHERE id=?').get(campaign.organization_id)};
 const title=A.text(req.body.title||campaign.title+' — résultats','Titre',250);
 const methodology=A.text(req.body.methodology,'Méthodologie',10000,true)||'Contributions enregistrées via TOUMA Mobile et contrôlées par le workflow de validation. Échantillon de contributeurs, sans garantie de représentativité.';
 const limitations=A.text(req.body.limitations,'Limites',10000,true)||'Seules les réponses effectivement enregistrées pendant la période sélectionnée sont incluses. Les statistiques par question utilisent les réponses validées. Les régions correspondent à la ville déclarée du contributeur, pas à une géolocalisation administrative certifiée. Aucune conclusion causale ou généralisation à la population n’est justifiée par ces données seules.';
 const conclusions=A.text(req.body.conclusions,'Conclusions',10000,true)||`${analysis.validated} réponses validées sur ${analysis.total} contributions enregistrées. Aucun résultat supplémentaire n’est inféré.`;
 const recommendations=A.text(req.body.recommendations,'Recommandations',10000,true)||'Aucune recommandation commerciale automatique : une interprétation métier et une analyse de représentativité sont nécessaires.';
 db.transaction(()=>{db.prepare('INSERT INTO reports(id,organization_id,campaign_id,study_id,title,snapshot,methodology,limitations,conclusions,recommendations,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(reportId,campaign.organization_id,campaign.id,study?.id||null,title,JSON.stringify(snapshot),methodology,limitations,conclusions,recommendations,req.user.id);audit(req,'report_generate','report',reportId,{campaign_id:campaign.id});db.prepare('SELECT user_id FROM organization_members WHERE organization_id=?').all(campaign.organization_id).forEach(m=>db.prepare('INSERT INTO notifications(id,user_id,title,message) VALUES(?,?,?,?)').run(crypto.randomUUID(),m.user_id,'Rapport disponible',title));}).immediate();res.status(201).json({id:reportId});
}));
router.get('/reports/:id',handler((req,res)=>{const report=A.resource(req,'reports',req.params.id);res.json({...report,snapshot:JSON.parse(report.snapshot)});}));
router.get(['/reports/:id/export','/reports/:id/files/:format'],handler(async(req,res)=>{
 const report=A.resource(req,'reports',req.params.id);const snapshot=JSON.parse(report.snapshot),format=req.params.format||req.query.format||'pdf';
 if(format==='csv')return fileResponse(res,Buffer.from('\ufeff'+reportRows(snapshot).map(row=>row.map(csvCell).join(',')).join('\r\n')),'text/csv; charset=utf-8','touma-'+report.id+'.csv');
 if(format==='xlsx'){
  const workbook=new ExcelJS.Workbook();workbook.creator='TOUMA';
  const summary=workbook.addWorksheet('Synthèse');summary.addRows([['Entreprise',snapshot.organization.name],['Rapport',report.title],['Période',snapshot.analysis.from+' — '+snapshot.analysis.to],['Réponses',snapshot.analysis.total],['Validées',snapshot.analysis.validated],['Méthodologie',report.methodology],['Limites',report.limitations],['Conclusions',report.conclusions],['Recommandations',report.recommendations]]);summary.getColumn(1).width=25;summary.getColumn(2).width=100;
  const sheet=workbook.addWorksheet('Contributions');sheet.addRows(reportRows(snapshot));sheet.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF005044'}};sheet.views=[{state:'frozen',ySplit:1}];sheet.columns.forEach(col=>{col.width=28;});
  const statistics=workbook.addWorksheet('Questions');statistics.addRows([['Question','Type','Réponses validées','Moyenne','Minimum','Maximum','Distribution JSON'],...snapshot.analysis.questions.map(q=>[q.label,q.type,q.answered,q.mean,q.min,q.max,JSON.stringify(q.distribution)])]);statistics.columns.forEach(c=>c.width=28);
  return fileResponse(res,Buffer.from(await workbook.xlsx.writeBuffer()),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','touma-'+report.id+'.xlsx');
 }
 if(format!=='pdf')A.fail('Format : PDF, XLSX ou CSV');
 const buffer=await pdfBuffer(doc=>{
  doc.fontSize(24).fillColor('#005044').text('TOUMA').fontSize(10).fillColor('#667085').text('Rapport d’étude • '+new Date(report.created_at.replace(' ','T')+'Z').toLocaleDateString('fr-FR'));
  section(doc,report.title,snapshot.organization.name);
  section(doc,'Objectifs',snapshot.analysis.objective);section(doc,'Méthodologie',report.methodology);
  section(doc,'Échantillon et période',`${snapshot.analysis.from} au ${snapshot.analysis.to}\n${snapshot.analysis.total} contributions • ${snapshot.analysis.unique_contributors} contributeurs uniques • ${snapshot.analysis.validated} réponses validées`);
  section(doc,'Résultats par question','Les calculs ci-dessous portent uniquement sur les réponses validées.');
  for(const q of snapshot.analysis.questions){section(doc,q.label,`${q.answered} réponses${q.mean!==null?' • Moyenne : '+q.mean.toFixed(2)+' • Min : '+q.min+' • Max : '+q.max:''}`);for(const d of q.distribution)doc.text(d.label+' : '+d.count);}
  doc.addPage();section(doc,'Répartition par ville déclarée','Cette répartition utilise le profil du contributeur.');
  const max=Math.max(1,...snapshot.analysis.regions.map(r=>r.count));
  for(const region of snapshot.analysis.regions){if(doc.y>690)doc.addPage();doc.fontSize(10).fillColor('#344054').text(region.label+' : '+region.count);const y=doc.y;doc.rect(44,y,region.count/max*400,10).fill('#00A879');doc.y=y+20;}
  section(doc,'Limites des données',report.limitations);section(doc,'Conclusions',report.conclusions);section(doc,'Recommandations',report.recommendations);
 });fileResponse(res,buffer,'application/pdf','touma-'+report.id+'.pdf');
}));
router.get('/proposals/:id/pdf',A.allow([...A.MANAGERS,'business','business_collaborator']),handler(async(req,res)=>{
 const proposal=db.prepare('SELECT * FROM proposals WHERE id=?').get(req.params.id);if(!proposal)A.fail('Proposition introuvable',404);const study=A.resource(req,'studies',proposal.study_id);
 if(!A.staff(req)&&proposal.status==='draft')A.fail('Proposition non publiée',403);
 const org=db.prepare('SELECT name FROM organizations WHERE id=?').get(study.organization_id);
 const buffer=await pdfBuffer(doc=>{doc.fontSize(24).fillColor('#005044').text('TOUMA');section(doc,'Proposition commerciale — version '+proposal.version,org.name+'\n'+study.reference+' • '+proposal.title);section(doc,'Périmètre',proposal.scope);section(doc,'Méthodologie',proposal.methodology);section(doc,'Échantillon',String(proposal.sample_size)+' contributions souhaitées');section(doc,'Devis',proposal.amount.toLocaleString('fr-FR')+' F CFA');section(doc,'Livraison souhaitée',proposal.delivery_date);section(doc,'Conditions','Cette proposition n’est pas une preuve de paiement. Son acceptation ne confirme aucun encaissement.');});fileResponse(res,buffer,'application/pdf','touma-proposition-'+proposal.version+'.pdf');
}));
router.get('/invoices/:id/pdf',A.allow([...A.MANAGERS,'business','business_collaborator']),handler(async(req,res)=>{
 const invoice=A.resource(req,'invoices',req.params.id),org=db.prepare('SELECT name FROM organizations WHERE id=?').get(invoice.organization_id);
 const buffer=await pdfBuffer(doc=>{doc.fontSize(24).fillColor('#005044').text('TOUMA');section(doc,'Facture '+invoice.reference,org.name);section(doc,'Objet',invoice.description);section(doc,'Montant',invoice.amount.toLocaleString('fr-FR')+' F CFA');section(doc,'Échéance',invoice.due_date);section(doc,'Paiement',invoice.status==='paid'&&invoice.provider_reference?'Confirmé par le prestataire : '+invoice.provider_reference:'Non confirmé — intégration du prestataire requise');});fileResponse(res,buffer,'application/pdf','touma-'+invoice.reference+'.pdf');
}));
module.exports=router;
