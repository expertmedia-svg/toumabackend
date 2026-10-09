const crypto = require('crypto');
const {db} = require('../db/database');
const {validateSchema} = require('./formRules');
const A = require('./saasAccess');
const jsonColumns=['geo_rules','eligibility_rules','validation_rules','evidence_rules','form_schema'];
function formatCampaign(row) {return {...row,...Object.fromEntries(jsonColumns.map(k=>[k,JSON.parse(row[k])]))};}
function payload(body,draft=false) {
  const data={
    title:A.text(body.title,'Titre',200),description:A.text(body.description,'Description',10000,draft),
    category:A.text(body.category,'Catégorie',80),task_type:body.task_type || 'survey',
    reward_amount:A.integer(body.reward_amount,'Récompense',1,10000000),
    total_budget_amount:A.integer(body.total_budget_amount,'Budget',1),
    max_submissions:A.integer(body.max_submissions ?? 1000,'Échantillon',1,1000000),
    estimated_duration_min:A.integer(body.estimated_duration_min ?? 5,'Durée',1,1440),
    objective:A.text(body.objective,'Objectif',10000,true),target_population:A.text(body.target_population,'Population',2000,true),
    geographic_zone:A.text(body.geographic_zone,'Zone',1000,true),
    starts_at:A.date(body.starts_at,'Début',true),ends_at:A.date(body.ends_at,'Fin',true),
    instructions_text:A.text(body.instructions_text,'Instructions',10000,true),
    geo_rules:body.geo_rules || {},eligibility_rules:body.eligibility_rules || {},
    validation_rules:body.validation_rules || {},evidence_rules:body.evidence_rules || {},form_schema:body.form_schema || []
  };
  if(!['free_roam','geo_zone','target_point','digital','survey'].includes(data.task_type))A.fail('Type de mission invalide');
  if(data.total_budget_amount<data.reward_amount)A.fail('Budget inférieur à la récompense');
  if(data.starts_at&&data.ends_at&&data.ends_at<data.starts_at)A.fail('Calendrier inversé');
  for(const k of jsonColumns.filter(k=>k!=='form_schema'))if(!data[k]||typeof data[k]!=='object'||Array.isArray(data[k]))A.fail('Règles invalides');
  const errors=validateSchema(data.form_schema);if(errors.length)A.fail(errors.join(' '));
  const geo=data.geo_rules;
  if(geo.required!==undefined&&typeof geo.required!=='boolean')A.fail('Règle GPS invalide');
  if(geo.radius_m!==undefined&&(!Number.isFinite(geo.radius_m)||geo.radius_m<=0||geo.radius_m>1000000))A.fail('Rayon invalide');
  if(geo.target_coords&&(!Number.isFinite(geo.target_coords.lat)||!Number.isFinite(geo.target_coords.lng)||Math.abs(geo.target_coords.lat)>90||Math.abs(geo.target_coords.lng)>180))A.fail('Coordonnées invalides');
  if(data.task_type==='target_point'&&!geo.target_coords)A.fail('Une cible GPS est requise');
  if(data.eligibility_rules.countries&&(!Array.isArray(data.eligibility_rules.countries)||!data.eligibility_rules.countries.every(c=>typeof c==='string'&&/^[A-Z]{2}$/.test(c))))A.fail('Pays invalides');
  if(data.validation_rules.max_per_user!==undefined)A.integer(data.validation_rules.max_per_user,'Limite par contributeur',1,1000000);
  if(data.validation_rules.auto_validate!==undefined&&typeof data.validation_rules.auto_validate!=='boolean')A.fail('Validation automatique invalide');
  if(data.evidence_rules.min_photos!==undefined)A.integer(data.evidence_rules.min_photos,'Photos minimum',0,100);
  if(data.evidence_rules.max_photos!==undefined)A.integer(data.evidence_rules.max_photos,'Photos maximum',0,100);
  return data;
}
function createCampaign(req,body,organizationId,status='pending_approval') {
  const org=A.orgScope(req,organizationId,true);
  if(!org||!db.prepare('SELECT id FROM organizations WHERE id=?').get(org))A.fail('Entreprise requise');
  const data=payload(body,status==='draft'), id='cmp_'+crypto.randomUUID();
  const keys=Object.keys(data), values=keys.map(k=>jsonColumns.includes(k)?JSON.stringify(data[k]):data[k]);
  db.prepare(`INSERT INTO campaigns(id,organization_id,status,${keys.join(',')}) VALUES(?,?,?,${keys.map(()=>'?').join(',')})`).run(id,org,status,...values);
  return id;
}
function editCampaign(req,id,body) {
  const current=A.resource(req,'campaigns',id,true);
  if(!['draft','pending_approval','paused'].includes(current.status))A.fail('Suspendre la campagne avant modification');
  if(db.prepare('SELECT id FROM submissions WHERE campaign_id=? LIMIT 1').get(id))A.fail('Campagne avec réponses : dupliquer pour modifier le protocole');
  const data=payload({...formatCampaign(current),...body},current.status==='draft');
  const keys=Object.keys(data);
  db.prepare(`UPDATE campaigns SET ${keys.map(k=>k+'=?').join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...keys.map(k=>jsonColumns.includes(k)?JSON.stringify(data[k]):data[k]),id);
}
function changeStatus(req,id,status) {
  const campaign=A.resource(req,'campaigns',id,true);
  const transitions={draft:['pending_approval','archived'],pending_approval:['active','draft','archived'],active:['paused','completed'],paused:['active','completed','archived'],completed:['archived'],archived:[]};
  if(campaign.status===status)return;
  if(!(transitions[campaign.status]||[]).includes(status))A.fail('Transition de campagne invalide');
  if(status==='pending_approval'||status==='active')payload(formatCampaign(campaign));
  if(status==='active') {
    if(!A.MANAGERS.includes(A.role(req)))A.fail('Approbation TOUMA requise',403);
    const org=db.prepare('SELECT * FROM organizations WHERE id=?').get(campaign.organization_id);
    if(org.status!=='approved')A.fail('Entreprise non approuvée');
    if(campaign.ends_at&&campaign.ends_at<new Date().toISOString().slice(0,10))A.fail('Calendrier expiré');
    if(!JSON.parse(campaign.form_schema).length)A.fail('Questionnaire vide');
  }
  db.prepare("UPDATE campaigns SET status=?,published_at=CASE WHEN ?='active' THEN COALESCE(published_at,CURRENT_TIMESTAMP) ELSE published_at END,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(status,status,id);
}
module.exports={formatCampaign,payload,createCampaign,editCampaign,changeStatus};
