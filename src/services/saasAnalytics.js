const {db}=require('../db/database');
const A=require('./saasAccess');
function period(query) {
  const today=new Date(), end=A.date(query.to || today.toISOString().slice(0,10),'Fin');
  const startDate=new Date(today);startDate.setUTCDate(startDate.getUTCDate()-29);
  const start=A.date(query.from || startDate.toISOString().slice(0,10),'Début');
  if(start>end || (Date.parse(end)-Date.parse(start))/86400000>366)A.fail('Période invalide (366 jours maximum)');
  return {from:start,to:end};
}
function campaignAnalysis(req,id,query={}) {
  const campaign=A.resource(req,'campaigns',id);
  const {from,to}=period(query);
  const args=[id,from,to];let sql='SELECT s.*,CASE WHEN u.city_confirmed=1 THEN u.city END city,u.name contributor_name FROM submissions s JOIN users u ON u.id=s.contributor_id WHERE s.campaign_id=? AND DATE(s.submitted_at) BETWEEN ? AND ?';
  if(query.status){sql+=' AND s.status=?';args.push(query.status);}
  if(query.region){sql+=' AND u.city=? AND u.city_confirmed=1';args.push(query.region);}
  const rows=db.prepare(sql+' ORDER BY s.submitted_at').all(...args);
  const validated=rows.filter(s=>s.status==='validated');
  const frequency=values=>Object.entries(values.reduce((acc,v)=>{acc[v]=(acc[v]||0)+1;return acc;},{})).map(([label,count])=>({label,count}));
  const questions=JSON.parse(campaign.form_schema).map(field=>{
    const values=validated.map(s=>JSON.parse(s.answers)[field.id]).filter(v=>v!==undefined&&v!==null&&v!=='');
    const numeric=['number','amount','rating'].includes(field.type);
    const numbers=numeric?values.map(Number).filter(Number.isFinite):[];
    const distributions=['boolean','select','single_choice','multiple_choice','consent'].includes(field.type)?frequency(values.flatMap(v=>Array.isArray(v)?v:typeof v==='boolean'?(v?'Oui':'Non'):String(v))):[];
    return {id:field.id,label:field.label,type:field.type,answered:values.length,mean:numbers.length?numbers.reduce((a,b)=>a+b,0)/numbers.length:null,min:numbers.length?Math.min(...numbers):null,max:numbers.length?Math.max(...numbers):null,distribution:distributions};
  });
  return {campaign_id:id,title:campaign.title,organization_id:campaign.organization_id,objective:campaign.objective,from,to,region:query.region||null,status:query.status||null,total:rows.length,validated:validated.length,rejected:rows.filter(s=>s.status==='rejected').length,unique_contributors:new Set(rows.map(s=>s.contributor_id)).size,validation_rate:rows.length?validated.length/rows.length*100:null,fraud_flagged:rows.filter(s=>JSON.parse(s.fraud_flags).length).length,regions:frequency(rows.map(s=>s.city||'Non renseigné')),timeline:frequency(rows.map(s=>s.submitted_at.slice(0,10))),questions};
}
function dashboard(req,query) {
  const {from,to}=period(query), org=A.orgScope(req,query.organization_id);
  const orgArgs=org?[org]:[];
  const orgWhere=org?' WHERE organization_id=?':'';
  const campaigns=db.prepare('SELECT * FROM campaigns'+orgWhere).all(...orgArgs);
  const campaignIds=JSON.stringify(campaigns.map(c=>c.id));
  const submissions=db.prepare(`SELECT s.*,CASE WHEN u.city_confirmed=1 THEN u.city END city FROM submissions s JOIN users u ON u.id=s.contributor_id WHERE s.campaign_id IN (SELECT value FROM json_each(?)) AND DATE(s.submitted_at) BETWEEN ? AND ?`).all(campaignIds,from,to);
  const validatedEvents=db.prepare("SELECT reviewed_at FROM submissions WHERE campaign_id IN (SELECT value FROM json_each(?)) AND status='validated' AND DATE(reviewed_at) BETWEEN ? AND ?").all(campaignIds,from,to);
  const studies=db.prepare('SELECT * FROM studies'+orgWhere).all(...orgArgs);
  const published=campaigns.filter(c=>c.published_at&&c.published_at.slice(0,10)>=from&&c.published_at.slice(0,10)<=to);
  const reports=db.prepare('SELECT COUNT(*) n FROM reports'+orgWhere).get(...orgArgs).n;
  const earned=db.prepare("SELECT COALESCE(SUM(t.amount),0) n FROM wallet_transactions t JOIN submissions s ON s.id=t.reference_id WHERE t.type='task_reward' AND s.campaign_id IN (SELECT value FROM json_each(?)) AND DATE(t.created_at) BETWEEN ? AND ?").get(campaignIds,from,to).n;
  const withdrawals=A.staff(req)?db.prepare("SELECT DATE(created_at) date,SUM(amount) amount FROM withdrawals WHERE status='completed' AND DATE(created_at) BETWEEN ? AND ? GROUP BY DATE(created_at)").all(from,to):[];
  const valid=submissions.filter(s=>s.status==='validated');
  const totalBudget=campaigns.reduce((sum,c)=>sum+c.total_budget_amount,0);
  const days=[];for(let d=new Date(from);d<=new Date(to);d.setUTCDate(d.getUTCDate()+1)){
    const day=d.toISOString().slice(0,10);
    days.push({date:day,published:published.filter(c=>c.published_at.slice(0,10)===day).reduce((n,c)=>n+c.max_submissions,0),realized:submissions.filter(s=>s.submitted_at.slice(0,10)===day).length,validated:validatedEvents.filter(s=>s.reviewed_at.slice(0,10)===day).length});
  }
  const freq=(arr,key)=>Object.entries(arr.reduce((acc,row)=>{const val=row[key]||'Non renseigné';acc[val]=(acc[val]||0)+1;return acc;},{})).map(([label,count])=>({label,count}));
  const targetRow=db.prepare("SELECT value FROM platform_settings WHERE key='monthly_validation_goal'").get();
  const monthlyGoal=targetRow?JSON.parse(targetRow.value):null;
  const monthValid=db.prepare("SELECT COUNT(*) n FROM submissions WHERE status='validated' AND strftime('%Y-%m',reviewed_at)=strftime('%Y-%m','now')").get().n;
  let activitySql='SELECT a.*,u.name actor FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id';const activityArgs=[];
  if(org){activitySql+=` WHERE (a.entity_type='campaign' AND a.entity_id IN (SELECT id FROM campaigns WHERE organization_id=?)) OR (a.entity_type='study' AND a.entity_id IN (SELECT id FROM studies WHERE organization_id=?)) OR (a.entity_type='report' AND a.entity_id IN (SELECT id FROM reports WHERE organization_id=?))`;activityArgs.push(org,org,org);}
  const activity=db.prepare(activitySql+' ORDER BY a.created_at DESC,a.rowid DESC LIMIT 12').all(...activityArgs);
  const categoryCapacity=Object.entries(published.reduce((acc,c)=>{acc[c.category]=(acc[c.category]||0)+c.max_submissions;return acc;},{})).map(([label,count])=>({label,count}));
  const ratingValues=valid.flatMap(s=>{const schema=JSON.parse(campaigns.find(c=>c.id===s.campaign_id).form_schema),answers=JSON.parse(s.answers);const field=schema.find(f=>f.type==='rating'&&(f.min??1)===1&&(f.max??5)===5);const value=field?Number(answers[field.id]):NaN;return Number.isInteger(value)&&value>=1&&value<=5?[value]:[];});
  const satisfaction=ratingValues.length?{mean:ratingValues.reduce((n,v)=>n+v,0)/ratingValues.length,count:ratingValues.length,distribution:[1,2,3,4,5].map(v=>({label:'Note '+v+'/5',count:ratingValues.filter(r=>r===v).length}))}:null;
  return {from,to,organization_id:org,kpis:{organizations:A.staff(req)?db.prepare('SELECT COUNT(*) n FROM organizations').get().n:null,studies:studies.length,active_campaigns:campaigns.filter(c=>c.status==='active').length,published_missions:published.reduce((n,c)=>n+c.max_submissions,0),active_contributors:new Set(submissions.map(s=>s.contributor_id)).size,payments_completed:withdrawals.reduce((n,w)=>n+w.amount,0),campaigns:campaigns.length,missions_realized:submissions.length,results:valid.length,budget_spent:earned,total_budget:totalBudget,reports},timeline:days,categories:categoryCapacity,regions:freq(submissions,'city'),satisfaction,users:A.staff(req)?db.prepare('SELECT DATE(created_at) date,COUNT(*) count FROM users WHERE DATE(created_at) BETWEEN ? AND ? GROUP BY DATE(created_at)').all(from,to):[],payments:withdrawals,activity,monthly_goal:monthlyGoal,monthly_validated:monthValid};
}
module.exports={period,campaignAnalysis,dashboard};
