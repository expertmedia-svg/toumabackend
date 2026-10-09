const crypto = require('crypto');
const { db } = require('../db/database');
const { validateDynamicForm } = require('./formValidationService');
const { analyzeSubmissionFraud, calculateHaversineDistance } = require('./antiFraudService');
const { validateAndCreditSubmission } = require('./walletService');

function submit(user, payload) {
 return db.transaction(() => {
  const { campaign_id, idempotency_key, answers = {}, evidence = [], location = {}, device_info = {} } = payload;
  if (typeof idempotency_key !== 'string' || idempotency_key.length < 8 || idempotency_key.length > 160) throw new Error('Identifiant de soumission stable requis');
  if (!answers || Array.isArray(answers) || typeof answers !== 'object' || !Array.isArray(evidence) || !location || typeof location !== 'object') throw new Error('Format de soumission invalide');
  const existing = db.prepare('SELECT * FROM submissions WHERE idempotency_key = ?').get(idempotency_key);
  let correction=false;
  if (existing) {
   if (existing.contributor_id !== user.id || existing.campaign_id !== campaign_id) throw new Error('Identifiant de soumission déjà utilisé');
   correction=payload.resubmit===true && existing.status==='correction_requested' && !existing.reward_credited;
   if(correction && (typeof payload.revision_key!=='string'||payload.revision_key.length<8||payload.revision_key.length>160))throw new Error('Identifiant stable de correction requis');
   if(!correction || db.prepare('SELECT id FROM submission_versions WHERE submission_id=? AND revision_key=?').get(existing.id,payload.revision_key))return { success: true, is_duplicate_request: true, submission_id: existing.id, status: existing.status, reward_credited: !!existing.reward_credited };
  }
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaign_id);
  if (!campaign || campaign.status !== 'active') throw new Error('Campagne indisponible');
  const today = new Date().toISOString().slice(0,10);
  if ((campaign.starts_at && campaign.starts_at>today) || (campaign.ends_at && campaign.ends_at<today)) throw new Error('Campagne hors calendrier');
  const organization = db.prepare('SELECT status FROM organizations WHERE id=?').get(campaign.organization_id);
  if (organization?.status==='suspended') throw new Error('Entreprise suspendue');
  const rules = JSON.parse(campaign.validation_rules);
  const eligibility = JSON.parse(campaign.eligibility_rules);
  if (eligibility.countries?.length && !eligibility.countries.includes(user.country_code)) throw new Error('Pays non admissible');
  const levels=['Débutant','Fiable','Confirmé','Expert'];
  if(eligibility.min_reputation && levels.indexOf(user.reputation_level)<levels.indexOf(eligibility.min_reputation)) throw new Error('Niveau de réputation insuffisant');
  const used = db.prepare("SELECT COUNT(*) n,COALESCE(SUM(COALESCE(promised_reward,?)),0) committed FROM submissions WHERE campaign_id = ? AND status != 'rejected' AND id!=?").get(campaign.reward_amount,campaign_id,existing?.id||'');
  const reward=correction?existing.promised_reward:campaign.reward_amount;
  if (used.n >= campaign.max_submissions || used.committed + reward > campaign.total_budget_amount) throw new Error('Budget ou capacité de campagne épuisé');
  if (rules.max_per_user) {
   const n = db.prepare("SELECT COUNT(*) n FROM submissions WHERE campaign_id = ? AND contributor_id = ? AND status != 'rejected' AND id!=?").get(campaign_id, user.id,existing?.id||'').n;
   if (n >= rules.max_per_user) throw new Error('Limite de participations atteinte');
  }
  const schema = JSON.parse(campaign.form_schema);
  const validation = validateDynamicForm(schema, answers, evidence);
  if (!validation.is_valid) throw new Error(validation.errors.map(e => e.message).join(' '));
  for (const proof of evidence) {
   const filename = typeof proof.url === 'string' && proof.url.match(/^\/uploads\/([a-zA-Z0-9_.-]+)$/)?.[1];
   const stored = filename && db.prepare('SELECT * FROM evidence_files WHERE filename = ? AND user_id = ?').get(filename, user.id);
   if (!stored || !schema.some(f => f.id === proof.field_id && ['photo','video','audio','signature'].includes(f.type))) throw new Error('Preuve absente, étrangère ou non téléversée');
   const field = schema.find(f => f.id === proof.field_id);
   const prefix = field.type === 'video' ? 'video/' : field.type === 'audio' ? 'audio/' : 'image/';
   if (!stored.mime_type.startsWith(prefix)) throw new Error('Type de preuve incorrect');
  }
  const geo = JSON.parse(campaign.geo_rules);
  const evidenceRules=JSON.parse(campaign.evidence_rules);
  const photos=evidence.filter(e=>schema.some(f=>f.id===e.field_id && f.type==='photo')).length;
  if(photos<(evidenceRules.min_photos||0) || photos>(evidenceRules.max_photos||100))throw new Error('Nombre de photos non conforme');
  const coordsValid = Number.isFinite(location.lat) && Number.isFinite(location.lng) && Math.abs(location.lat) <= 90 && Math.abs(location.lng) <= 180;
  if ((geo.required || campaign.task_type === 'target_point') && !coordsValid) throw new Error('Position GPS réelle requise');
  if (geo.target_coords && coordsValid && calculateHaversineDistance(location.lat, location.lng, geo.target_coords.lat, geo.target_coords.lng) > (geo.radius_m || 50)) throw new Error('Position hors de la zone autorisée');
  const id = correction?existing.id:'sub_' + crypto.randomUUID();
  const fraud = analyzeSubmissionFraud({ id, contributor_id: user.id, answers, evidence, location, submitted_at: new Date().toISOString() }, campaign);
  const status = fraud.flags.length || correction ? 'under_review' : 'submitted';
  if(correction){
   db.prepare('UPDATE submissions SET status=?,answers=?,evidence=?,location=?,device_info=?,fraud_flags=?,fraud_score=?,rejection_reason=NULL,reviewer_id=NULL,reviewed_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status,JSON.stringify(answers),JSON.stringify(evidence),JSON.stringify(location),JSON.stringify(device_info),JSON.stringify(fraud.flags),fraud.fraud_score,id);
   db.prepare('INSERT INTO submission_reviews(id,submission_id,user_id,action,reason) VALUES(?,?,?,?,?)').run(crypto.randomUUID(),id,user.id,'resubmit','Nouvelle version envoyée par le contributeur');
  }else db.prepare(`INSERT INTO submissions(id,campaign_id,contributor_id,idempotency_key,status,answers,evidence,location,device_info,fraud_flags,fraud_score,promised_reward)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, campaign_id, user.id, idempotency_key, status, JSON.stringify(answers), JSON.stringify(evidence), JSON.stringify(location), JSON.stringify(device_info), JSON.stringify(fraud.flags), fraud.fraud_score, reward);
  db.prepare('INSERT INTO submission_versions(id,submission_id,revision_key,answers,evidence,location) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(),id,correction?payload.revision_key:idempotency_key,JSON.stringify(answers),JSON.stringify(evidence),JSON.stringify(location));
  fraud.flags.forEach((flag, i) => db.prepare('INSERT INTO fraud_signals(id,submission_id,user_id,signal_type,severity,details) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), id, user.id, flag, fraud.fraud_score >= 70 ? 'high' : 'medium', JSON.stringify({ detail: fraud.details[i], score: fraud.fraud_score })));
  let payout = null;
  if (!correction && rules.auto_validate === true && !fraud.flags.length) payout = validateAndCreditSubmission(id, 'auto_validator');
  db.prepare('INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id) VALUES(?,?,?,?,?)').run(crypto.randomUUID(), user.id, 'submit', 'submission', id);
  return { success: true, submission_id: id, status: payout ? 'validated' : status, reward_credited: !!payout, reward_amount: reward, payout };
 }).immediate();
}
module.exports = { submit };
