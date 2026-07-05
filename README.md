# Chroniques d'Aldenfer — Prototype de boucle cœur (client + serveur Node.js)

## Lancer le jeu
```bash
npm install
node serveur.js
```
Puis ouvrir http://localhost:3000 dans un navigateur.

## Nouveautés v2 (animations + équipement)
- **Système d'équipement complet** : 6 emplacements, 4 raretés achetables à la forge d'Orin, butin de missions (8 %, 45 % sur les contrats de type butin), butin épique garanti sur Brenn, revente à 30 %. Les bots de l'arène et Brenn sont équipés eux aussi (panoplie Commune, modèle de puissance réaliste).
- **Scène de combat animée** : figurines, barres de PV, dégâts flottants, critiques qui secouent l'écran, esquives, surcharges — pilotée par les événements structurés du serveur (moteur/combat.js v2). Bouton « Passer l'animation », et respect de prefers-reduced-motion.
- **Animation de résolution de quête** : parchemin, progression, sceau de cire ACCOMPLI/ÉCHEC, butin affiché.
- **Vérificateur d'équilibre intégré** : `node scripts/verifier_equilibre.js 4000 Rare` — utilise le vrai moteur du jeu (remplace le simulateur Python comme référence). Quatre classes entre 48,2 % et 53,8 % de victoires moyennes.

## Ce que contient le prototype
- **Serveur autoritatif** (`serveur.js`) : toute la logique (énergie, missions, or, XP, attributs, combats) est calculée côté serveur. Le client n'est qu'un affichage — c'est le principe n°1 d'un jeu en ligne.
- **Moteur de combat** (`moteur/combat.js`) : port du simulateur Python validé (mêmes formules, mêmes signatures de classes).
- **Constantes d'équilibrage** (`moteur/constantes.json`) : synchronisées avec le classeur Excel. Modifiez-les ici, redémarrez, testez.
- **Les 25 contrats de la région 1** (`data/contrats.json`) : issus de la bible d'univers, avec le système de préparation du boss (contrats 19, 21, 22 affaiblissent Brenn).
- **Client** (`public/index.html`) : tableau des primes en parchemins épinglés, fiche d'attributs, arène de duels avec rapport de combat façon registre de guilde.
- **Sauvegardes** : fichiers JSON dans `sauvegardes/` (un par personnage). En production : PostgreSQL.

## Boucle cœur jouable
Créer un personnage (4 classes) → accepter des contrats (énergie, jets de réussite sur les attributs) → gagner or et XP → acheter des attributs (rabais de classe 20 %) → duels d'arène contre des adversaires générés → monter au niveau 10 → préparer puis donner l'assaut contre Brenn le Décrocheur (6/10 de victoires avec préparation complète, mesuré).

## Outils de test
- `test_v2.sh` : teste toute l'API (forge, équipement, événements de combat) puis fait grinder un bot réaliste jusqu'au boss (résultat attendu : ~5/10 contre Brenn avec préparation complète).
- Bouton « Remplir l'énergie » dans le client (à retirer en production).

## Limitations connues (documentées dans le classeur)
- Équilibre bas niveau (< 25) : avantage structurel aux tanks. Mitigations prévues : arène classée au niveau 15+, boss de bas niveau de classe Ombre.
- Pas d'authentification (le nom fait office d'identifiant) — prototype uniquement.
- Le Légendaire n'est pas encore lootable (réservé aux futures primes majeures des régions 2+).
