# toumabackend

API TOUMA : authentification, organisations, études, campagnes, collecte de preuves, validation, portefeuilles et rapports.

Ce dépôt contient uniquement le backend Node/Express/SQLite. Admin/Entreprise et Flutter sont des clients séparés. Les bases, mots de passe, photos et documents de production sont exclus de Git.

## Lancement

```sh
npm ci
npm start
```

API : http://localhost:5000/api ; santé : http://localhost:5000/health. Le chemin `/` ne sert pas de frontend.

Configurer les variables dans le shell ou chez l’hébergeur. `.env.example` est un exemple ; le serveur ne charge pas automatiquement un fichier `.env`.

- `PORT` : 5000 par défaut.
- `HOST` : 0.0.0.0 par défaut.
- `TOUMA_DB_PATH` : base SQLite persistante ; défaut `data/touma-live.db`.
- `TOUMA_ORIGIN` : origines CORS autorisées, séparées par des virgules.
- `TOUMA_TRUST_LOCAL_PROXY=1` : proxy loopback, si nécessaire.

Les migrations sont additives et la base démarre vide. Les répertoires `data`, `uploads` et `private-documents` nécessitent un stockage persistant et des sauvegardes.

## Premier administrateur

Définir `TOUMA_ADMIN_EMAIL` et `TOUMA_ADMIN_PASSWORD` (12 caractères minimum), puis `npm run create-admin`. Le script refuse de dupliquer un administrateur existant et ne crée aucun solde.

## Tests

`npm test` utilise des bases temporaires : sessions, rôles, isolation des entreprises, formulaires/preuves, corrections, crédits uniques, retraits/réserves, études, exports et migrations. Le scénario YAAR+ est également isolé.

Le script `scripts/configurer-yaar.js` configure uniquement l’installation YAAR+ autorisée. Ses mots de passe générés restent dans `.touma-runtime`, exclu de Git. Le seed est réservé à une base demo explicitement activée.

## Limites

Mobile Money et encaissements clients restent à intégrer. Le budget déclaré n’est pas un paiement confirmé ; aucun transfert réussi n’est simulé.

Une publication GitHub ne déploie pas le serveur. L’hébergement public exige HTTPS, stockage persistant, origines CORS et sauvegardes.
