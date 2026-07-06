# Chroniques d'Aldenfer — Prototype de boucle cœur (client + serveur Node.js)

## Lancer le jeu
```bash
npm install
node serveur.js
```
Puis ouvrir http://localhost:3000 dans un navigateur.

## Nouveautés v4 (région 2, fusion, stats en clair)
- **Région 2 : Les Hautes Terrasses** (`data/contrats.json`, contrats 26-50, niveaux 10-20). La trame continue : pourquoi Brenn a déserté, les fouilles de la Régence, le Cercle, et l'Éveilleur des Terrasses (boss Mage, préparations 46/47/48, **butin Légendaire garanti**). Vaincre Brenn déverrouille la région (chaîne id−1 naturelle). Carte propre (terrasses, aqueduc, gouffre, nécropole, garnison) avec onglets de région. Boss généralisés côté serveur (`c.boss` + préparations par région). Parcours validé : niveau 20 en ~400 missions, Éveilleur 8/10 avec préparation complète (`test_region2.sh`).
- **Fusion d'Orin** (`/api/fusionner`) : deux pièces jumelles (même type, même rareté) → une pièce de rareté supérieure au niveau de la meilleure, contre 25 % du prix de forge de la pièce produite. Évier d'or et d'objets ; le Légendaire reste réservé aux primes majeures. UI : glisser une pièce sur sa jumelle, ou bouton « Fusionner » (coût affiché) dans le détail.
- **Les objets ne donnent QUE des attributs, écrits en toutes lettres** : plus de « +15 PV » — casque et armure donnent de l'**Endurance**, bottes de l'Agilité, amulette de la Chance, anneau de la Ruse, et l'arme nourrit les trois voies offensives (Force 0,40 / Agilité 0,30 / Intelligence 0,45 par point de stat — l'agilité est décotée car elle sert aussi précision/esquive, l'intelligence surcotée car le Mage n'en tire que l'attaque). L'endurance d'équipement compte dans PV et défense. Chaque attribut affiche ses effets chiffrés réels (« +20 points de vie · +0,8 défense »), tirés de `/api/constantes`.
- **Équipement porté en cases** façon Goodgame Gangster : bloc de 6 cases encadrées avec libellés (fini la silhouette), toujours en glisser-déposer.
- **Recalibrage complet** après le passage aux attributs purs : quatre classes entre **49,3 % et 50,5 %** (5 000 duels/matchup, panoplie Rare) — le plus serré à ce jour. **À reporter au classeur Excel** (effets d'équipement + rareté Légendaire ×2,0).

## Nouveautés v3.1 (tout-combat + designs de personnages)
- **Toute la progression passe par le combat** : les 25 contrats ont désormais un adversaire nommé (le renard botté, la Chiffonnière, le champion de Brenn...). Le jet de réussite sur les attributs reste le juge de l'issue — l'équilibrage ne bouge pas — mais chaque mission se joue en scène de combat animée. L'animation du parchemin reste en secours technique.
- **Galerie de personnages SVG** (`FIGURES` dans le client) : les 4 classes + un bestiaire de 8 adversaires (brigand, garde de Brenn, loup, sanglier, chien, renard, créature, Brenn) dessinés dans la palette de la DA. Utilisés dans la scène de combat (l'adversaire de droite est en miroir), l'écran de création de personnage et la vignette du popup de contrat. La figure voyage dans l'événement `init` du journal de combat (`figure` sur l'adversaire, classe du joueur sinon).

## Nouveautés v3 (carte, combats de mission, inventaire Gangster)
- **Carte des Faubourgs du Gué** : les 25 contrats sont des lieux sur une carte SVG (rivière du Bief, Noirlac, bois, cité d'Aldenfer), reliés par la route de la trame. **La trame se suit dans l'ordre** : un contrat s'ouvre quand le précédent a été accompli une fois (en plus de la borne de niveau) ; les terres au-delà restent « inconnues » (?). Les contrats accomplis restent rejouables pour le grind.
- **Les contrats se règlent en combat animé** : 11 des 25 contrats ont un adversaire nommé (le sanglier du banquet, la chose du puits, les hommes de Brenn...). Le serveur tire la réussite sur les attributs comme avant (l'équilibrage ne change pas), puis génère un vrai journal de combat cohérent avec l'issue — le client le joue en plein écran. Les contrats « pacifiques » gardent l'animation du parchemin.
- **Inventaire façon Goodgame Gangster** : silhouette de personnage avec les 6 emplacements disposés autour (paper doll), sac en grille de cases où chaque pièce occupe une case (icône + liseré de rareté). Glisser-déposer pour équiper, ranger, ou vendre sur l'étal d'Orin ; double-clic pour équiper ; infobulles de stats. Nouveaux endpoints `/api/desequiper` et `/api/constantes` (une seule source de vérité pour les effets d'équipement).
- **L'Intelligence (et la Force) existent enfin en objet** : amulette → Intelligence + Chance, anneau → Force + Ruse. Les bonus d'attributs de l'équipement comptent désormais dans l'ATK du combat (anneau→Guerrier, bottes→Rôdeur/Ombre, amulette→Mage : chaque classe a son emplacement offensif) **et** dans les jets de réussite des missions.
- **Recalibrage du monde équipé (leçon d'intégration n°3, 06/07)** : nourrir l'attaque avec les attributs d'équipement a surtout profité à l'Ombre (60 % de victoires) et affaibli le Mage (45 %). Recalé : rage du Guerrier 6 %/coup, précision du Mage 89, crit de l'Ombre ×1,55, esquive passive 8 %. Vérifié : les quatre classes entre 48,4 % et 51,9 % (panoplie Rare, 5 000 duels/matchup). **À reporter au classeur Excel.**
- **Soins au prix de la blessure** : le soin coûte selon le niveau du contrat qui vous a blessé, plus selon votre niveau. Sans cela, regrinder des contrats sous son niveau (la norme avec la trame en chaîne) détruisait l'économie — les soins absorbaient ~90 % des revenus, mesuré.

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
Créer un personnage (4 classes) → suivre la trame sur la carte (énergie, jets de réussite sur les attributs, combats animés) → gagner or et XP → acheter attributs (rabais de classe 20 %) et équipement → duels d'arène contre des adversaires générés → monter au niveau 10 en menant la trame jusqu'au moulin → donner l'assaut contre Brenn le Décrocheur (6/10 de victoires avec préparation complète, re-mesuré en v3).

## Outils de test
- `test_v2.sh` : teste toute l'API (forge, équipement, événements de combat) puis fait grinder un bot réaliste jusqu'au boss (résultat attendu : ~5/10 contre Brenn avec préparation complète).
- Bouton « Remplir l'énergie » dans le client (à retirer en production).

## Limitations connues (documentées dans le classeur)
- Équilibre bas niveau (< 25) : avantage structurel aux tanks. Mitigations prévues : arène classée au niveau 15+, boss de bas niveau de classe Ombre.
- Pas d'authentification (le nom fait office d'identifiant) — prototype uniquement.
- Le Légendaire n'est pas encore lootable (réservé aux futures primes majeures des régions 2+).
