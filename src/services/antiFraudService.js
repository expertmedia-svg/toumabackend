const { db } = require('../db/database');
const { v4: uuidv4 } = require('uuid');

/**
 * Calculates distance in meters between two GPS coordinates using Haversine formula
 */
function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
  if (lat1 === undefined || lon1 === undefined || lat2 === undefined || lon2 === undefined) {
    return Infinity;
  }
  const R = 6371e3; // Earth radius in meters
  const toRad = (x) => (x * Math.PI) / 180;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const deltaPhi = toRad(lat2 - lat1);
  const deltaLambda = toRad(lon2 - lon1);

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Math.round(R * c);
}

/**
 * Normalizes phone numbers (e.g., "+226 70 12 34 56" -> "22670123456")
 */
function normalizePhone(phone) {
  if (!phone) return '';
  return String(phone).replace(/[^0-9]/g, '');
}

/**
 * Analyzes submission for potential fraud signals:
 * - Duplicate phone within same campaign
 * - Duplicate GPS location within threshold distance (e.g. 20m)
 * - GPS accuracy issues / mock locations
 * - Impossible travel speed between consecutive submissions
 */
function analyzeSubmissionFraud(submission, campaign) {
  const flags = [];
  const details = [];
  let fraudScore = 0;

  const geoRules = typeof campaign.geo_rules === 'string' ? JSON.parse(campaign.geo_rules) : campaign.geo_rules || {};
  const validationRules = typeof campaign.validation_rules === 'string' ? JSON.parse(campaign.validation_rules) : campaign.validation_rules || {};
  const answers = typeof submission.answers === 'string' ? JSON.parse(submission.answers) : submission.answers || {};
  const location = typeof submission.location === 'string' ? JSON.parse(submission.location) : submission.location || {};

  // 1. Target Point Verification (if campaign requires a specific point)
  if (campaign.task_type === 'target_point' && geoRules.target_coords) {
    const target = geoRules.target_coords;
    const allowedRadius = geoRules.radius_m || 50;
    if (!Number.isFinite(location.lat) || !Number.isFinite(location.lng)) {
      flags.push('MISSING_REQUIRED_GPS');
      details.push('Les coordonnées GPS sont obligatoires pour cette vérification sur cible.');
      fraudScore += 80;
    } else {
      const distToTarget = calculateHaversineDistance(location.lat, location.lng, target.lat, target.lng);
      if (distToTarget > allowedRadius) {
        flags.push('OUT_OF_TARGET_RADIUS');
        details.push(`Relevé GPS à ${distToTarget}m de la cible (rayon max autorisé: ${allowedRadius}m).`);
        fraudScore += 60;
      }
    }
  }

  // 2. GPS Accuracy & Mock Location Check
  if (location.lat && location.lng) {
    if (location.is_mock) {
      flags.push('MOCK_LOCATION_DETECTED');
      details.push('Détection d’une application de fausse position GPS (Mock Location).');
      fraudScore += 90;
    }
    if (location.accuracy && location.accuracy > 150) {
      flags.push('LOW_GPS_ACCURACY');
      details.push(`Précision GPS trop faible (${Math.round(location.accuracy)}m > seuil 150m).`);
      fraudScore += 25;
    }
  }

  // 3. Duplicate Phone Check (critical for merchant enrollment like YAAR+)
  const phoneVal = answers.merchant_phone || answers.phone || answers.telephone;
  if (phoneVal) {
    const normalized = normalizePhone(phoneVal);
    if (normalized.length >= 8) {
      // Find other submissions for this campaign with the same phone
      const priorSubmissions = db.prepare(`
        SELECT id, contributor_id, answers, status, created_at
        FROM submissions
        WHERE campaign_id = ? AND id != ? AND status != 'rejected'
      `).all(campaign.id, submission.id || '');

      for (const prior of priorSubmissions) {
        const priorAns = typeof prior.answers === 'string' ? JSON.parse(prior.answers) : prior.answers;
        const priorPhone = normalizePhone(priorAns.merchant_phone || priorAns.phone || priorAns.telephone);
        if (priorPhone && priorPhone === normalized) {
          flags.push('DUPLICATE_PHONE_NUMBER');
          details.push(`Ce numéro de téléphone (${phoneVal}) a déjà été enregistré dans la soumission #${prior.id.slice(0, 8)}.`);
          fraudScore += 80;
          break;
        }
      }
    }
  }

  // 4. Duplicate Location Proximity Check (Spatial Clustering)
  if (location.lat && location.lng && geoRules.duplicate_distance_threshold_m) {
    const thresholdM = geoRules.duplicate_distance_threshold_m || 20;
    const priorLocations = db.prepare(`
      SELECT id, location, answers, status, created_at
      FROM submissions
      WHERE campaign_id = ? AND id != ? AND status != 'rejected'
    `).all(campaign.id, submission.id || '');

    for (const prior of priorLocations) {
      const priorLoc = typeof prior.location === 'string' ? JSON.parse(prior.location) : prior.location;
      if (priorLoc && priorLoc.lat && priorLoc.lng) {
        const dist = calculateHaversineDistance(location.lat, location.lng, priorLoc.lat, priorLoc.lng);
        if (dist <= thresholdM) {
          flags.push('DUPLICATE_GEO_PROXIMITY');
          details.push(`Un commerce a déjà été enregistré à seulement ${dist}m de cette position (seuil anti-doublon: ${thresholdM}m).`);
          fraudScore += 50;
          break;
        }
      }
    }
  }

  // 5. Impossible Speed Anomaly (Teleportation / Bot detection)
  if (location.lat && location.lng && submission.contributor_id) {
    const lastSub = db.prepare(`
      SELECT id, location, created_at
      FROM submissions
      WHERE contributor_id = ? AND id != ?
      ORDER BY created_at DESC LIMIT 1
    `).get(submission.contributor_id, submission.id || '');

    if (lastSub && lastSub.location) {
      const lastLoc = typeof lastSub.location === 'string' ? JSON.parse(lastSub.location) : lastSub.location;
      if (lastLoc.lat && lastLoc.lng) {
        const dist = calculateHaversineDistance(location.lat, location.lng, lastLoc.lat, lastLoc.lng);
        const timeDiffSeconds = Math.max(1, (new Date(submission.submitted_at || Date.now()) - new Date(lastSub.created_at)) / 1000);
        const speedKmH = (dist / 1000) / (timeDiffSeconds / 3600);
        
        // If speed > 130 km/h over significant distance (> 500m)
        if (dist > 500 && speedKmH > 130) {
          flags.push('SPEED_TELEPORTATION_ANOMALY');
          details.push(`Vitesse de déplacement physiquement anormale (${Math.round(speedKmH)} km/h en ${Math.round(timeDiffSeconds)}s).`);
          fraudScore += 75;
        }
      }
    }
  }

  // Cap score between 0 and 100
  for(const proof of submission.evidence || []) {
    const filename=typeof proof.url==='string' && proof.url.match(/^\/uploads\/([a-zA-Z0-9_.-]+)$/)?.[1];
    const file=filename && db.prepare('SELECT sha256 FROM evidence_files WHERE filename=?').get(filename);
    if(file && db.prepare(`SELECT s.id FROM submissions s JOIN json_each(s.evidence) e JOIN evidence_files f ON f.filename=substr(json_extract(e.value,'$.url'),10)
      WHERE s.campaign_id=? AND s.status!='rejected' AND s.id!=? AND f.sha256=? LIMIT 1`).get(campaign.id,submission.id||'',file.sha256)) {
      flags.push('REUSED_EVIDENCE');details.push('Cette preuve a déjà été utilisée. Examen manuel requis.');fraudScore+=70;break;
    }
  }
  fraudScore = Math.min(100, fraudScore);

  // Record signals in database if any flagged and submission exists
  if (flags.length > 0 && submission.id) {
    const subExists = db.prepare('SELECT id FROM submissions WHERE id = ?').get(submission.id);
    if (subExists) {
      const insertSignal = db.prepare(`
        INSERT INTO fraud_signals (id, submission_id, user_id, signal_type, severity, details, created_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `);

      for (let i = 0; i < flags.length; i++) {
        const severity = fraudScore >= 70 ? 'high' : fraudScore >= 40 ? 'medium' : 'low';
        insertSignal.run(
          uuidv4(),
          submission.id,
          submission.contributor_id,
          flags[i],
          severity,
          JSON.stringify({ detail: details[i] || '', score: fraudScore })
        );
      }
    }
  }

  return {
    is_fraud: fraudScore >= 70,
    fraud_score: fraudScore,
    flags,
    details
  };
}

module.exports = {
  calculateHaversineDistance,
  analyzeSubmissionFraud,
  normalizePhone
};
