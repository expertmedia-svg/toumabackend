const TYPES = ['text','short_text','long_text','number','amount','boolean','select','single_choice','multiple_choice','photo','video','audio','gps','phone','date','time','rating','signature','consent'];
function visible(field, answers) { return !field.condition || answers[field.condition.field_id] === field.condition.value; }
function validateSchema(schema) {
 if (!Array.isArray(schema) || schema.length > 100) return ['Schéma invalide'];
 const ids = new Set();
 const errors = [];
 for (const f of schema) {
  if (!f || typeof f.id !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(f.id) || ids.has(f.id) || !TYPES.includes(f.type) || typeof f.label !== 'string' || !f.label.trim()) errors.push('Champ invalide ou identifiant dupliqué');
  if (f?.condition && (!ids.has(f.condition.field_id) || !['equals',undefined].includes(f.condition.operator))) errors.push('Condition : référence à un champ précédent requise');
  if (['select','single_choice','multiple_choice'].includes(f?.type) && (!Array.isArray(f.options) || !f.options.length || !f.options.every(x=>typeof x==='string'))) errors.push('Options requises');
  if (f?.step !== undefined && (!Number.isSafeInteger(f.step) || f.step < 1 || f.step > 50)) errors.push('Étape invalide');
  if (f?.id) ids.add(f.id);
 }
 return errors;
}
function validateDynamicForm(schema, answers, evidence = []) {
 const errors = [];
 const fail = (f, message) => errors.push({field_id:f.id,message:`${f.label} : ${message}`});
 for (const f of schema) {
  if (!visible(f,answers)) continue;
  const v = answers[f.id];
  const media = ['photo','video','audio','signature'].includes(f.type);
  const proof = evidence.find(e=>e.field_id===f.id && typeof e.url==='string');
  if (media) { if (f.required && !proof) fail(f,'preuve requise'); continue; }
  if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) { if (f.required) fail(f,'obligatoire'); continue; }
  if (['text','short_text','long_text'].includes(f.type) && (typeof v !== 'string' || v.length > (f.max_length || 10000))) fail(f,'texte invalide');
  if (['number','amount','rating'].includes(f.type)) {
   const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
   const min = f.min ?? (f.type === 'rating' ? 1 : -Infinity);
   const max = f.max ?? (f.type === 'rating' ? 5 : Infinity);
   if (!Number.isFinite(n) || n < min || n > max || (f.type==='rating' && !Number.isInteger(n))) fail(f,'nombre hors limites');
  }
  if (f.type === 'boolean' && typeof v !== 'boolean') fail(f,'oui/non attendu');
  if (f.type === 'consent' && (typeof v !== 'boolean' || (f.required && v!==true))) fail(f,'consentement explicite requis');
  if (['select','single_choice'].includes(f.type) && !f.options.includes(v)) fail(f,'choix invalide');
  if (f.type === 'multiple_choice' && (!Array.isArray(v) || !v.every(x=>f.options.includes(x)) || new Set(v).size!==v.length)) fail(f,'choix multiples invalides');
  if (f.type === 'gps' && (!Number.isFinite(v.lat) || !Number.isFinite(v.lng) || Math.abs(v.lat)>90 || Math.abs(v.lng)>180)) fail(f,'coordonnées invalides');
  if (f.type === 'phone' && (typeof v !== 'string' || !/^\+?[0-9 ()-]{8,24}$/.test(v))) fail(f,'téléphone invalide');
  if (f.type === 'date' && (typeof v!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0,10)!==v)) fail(f,'date invalide');
  if (f.type === 'time' && (typeof v!=='string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v))) fail(f,'heure invalide');
 }
 return {is_valid:!errors.length,errors};
}
module.exports = {validateSchema,validateDynamicForm,visible,TYPES};
