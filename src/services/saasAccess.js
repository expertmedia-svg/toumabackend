const { db } = require('../db/database');
const STAFF = ['admin','super_admin','study_manager','quality_controller'];
const MANAGERS = ['admin','super_admin','study_manager'];
const role = req => req.user.account_role || req.user.role;
const staff = req => STAFF.includes(role(req));
const admin = req => ['admin','super_admin'].includes(role(req));
function allow(roles) { return (req,res,next) => roles.includes(role(req)) ? next() : res.status(403).json({error:'Accès non autorisé à ce module'}); }
function fail(message, status=400) { const error = new Error(message); error.status = status; throw error; }
function orgScope(req, requested, write=false) {
  if (staff(req)) return requested || null;
  const memberships = db.prepare('SELECT m.*,o.status FROM organization_members m JOIN organizations o ON o.id=m.organization_id WHERE m.user_id=? ORDER BY m.created_at,m.id').all(req.user.id);
  const member = requested ? memberships.find(m=>m.organization_id===requested) : memberships[0];
  if (!member) fail('Aucune organisation autorisée',403);
  if (member.status === 'suspended') fail('Organisation suspendue',403);
  if (write && (role(req)!=='business' || !['owner','manager'].includes(member.role))) fail('Un administrateur entreprise est requis',403);
  return member.organization_id;
}
function resource(req, table, id, write=false) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
  if (!row) fail('Élément introuvable',404);
  orgScope(req,table==='organizations'?row.id:row.organization_id,write);
  return row;
}
function pagination(query) {
  const page = Number(query.page || 1), pageSize = Number(query.page_size || 20);
  if (!Number.isSafeInteger(page) || page<1 || !Number.isSafeInteger(pageSize) || pageSize<1 || pageSize>100) fail('Pagination invalide');
  return {page,pageSize,offset:(page-1)*pageSize};
}
function list(sql, args, query) {
  const {page,pageSize,offset}=pagination(query);
  const total = db.prepare(`SELECT COUNT(*) total FROM (${sql})`).get(...args).total;
  return {items:db.prepare(sql+' LIMIT ? OFFSET ?').all(...args,pageSize,offset),total,page,page_size:pageSize};
}
function text(value,label,max=10000,optional=false) {
  if (optional && (value==null || value==='')) return '';
  if (typeof value!=='string' || !value.trim() || value.length>max) fail(`${label} : texte requis (${max} caractères maximum)`);
  return value.trim();
}
function integer(value,label,min=0,max=1000000000) { if (!Number.isSafeInteger(value)||value<min||value>max) fail(`${label} : entier entre ${min} et ${max} requis`);return value; }
function date(value,label,optional=false) { if(optional&&!value)return null; if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)fail(`${label} : date invalide`);return value; }
module.exports = {STAFF,MANAGERS,role,staff,admin,allow,fail,orgScope,resource,pagination,list,text,integer,date};
