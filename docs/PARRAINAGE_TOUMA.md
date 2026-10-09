# Parrainage TOUMA — intégration

## Règles mises en œuvre

Sur instruction explicite du propriétaire du projet, un code valide suffit : le compte est activé et les 100 FCFA sont crédités dans la même transaction que l’inscription, sans OTP, validation administrative ou première mission. L’inscription sans code reste possible. Le téléphone est facultatif, normalisé et unique lorsqu’il est fourni ; il n’est pas déclaré vérifié. Sans vérification d’identité ou SMS, l’unicité d’une personne possédant plusieurs emails et numéros ne peut pas être garantie.

Chaque relation directe conserve le taux acquis à sa création (initialement 1 000 points de base = 10 %), sans date d’expiration. Les changements Admin produisent une nouvelle version des règles pour les inscriptions suivantes. Les anciens crédits restent conservés. Une éventuelle ancienne promesse de bonus au parrain après première mission, créée avant cette migration, reste honorée par la branche legacy ; les nouveaux parrainages n’utilisent plus cette règle.

Le portefeuille contient de véritables écritures `referral_welcome`, `referral_commission` et, en cas de remboursement, `referral_commission_reversal`. Aucun solde n’est fabriqué dans les interfaces.

## Provenance et paiements

Les crédits alimentent des lots de financement. Les retraits consomment les lots dans l’ordre chronologique, puis par ordre d’insertion pour les dates identiques (FIFO). Seuls les lots `task_reward` contribuent à l’assiette de commission. Les bonus, anciennes primes de parrainage, commissions et crédits non identifiés sont exclus. Les annulations rétablissent les lots d’origine et ne créent pas de nouveaux gains éligibles. La migration préserve les soldes existants ; les sources inconnues restent non éligibles. Les retraits déjà demandés avant la migration ne génèrent pas de commission rétroactive.

Le calcul utilise des entiers et BigInt : `part_eligible * rate_bps / 10000`, arrondi au franc inférieur. Exemple : un retrait comprenant 100 FCFA de bonus et 5 000 FCFA de missions donne une assiette de 5 000 et une commission de 500. Le retrait du filleul reste intégral : aucune commission n’est déduite de son paiement.

La demande de retrait ne crédite rien au parrain. Une commission `pending` devient `credited` après confirmation du paiement ; elle reste `held` si le parrain est suspendu ou si la relation est restreinte. L’annulation la passe à `cancelled`. Les écritures et la référence du paiement sont uniques et les transactions SQLite utilisent le verrou immédiat.

Il n’y a pas de prestataire Mobile Money automatique configuré. Dans **Admin → Paiements → Demandes de retrait**, l’administrateur confirme uniquement un paiement réellement effectué à l’extérieur, avec référence, justificatif et confirmation explicite. L’API n’envoie aucun argent. La décision et son auteur sont audités. Ces endpoints peuvent être réutilisés par une future intégration serveur avec authentification appropriée ; ils ne constituent pas un webhook public.

La régularisation d’un retrait confirmé n’est autorisée qu’après remboursement réel. Elle reprend sa commission si le lot correspondant est encore disponible. Si cette commission a été dépensée ou réservée, l’opération renvoie 409 : il faut d’abord annuler les réservations ou recouvrer les fonds. Aucun solde négatif ou crédit de remboursement partiel n’est introduit. Une répétition du remboursement est sans second crédit.

## Interfaces

Flutter : champ de code facultatif, vérification explicite, confirmation du montant réellement crédité, encart dans le profil, illustration d’origine conservée, code copiable, partage WhatsApp et feuille native des applications, compteurs réels, historique paginé et anonymisé, actualisation et cache hors connexion signalé comme ancien.

Admin : rubrique Parrainage réservée aux administrateurs, compteurs, période, recherche par code/email/identifiant, relations, historique de commissions, journal des portefeuilles, évolution, signaux à examiner, suspension/reprise des paiements, versions des règles et CSV incluant relations/bonus/commissions. Les tableaux sont plafonnés à 500 relations et 1 000 commissions par affichage ; les statistiques et l’export sont calculés sur toutes les opérations correspondant aux filtres. Les dates filtrent les inscriptions pour les relations et les dates de crédit pour les opérations payées.

La surveillance des inscriptions sur une connexion partagée et des retraits inhabituels crée des signaux, sans blocage automatique fondé uniquement sur l’IP. Les administrateurs peuvent examiner et classer ces signaux. Une suspension globale d’un compte reste disponible dans la gestion des utilisateurs. Sans OTP, il ne faut pas présenter ce dispositif comme une preuve d’identité.

Le partage natif utilise [share_plus 11.1.0](https://pub.dev/packages/share_plus/versions/11.1.0), compatible avec les outils Android existants. Aucun message WhatsApp n’est envoyé automatiquement : l’utilisateur choisit le destinataire et confirme dans WhatsApp.

## Migration et déploiement

Migration additive **5**, appliquée transactionnellement au démarrage. Sauvegarder SQLite avec son WAL ou avec l’API de sauvegarde SQLite avant mise à jour. Ne jamais remplacer la base VM par une ancienne base locale lors d’une mise à jour du code. Conserver également `uploads` et `private-documents`.

Sur la VM, utiliser Node 22 :

```bash
cd ~/apps/toumabackend
. "$HOME/.nvm/nvm.sh"
nvm use 22
git pull --ff-only
npm ci
pm2 restart toumabackend --update-env
pm2 save
curl -fsS https://toumabackend.yingr-ai.com/health
```

La santé annonce `referral-v1`. Conserver `TOUMA_ORIGIN=https://comstratmedia.com,http://localhost:5173,http://127.0.0.1:5173`, le port 5011, le proxy loopback et HTTPS.

Pour cPanel, recompiler avec `npm --prefix frontend run build`, puis déposer le contenu de `dist` dans `public_html/toumaweb`, y compris `.htaccess`. L’API reste `https://toumabackend.yingr-ai.com/api`. Le BAT local force une base `/` et une API `/api` pour ses lancements locaux. Le build navigateur de test utilise `--mode test` et une base temporaire isolée.

Pour Flutter : `flutter build apk --release` depuis `touma_mobile`, avec l’API VM déjà définie par défaut. Mettre à jour l’APK installé ; aucun ancien compte ne reçoit de bonus rétroactif simplement en installant cette version.

## Vérifications

47 scénarios backend : 29 existants et 18 parrainage. Ils couvrent inscription avec/sans code, bonus immédiat, répétitions, code invalide, auto-parrainage, premier et prochains retraits, sources mixtes, commissions non récursives, confirmation/répétition, annulation, remboursement, concurrence, règles versionnées, confidentialité, rôles et examen humain.

10 tests Flutter : six existants et quatre nouveaux, dont inscriptions avec clé stable, retour backend du bonus, cache d’historique explicitement ancien, champ facultatif vérifié et écran de partage/historique vide. Analyse Flutter sans problème.

Parcours navigateur SaaS existant et nouveau parcours Parrainage : statistiques, suspension/reprise, confirmation d’un retrait de test, commission persistée, graphique, export CSV, configuration, journal, recherche et affichage à 390 px. Les paiements de test sont limités aux bases temporaires. Aucun faux retrait ni bonus de démonstration n’est créé sur la VM.

## Fichiers concernés

- Backend : `src/db/database.js`, `src/db/referralMigration.js`, `src/routes/auth.js`, `src/routes/api.js`, `src/routes/management.js`, `src/routes/referrals.js`, `src/services/walletService.js`, `src/services/referralService.js`, `src/server.js`, `tests/migrations.js`, `tests/referrals.js`, scripts npm.
- Flutter : `lib/services/live_api.dart`, `lib/screens/auth_screen.dart`, `profile_screen.dart`, `referral_screen.dart`, `main_navigation_screen.dart`, `pubspec.yaml`, `pubspec.lock`, `test/referral_test.dart` et fichiers générés d’enregistrement des plugins.
- Web : `src/apps/saas/Referrals.jsx`, `Finance.jsx`, `SaasApp.jsx`, `common.jsx`, `tests/referral-browser.mjs`, scripts npm ; `lancer-touma-web.bat` conserve la compatibilité du lancement local.
- Livraison : nouvel APK, ZIP cPanel et ce document. Le dépôt GitHub backend contient uniquement le backend, ses tests et cette documentation.
