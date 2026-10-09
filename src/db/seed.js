if (process.env.TOUMA_ALLOW_DEMO_SEED !== 'yes' || !process.env.TOUMA_DB_PATH || !process.env.TOUMA_DB_PATH.includes('demo')) throw new Error('Seed réservé à une base explicitement nommée demo, avec TOUMA_ALLOW_DEMO_SEED=yes');
const { db } = require('./database');
const { v4: uuidv4 } = require('uuid');

function seedDatabase() {
  console.log('Seeding Touma Database...');

  // Reset or ensure tables are ready
  // 1. Settings
  const insertSetting = db.prepare(`
    INSERT OR REPLACE INTO platform_settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
  `);
  insertSetting.run('min_withdrawal', JSON.stringify(500));
  insertSetting.run('referral_reward', JSON.stringify(500));
  insertSetting.run('platform_currency', JSON.stringify('F CFA'));
  insertSetting.run('auto_validation_threshold_score', JSON.stringify(90));

  // 2. Users
  const userCheck = db.prepare('SELECT id FROM users WHERE email = ?').get('rachid@example.com');
  let rachidId = userCheck?.id;

  if (!rachidId) {
    rachidId = 'usr_rachid_001';
    // Insert Rachid (Contributor)
    db.prepare(`
      INSERT INTO users (
        id, name, email, phone, password_hash, role,
        country, country_code, city, avatar_url,
        reputation_level, reputation_score, referral_code, is_verified
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      rachidId,
      'Rachid Ouédraogo',
      'rachid@example.com',
      '+226 70 12 34 56',
      'password123', // In prod: bcrypt hash
      'contributor',
      'Burkina Faso',
      'BF',
      'Ouagadougou',
      'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&q=80&w=250',
      'Fiable',
      120,
      'TOUMA2026',
      1
    );

    // Create Rachid's Wallet with 12 500 F CFA
    const walletId = 'wal_rachid_001';
    db.prepare(`
      INSERT INTO wallets (id, user_id, balance, currency, total_earned, total_withdrawn)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(walletId, rachidId, 12500, 'F CFA', 17500, 5000);

    // Add recent transactions matching the mockup:
    // +50 F (Tâche : Vidéo, 6 oct. 2026, 13:20)
    // +100 F (Tâche : Sondage, 6 oct. 2026, 11:45)
    // -5 000 F (Retrait mobile money, 5 oct. 2026, 16:30)
    db.prepare(`
      INSERT INTO wallet_transactions (
        id, wallet_id, user_id, type, amount, balance_after, description, reference_type, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'tx_001',
      walletId,
      rachidId,
      'withdrawal',
      -5000,
      12350,
      'Retrait mobile money (Orange Money)',
      'withdrawal',
      'completed',
      '2026-10-05 16:30:00'
    );

    db.prepare(`
      INSERT INTO wallet_transactions (
        id, wallet_id, user_id, type, amount, balance_after, description, reference_type, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'tx_002',
      walletId,
      rachidId,
      'task_reward',
      100,
      12450,
      'Tâche : Sondage sur les habitudes d’achat',
      'submission',
      'completed',
      '2026-10-06 11:45:00'
    );

    db.prepare(`
      INSERT INTO wallet_transactions (
        id, wallet_id, user_id, type, amount, balance_after, description, reference_type, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'tx_003',
      walletId,
      rachidId,
      'task_reward',
      50,
      12500,
      'Tâche : Vidéo de formation Touma',
      'submission',
      'completed',
      '2026-10-06 13:20:00'
    );

    // Notifications matching mockup
    const insertNotif = db.prepare(`
      INSERT INTO notifications (id, user_id, type, title, message, is_read, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    insertNotif.run(
      'notif_001',
      rachidId,
      'payment',
      'Récompense reçue',
      'Vous avez gagné 50 F CFA pour la mission "Regarder une vidéo"',
      0,
      '2026-10-06 13:55:00'
    );

    insertNotif.run(
      'notif_002',
      rachidId,
      'task',
      'Nouvelle tâche disponible',
      'Découvrez une nouvelle mission YAAR+ dans votre zone !',
      0,
      '2026-10-06 13:00:00'
    );

    insertNotif.run(
      'notif_003',
      rachidId,
      'payment',
      'Retrait réussi',
      'Votre retrait de 5 000 F CFA vers Orange Money a été effectué avec succès.',
      1,
      '2026-10-05 17:00:00'
    );

    insertNotif.run(
      'notif_004',
      rachidId,
      'system',
      'Bienvenue sur Touma !',
      'Merci de nous rejoindre 🎉 Accomplissez vos premières tâches dès maintenant !',
      1,
      '2026-10-04 10:00:00'
    );
  }

  // 3. Organizations & Business Users
  let orgYaar = db.prepare('SELECT id FROM organizations WHERE slug = ?').get('yaar-plus');
  let orgYaarId = orgYaar?.id;
  if (!orgYaarId) {
    orgYaarId = 'org_yaar_001';
    db.prepare(`
      INSERT INTO organizations (id, name, slug, description, logo_url, industry, balance, contact_email, contact_phone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orgYaarId,
      'YAAR+ Burkina',
      'yaar-plus',
      'Plateforme de commerce et de distribution de proximité au Burkina Faso',
      'https://images.unsplash.com/photo-1542838132-92c53300491e?auto=format&fit=crop&q=80&w=200',
      'Distribution & E-commerce',
      250000,
      'contact@yaarplus.bf',
      '+226 25 30 11 22'
    );

    const businessUserId = 'usr_awa_002';
    db.prepare(`
      INSERT INTO users (id, name, email, phone, password_hash, role, country, city, referral_code, is_verified)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      businessUserId,
      'Awa Kaboré (YAAR+)',
      'awa@yaarplus.bf',
      '+226 76 54 32 10',
      'password123',
      'business',
      'Burkina Faso',
      'Ouagadougou',
      'YAAR2026',
      1
    );

    db.prepare(`
      INSERT INTO organization_members (id, organization_id, user_id, role)
      VALUES (?, ?, ?, ?)
    `).run('mem_001', orgYaarId, businessUserId, 'owner');
  }

  // Admin user
  const adminUser = db.prepare('SELECT id FROM users WHERE email = ?').get('admin@touma.africa');
  if (!adminUser) {
    db.prepare(`
      INSERT INTO users (id, name, email, phone, password_hash, role, country, city, referral_code, is_verified)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'usr_admin_001',
      'Directeur des Opérations TOUMA',
      'admin@touma.africa',
      '+226 70 00 00 00',
      'adminpassword123',
      'admin',
      'Burkina Faso',
      'Ouagadougou',
      'TOUMAADMIN',
      1
    );
  }

  // 4. Seed Campaigns
  const campaignCount = db.prepare('SELECT COUNT(*) as count FROM campaigns').get();
  if (campaignCount.count === 0) {
    const insertCampaign = db.prepare(`
      INSERT INTO campaigns (
        id, organization_id, title, description, category, task_type,
        reward_amount, currency, total_budget_amount, max_submissions,
        completed_submissions, estimated_duration_min, status,
        geo_rules, eligibility_rules, validation_rules, evidence_rules,
        form_schema, instructions_text, icon_name, badge_color
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // 1. YAAR+ Enrollment (Terrain, GPS required, camera proof, anti-fraud)
    const yaarFormSchema = [
      {
        id: 'store_photo',
        type: 'photo',
        label: 'Photo de la façade du commerce',
        description: 'Prenez une photo nette montrant l’enseigne ou l’étalage.',
        required: true,
        camera_only: true, // anti-fraud: camera only
        step: 1
      },
      {
        id: 'store_name',
        type: 'short_text',
        label: 'Nom de la boutique / du commerce',
        placeholder: 'Ex: Alimentation Wend-Panga',
        required: true,
        step: 2
      },
      {
        id: 'category',
        type: 'select',
        label: 'Catégorie d’activité',
        required: true,
        options: ['Alimentation générale', 'Boutique de vêtements', 'Quincaillerie', 'Kiosque / Restauration', 'Pharmacie / Dépôt', 'Électronique & Mobile', 'Autre'],
        step: 2
      },
      {
        id: 'merchant_phone',
        type: 'phone',
        label: 'Numéro de téléphone du commerçant',
        placeholder: '+226 70 00 00 00',
        required: true,
        validation_regex: '^\\+?[0-9]{8,15}$',
        step: 2
      },
      {
        id: 'gps_coords',
        type: 'gps',
        label: 'Position GPS exacte du commerce',
        description: 'Positionnez-vous devant la porte du commerce pour une précision maximale.',
        required: true,
        step: 3
      },
      {
        id: 'is_open_daily',
        type: 'boolean',
        label: 'Le commerce est-il ouvert tous les jours ?',
        required: true,
        step: 4
      },
      {
        id: 'opening_hours',
        type: 'short_text',
        label: 'Horaires d’ouverture',
        placeholder: 'Ex: 07h30 - 21h00',
        required: false,
        condition: {
          field_id: 'is_open_daily',
          operator: 'equals',
          value: true
        },
        step: 4
      }
    ];

    insertCampaign.run(
      'cmp_yaar_001',
      orgYaarId,
      'Enrôler un commerce YAAR+',
      'Recensez une boutique, une épicerie ou un maquis dans votre quartier pour l’intégrer au réseau YAAR+.',
      'Terrain',
      'free_roam', // Contributor finds qualifying shop in their area
      25,
      'F CFA',
      250000,
      10000,
      28,
      5,
      'active',
      JSON.stringify({
        required: true,
        radius_m: 30,
        duplicate_distance_threshold_m: 20 // If within 20m + same phone, detected as duplicate
      }),
      JSON.stringify({ min_reputation: 'Débutant', countries: ['BF'] }),
      JSON.stringify({ auto_validate: false, duplicate_check: true, max_per_user: 100 }),
      JSON.stringify({ camera_only: true, min_photos: 1, max_photos: 2 }),
      JSON.stringify(yaarFormSchema),
      `Instructions :
1. Demandez poliment l'accord au commerçant.
2. Photographiez la façade extérieure en plein jour.
3. Renseignez fidèlement le nom, le numéro et la catégorie.
4. Activez votre GPS devant la boutique pour capter la position.
5. Validez l'envoi dès que tout est complet.`,
      'store',
      'green'
    );

    // 2. Video task (Matching mockup #1 task: "Regarder une vidéo", + 50 F)
    const videoFormSchema = [
      {
        id: 'watched_confirmation',
        type: 'boolean',
        label: 'Avez-vous visionné la vidéo jusqu’à la fin ?',
        required: true,
        step: 1
      },
      {
        id: 'video_quiz',
        type: 'single_choice',
        label: 'Quel est l’avantage principal de TOUMA mentionné ?',
        required: true,
        options: ['Gagner des revenus en effectuant des tâches simples', 'Acheter des téléphones', 'Regarder des films en streaming'],
        step: 1
      }
    ];

    insertCampaign.run(
      'cmp_video_002',
      orgYaarId,
      'Regarder une vidéo',
      'Regardez la vidéo jusqu’à la fin pour recevoir votre récompense.',
      'Vidéos',
      'digital',
      50,
      'F CFA',
      50000,
      1000,
      412,
      2,
      'active',
      JSON.stringify({ required: false }),
      JSON.stringify({ min_reputation: 'Débutant' }),
      JSON.stringify({ auto_validate: true, duplicate_check: false, max_per_user: 1 }),
      JSON.stringify({ camera_only: false }),
      JSON.stringify(videoFormSchema),
      `Instructions :
1. Cliquez sur le bouton ci-dessous pour lancer la vidéo.
2. Regardez la vidéo en entier sans l'accélérer.
3. Répondez à la question de contrôle pour valider vos 50 F.`,
      'play',
      'purple'
    );

    // 3. Survey task (Matching mockup #2 task: "Répondre à un sondage", + 100 F)
    const surveyFormSchema = [
      {
        id: 'shopped_this_week',
        type: 'boolean',
        label: 'Avez-vous fait des achats au marché cette semaine ?',
        required: true,
        step: 1
      },
      {
        id: 'main_goods',
        type: 'multiple_choice',
        label: 'Quels produits achetez-vous le plus souvent ?',
        required: true,
        options: ['Riz & Céréales', 'Huile & Condiments', 'Légumes frais', 'Produits d’hygiène', 'Viande / Poisson'],
        step: 1
      },
      {
        id: 'avg_budget',
        type: 'select',
        label: 'Quel est votre budget moyen par visite ?',
        required: true,
        options: ['Moins de 2 000 F', '2 000 F à 5 000 F', '5 000 F à 10 000 F', 'Plus de 10 000 F'],
        step: 2
      },
      {
        id: 'satisfaction_rating',
        type: 'rating',
        label: 'Note de satisfaction globale de vos commerces de quartier (1 à 5)',
        required: true,
        min: 1,
        max: 5,
        step: 2
      },
      {
        id: 'feedback_comment',
        type: 'long_text',
        label: 'Remarques ou améliorations souhaitées',
        placeholder: 'Partagez votre avis...',
        required: false,
        step: 2
      }
    ];

    insertCampaign.run(
      'cmp_survey_003',
      orgYaarId,
      'Répondre à un sondage',
      'Donnez votre avis sur vos habitudes d’achat et la disponibilité des produits dans votre commune.',
      'Enquêtes',
      'survey',
      100,
      'F CFA',
      100000,
      1000,
      180,
      5,
      'active',
      JSON.stringify({ required: false }),
      JSON.stringify({ min_reputation: 'Débutant' }),
      JSON.stringify({ auto_validate: true }),
      JSON.stringify({}),
      JSON.stringify(surveyFormSchema),
      `Instructions :
1. Répondez sincèrement à toutes les questions posées.
2. Votre avis aide les acteurs locaux à améliorer leur approvisionnement.
3. Recevez 100 F CFA immédiatement après soumission.`,
      'clipboard',
      'blue'
    );

    // 4. App testing task (Matching mockup: "Tester une application", + 200 F)
    const appFormSchema = [
      {
        id: 'app_rating',
        type: 'rating',
        label: 'Note de l’application testée',
        required: true,
        min: 1,
        max: 5,
        step: 1
      },
      {
        id: 'found_bugs',
        type: 'boolean',
        label: 'Avez-vous rencontré un blocage ou un bug ?',
        required: true,
        step: 1
      },
      {
        id: 'bug_details',
        type: 'long_text',
        label: 'Décrivez le bug rencontré',
        required: false,
        condition: { field_id: 'found_bugs', operator: 'equals', value: true },
        step: 1
      },
      {
        id: 'screenshot',
        type: 'photo',
        label: 'Capture d’écran de confirmation',
        required: true,
        camera_only: false,
        step: 2
      }
    ];

    insertCampaign.run(
      'cmp_app_004',
      orgYaarId,
      'Tester une application',
      'Téléchargez et testez la nouvelle version bêta d’une application de livraison.',
      'Apps',
      'digital',
      200,
      'F CFA',
      150000,
      750,
      95,
      10,
      'active',
      JSON.stringify({ required: false }),
      JSON.stringify({ min_reputation: 'Fiable' }),
      JSON.stringify({ auto_validate: false }),
      JSON.stringify({ min_photos: 1 }),
      JSON.stringify(appFormSchema),
      `Instructions :
1. Installez l'application via le lien fourni.
2. Naviguez sur les 3 premiers écrans.
3. Faites une capture d'écran et donnez votre note.`,
      'smartphone',
      'green'
    );

    // 5. Review task (Matching mockup: "Laisser un avis", + 75 F)
    const reviewFormSchema = [
      {
        id: 'service_name',
        type: 'select',
        label: 'Service évalué',
        required: true,
        options: ['Poste Burkina', 'Onea Agence Centrale', 'Sonabel Guichet', 'Mairie d’Arrondissement'],
        step: 1
      },
      {
        id: 'speed_rating',
        type: 'rating',
        label: 'Rapidité de prise en charge (1 à 5)',
        required: true,
        min: 1,
        max: 5,
        step: 1
      },
      {
        id: 'review_text',
        type: 'long_text',
        label: 'Votre avis argumenté',
        placeholder: 'Expliquez votre expérience en quelques lignes...',
        required: true,
        step: 2
      }
    ];

    insertCampaign.run(
      'cmp_review_005',
      orgYaarId,
      'Laisser un avis',
      'Partagez votre retour d’expérience sur l’accueil dans un service public ou une agence.',
      'Enquêtes',
      'digital',
      75,
      'F CFA',
      75000,
      1000,
      210,
      3,
      'active',
      JSON.stringify({ required: false }),
      JSON.stringify({ min_reputation: 'Débutant' }),
      JSON.stringify({ auto_validate: true }),
      JSON.stringify({}),
      JSON.stringify(reviewFormSchema),
      `Instructions :
1. Sélectionnez le service visité au cours du dernier mois.
2. Notez l'accueil et le temps d'attente.
3. Rédigez un court commentaire constructif.`,
      'message-square',
      'orange'
    );

    // 6. Web visit task (Matching mockup: "Visiter un site web", + 50 F)
    const webFormSchema = [
      {
        id: 'confirmation_code',
        type: 'short_text',
        label: 'Code affiché en bas de la page partenaire',
        placeholder: 'Ex: TOUMA-PARTNER-77',
        required: true,
        step: 1
      }
    ];

    insertCampaign.run(
      'cmp_web_006',
      orgYaarId,
      'Visiter un site web',
      'Découvrez le site web d’une initiative locale et récupérez le code de confirmation.',
      'Digital',
      'digital',
      50,
      'F CFA',
      40000,
      800,
      350,
      2,
      'active',
      JSON.stringify({ required: false }),
      JSON.stringify({ min_reputation: 'Débutant' }),
      JSON.stringify({ auto_validate: true }),
      JSON.stringify({}),
      JSON.stringify(webFormSchema),
      `Instructions :
1. Visitez le site partenaire via le lien.
2. Faites défiler jusqu'au pied de page pour copier le code partenaire.
3. Renseignez le code pour valider votre gain.`,
      'globe',
      'blue'
    );

    // 7. Referral task (Matching mockup: "Inviter un ami", + 500 F)
    insertCampaign.run(
      'cmp_referral_007',
      orgYaarId,
      'Inviter un ami',
      'Partagez votre code parrainage unique avec un proche et gagnez 500 F dès sa première tâche validée.',
      'Autres',
      'digital',
      500,
      'F CFA',
      500000,
      1000,
      120,
      1,
      'active',
      JSON.stringify({ required: false }),
      JSON.stringify({ min_reputation: 'Débutant' }),
      JSON.stringify({ auto_validate: true }),
      JSON.stringify({}),
      JSON.stringify([]),
      `Instructions :
1. Copiez votre code de parrainage TOUMA2026.
2. Partagez le lien avec vos contacts WhatsApp ou SMS.
3. Dès que votre filleul valide sa première tâche, 500 F CFA sont crédités sur votre portefeuille.`,
      'users',
      'green'
    );

    // 8. Field verification task (Predefined target point)
    const verifyFormSchema = [
      {
        id: 'store_status',
        type: 'single_choice',
        label: 'Le commerce est-il toujours en activité à cette adresse ?',
        required: true,
        options: ['Oui, ouvert et actif', 'Fermé temporairement', 'Fermé définitivement / Changement d’activité'],
        step: 1
      },
      {
        id: 'gps_coords',
        type: 'gps',
        label: 'Relevé GPS sur place',
        required: true,
        step: 2
      },
      {
        id: 'photo_proof',
        type: 'photo',
        label: 'Photo actuelle du lieu',
        required: true,
        camera_only: true,
        step: 3
      },
      {
        id: 'comment',
        type: 'short_text',
        label: 'Précisions supplémentaires',
        placeholder: 'Ex: Nouveau gérant ou travaux...',
        required: false,
        step: 3
      }
    ];

    insertCampaign.run(
      'cmp_verify_008',
      orgYaarId,
      'Vérifier un point de vente',
      'Rendez-vous à l’Alimentation Wend-Kuni (Grand Marché Ouaga) pour vérifier si le commerce est toujours ouvert.',
      'Vérification',
      'target_point',
      75,
      'F CFA',
      75000,
      50,
      14,
      4,
      'active',
      JSON.stringify({
        required: true,
        target_coords: { lat: 12.3685, lng: -1.5271, name: 'Boutique Wend-Kuni' },
        radius_m: 50 // Must be within 50 meters
      }),
      JSON.stringify({ min_reputation: 'Fiable' }),
      JSON.stringify({ auto_validate: false }),
      JSON.stringify({ camera_only: true, min_photos: 1 }),
      JSON.stringify(verifyFormSchema),
      `Instructions :
1. Rendez-vous au Grand Marché de Ouagadougou aux coordonnées indiquées.
2. Vérifiez la présence de l'enseigne "Alimentation Wend-Kuni".
3. Photographiez l'état actuel et validez le relevé GPS.`,
      'check-circle',
      'orange'
    );
  }

  console.log('Seeding completed successfully!');
}

seedDatabase();
