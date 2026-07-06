// Serveur autoritatif — Chroniques d'Aldenfer (prototype v2 : équipement + événements de combat).
// Principe clé : TOUTE la logique de jeu vit ici. Le client n'est qu'un affichage.
const express = require('express');
const fs = require('fs');
const path = require('path');
const K = require('./moteur/constantes.json');
const { Combattant, duel, creerBot } = require('./moteur/combat.js');
const EQ = require('./moteur/equipement.js');
const CONTRATS = require('./data/contrats.json');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DOSSIER_SAUVEGARDES = path.join(__dirname, 'sauvegardes');
fs.mkdirSync(DOSSIER_SAUVEGARDES, { recursive: true });

// ---------- Persistance (JSON par personnage ; en production : PostgreSQL) ----------
const cheminSauvegarde = nom => path.join(DOSSIER_SAUVEGARDES, nom.toLowerCase().replace(/[^a-z0-9à-ÿ_-]/gi, '') + '.json');
function charger(nom) {
  if (!fs.existsSync(cheminSauvegarde(nom))) return null;
  const p = JSON.parse(fs.readFileSync(cheminSauvegarde(nom)));
  // Migration des sauvegardes d'avant l'équipement
  if (!p.equipement) p.equipement = Object.fromEntries(K.equipement.emplacements.map(e => [e, null]));
  if (!p.inventaire) p.inventaire = [];
  return p;
}
const sauver = p => fs.writeFileSync(cheminSauvegarde(p.nom), JSON.stringify(p, null, 1));

// ---------- Formules de progression (mêmes que le tableur) ----------
const P = K.progression;
const xpPourNiveau = n => Math.round(P.xp_base * n ** P.xp_exposant);
const xpMission = n => Math.round(P.xp_mission_base * n ** P.xp_mission_exposant);
const orMission = n => Math.round(P.or_mission_base * n ** P.or_mission_exposant);
const coutAttribut = v => Math.round(K.attributs.cout_coeff_poly * v ** K.attributs.cout_exp_poly
                                   + K.attributs.cout_coeff_expo * K.attributs.cout_base_expo ** v);
const energieMax = p => K.energie.max_base + K.energie.max_par_niveau * (p.niveau - 1);

// Régénération paresseuse : on recalcule l'énergie à chaque lecture à partir du timestamp.
function actualiserEnergie(p) {
  const msParPoint = K.energie.minutes_par_point * 60 * 1000;
  const ecoule = Date.now() - p.energieMajA;
  const regen = Math.floor(ecoule / msParPoint);
  if (regen > 0) {
    p.energie = Math.min(energieMax(p), p.energie + regen);
    p.energieMajA += regen * msParPoint;
  }
  if (p.energie >= energieMax(p)) p.energieMajA = Date.now();
}

function appliquerXp(p, xp) {
  p.xp += xp;
  const niveaux = [];
  while (p.niveau < P.niveau_max && p.xp >= xpPourNiveau(p.niveau)) {
    p.xp -= xpPourNiveau(p.niveau);
    p.niveau++;
    p.energie = energieMax(p); // niveau gagné = plein d'énergie (petit plaisir standard du genre)
    niveaux.push(p.niveau);
  }
  return niveaux;
}

function combattantDuJoueur(p, modifs = {}) {
  const attrs = { ...p.attributs };
  if (p.blesse) for (const a of Object.keys(attrs)) attrs[a] *= 1 - K.missions.blessure_malus;
  return new Combattant(p.nom, p.classe, attrs, p.equipement, modifs);
}

function etatPublic(p) {
  const combattant = combattantDuJoueur(p);
  return {
    ...p, energieMax: energieMax(p), xpProchainNiveau: xpPourNiveau(p.niveau),
    bonusEquipement: EQ.bonusEquipement(p.equipement),
    puissance: { atk: Math.round(combattant.atk), def: Math.round(combattant.def), pv: combattant.pvMax },
    couts: Object.fromEntries(K.attributs.liste.map(a => {
      const brut = coutAttribut(p.attributs[a] + 1);
      const rabais = K.classes[p.classe].attributs_classe.includes(a);
      return [a, Math.round(brut * (rabais ? 1 - K.attributs.rabais_classe : 1))];
    }))
  };
}

// La trame de la région se suit dans l'ordre : un contrat s'ouvre quand le précédent
// a été accompli au moins une fois (en plus de la borne de niveau).
const verrouHistoire = (p, c) => c.id > 1 && !(p.contratsAccomplis[c.id - 1] > 0);

// Combat de mission : rejoue le duel jusqu'à ce que l'issue corresponde au jet de
// réussite déjà tiré (l'équilibrage reste piloté par les attributs, le combat est
// la mise en scène). Si le sort s'obstine, on ajuste la force de l'adversaire.
function journalCombatMission(p, c, reussite) {
  let mult = 1, journal = null;
  for (let essai = 0; essai < 24; essai++) {
    const bot = creerBot(c.adversaire.nom, c.adversaire.classe, c.niveau,
                         EQ.panoplieBot(c.niveau, 'Commun'), { pv_mult: mult, atk_mult: mult });
    const r = duel(combattantDuJoueur(p), bot);
    if ((r.vainqueur === p.nom) === reussite) return r.journal;
    journal = r.journal;
    mult *= reussite ? 0.88 : 1.15;
  }
  return journal;
}

// Butin de mission : tirage d'objet, ajouté à l'inventaire si de la place.
function tirerButinMission(p, contrat) {
  const chance = contrat.type === 'butin' ? K.equipement.chance_butin_contrat_butin : K.equipement.chance_butin_mission;
  if (Math.random() > chance) return null;
  if (p.inventaire.length >= K.equipement.taille_inventaire) return { plein: true };
  const objet = EQ.tirerButin(contrat.niveau);
  p.inventaire.push(objet);
  return objet;
}

// ---------- API ----------
// Constantes utiles au client (effets d'équipement, emplacements...) — une seule
// source de vérité : constantes.json. Le client ne duplique plus ces valeurs.
app.get('/api/constantes', (_req, res) => res.json({
  effets: K.equipement.effets,
  emplacements: K.equipement.emplacements,
  taille_inventaire: K.equipement.taille_inventaire,
  raretes: Object.keys(K.equipement.raretes)
}));

app.post('/api/personnage', (req, res) => {
  const { nom, classe } = req.body;
  if (!nom || !K.classes[classe]) return res.status(400).json({ erreur: 'Nom ou classe invalide.' });
  if (charger(nom)) return res.status(409).json({ erreur: 'Ce nom figure déjà au registre de la Guilde.' });
  const p = {
    nom, classe, niveau: 1, xp: 0, or: 50,
    attributs: { force: 5, agilite: 5, intelligence: 5, endurance: 5, chance: 5, ruse: 5 },
    energie: K.energie.max_base, energieMajA: Date.now(),
    blesse: false, contratsAccomplis: {}, victoires: 0, defaites: 0,
    equipement: Object.fromEntries(K.equipement.emplacements.map(e => [e, null])),
    inventaire: []
  };
  for (const a of K.classes[classe].attributs_classe) p.attributs[a] += 3;
  // Arme de départ : héritée, comme le veut le pitch.
  p.equipement.arme = { ...EQ.genererObjet('arme', 1, 'Commun'), nom: 'Lame héritée' };
  sauver(p);
  res.json(etatPublic(p));
});

app.get('/api/personnage/:nom', (req, res) => {
  const p = charger(req.params.nom);
  if (!p) return res.status(404).json({ erreur: 'Inconnu au registre.' });
  actualiserEnergie(p); sauver(p);
  res.json(etatPublic(p));
});

app.get('/api/contrats/:nom', (req, res) => {
  const p = charger(req.params.nom);
  if (!p) return res.status(404).json({ erreur: 'Inconnu au registre.' });
  res.json(CONTRATS.map(c => ({
    ...c,
    accompli: p.contratsAccomplis[c.id] || 0,
    verrouilleNiveau: c.niveau > p.niveau + 1,
    verrouilleHistoire: verrouHistoire(p, c),
    verrouille: c.niveau > p.niveau + 1 || verrouHistoire(p, c),
    recompenses: { or: c.type === 'or' ? Math.round(orMission(c.niveau) * 1.3) : orMission(c.niveau),
                   xp: c.type === 'xp' ? Math.round(xpMission(c.niveau) * 1.3) : xpMission(c.niveau) }
  })));
});

app.post('/api/mission', (req, res) => {
  const p = charger(req.body.nom);
  const c = CONTRATS.find(x => x.id === req.body.contratId);
  if (!p || !c) return res.status(404).json({ erreur: 'Contrat ou personnage introuvable.' });
  actualiserEnergie(p);
  if (c.niveau > p.niveau + 1) return res.status(400).json({ erreur: 'Contrat trop dangereux pour votre réputation actuelle.' });
  if (verrouHistoire(p, c)) return res.status(400).json({ erreur: 'La trame ne vous a pas encore menée là : accomplissez le contrat précédent.' });
  if (p.energie < c.energie) return res.status(400).json({ erreur: "Pas assez d'énergie. Passez à la taverne." });
  p.energie -= c.energie;

  // --- Prime majeure : combat de boss avec les bonus de préparation ---
  if (c.type === 'boss') {
    const prepPv = Math.min(4, p.contratsAccomplis[19] || 0);
    const modifsBoss = { pv_mult: 1.5 * (1 - 0.05 * prepPv), atk_mult: (p.contratsAccomplis[22] || 0) > 0 ? 0.9 : 1 };
    const boss = creerBot('Brenn le Décrocheur', 'Ombre', c.niveau, EQ.panoplieBot(c.niveau, 'Commun'), modifsBoss);
    const joueur = combattantDuJoueur(p);
    const r = duel(joueur, boss, { initiative_a: (p.contratsAccomplis[21] || 0) > 0 });
    const victoire = r.vainqueur === p.nom;
    let recompenses = null;
    if (victoire) {
      recompenses = { or: orMission(c.niveau) * 5, xp: xpMission(c.niveau) * 5, titre: 'Décrocheur de Décrocheur' };
      p.or += recompenses.or;
      p.contratsAccomplis[c.id] = (p.contratsAccomplis[c.id] || 0) + 1;
      p.titre = recompenses.titre;
      // Butin épique garanti, comme promis par l'avis de prime.
      if (p.inventaire.length < K.equipement.taille_inventaire) {
        recompenses.objet = EQ.tirerButin(c.niveau, 'Épique');
        p.inventaire.push(recompenses.objet);
      }
      recompenses.niveauxGagnes = appliquerXp(p, recompenses.xp);
    } else if (Math.random() < K.missions.echec_chance_blessure) { p.blesse = true; p.blessureNiveau = c.niveau; }
    sauver(p);
    return res.json({ boss: true, victoire, journal: r.journal, recompenses,
      preparation: { pvReduits: prepPv * 5, atkReduite: modifsBoss.atk_mult < 1, initiative: (p.contratsAccomplis[21] || 0) > 0 },
      personnage: etatPublic(p) });
  }

  // --- Contrat normal : jet de réussite contre les attributs testés ---
  // Les bonus d'attributs de l'équipement comptent (une amulette d'intelligence
  // aide les missions de savoir, exactement comme en combat).
  let chance = K.missions.reussite_base;
  if (c.attributs.length) {
    const bonusEq = EQ.bonusEquipement(p.equipement);
    const attendu = (36 + 6.5 * c.niveau ** 1.25) * K.missions.part_budget_attendue;
    const possede = c.attributs.reduce((s, a) =>
      s + p.attributs[a] * (p.blesse ? 1 - K.missions.blessure_malus : 1) + (bonusEq[a] || 0), 0) / c.attributs.length;
    chance += (possede / attendu - 1) * 40;
  }
  chance = Math.max(K.missions.reussite_min, Math.min(K.missions.reussite_max, chance));
  const reussite = Math.random() * 100 < chance;
  // Les contrats à adversaire se règlent en combat animé (le journal est généré AVANT
  // d'appliquer les gains, pour que le joueur combatte avec ses stats du moment).
  const journal = c.adversaire ? journalCombatMission(p, c, reussite) : null;
  let resultat;
  if (reussite) {
    const mult = t => c.type === t ? 1.3 : 1;
    const gains = { or: Math.round(orMission(c.niveau) * mult('or')), xp: Math.round(xpMission(c.niveau) * mult('xp')) };
    p.or += gains.or;
    p.contratsAccomplis[c.id] = (p.contratsAccomplis[c.id] || 0) + 1;
    const objet = tirerButinMission(p, c);
    resultat = { reussite: true, chance: Math.round(chance), gains, objet, niveauxGagnes: appliquerXp(p, gains.xp) };
  } else {
    const xpConsolation = Math.round(xpMission(c.niveau) * K.missions.echec_part_xp);
    const blessure = Math.random() < K.missions.echec_chance_blessure;
    // Le soin coûtera selon la gravité de la blessure (le niveau du contrat), pas selon
    // votre niveau : une morsure de loup au Vieux-Bief ne vaut pas une plaie de guerre.
    if (blessure) { p.blesse = true; p.blessureNiveau = c.niveau; }
    resultat = { reussite: false, chance: Math.round(chance), gains: { or: 0, xp: xpConsolation }, blessure,
                 niveauxGagnes: appliquerXp(p, xpConsolation) };
  }
  sauver(p);
  res.json({ ...resultat, journal, adversaire: c.adversaire || null, personnage: etatPublic(p) });
});

app.post('/api/attribut', (req, res) => {
  const p = charger(req.body.nom);
  const a = req.body.attribut;
  if (!p || !K.attributs.liste.includes(a)) return res.status(400).json({ erreur: 'Attribut inconnu.' });
  const brut = coutAttribut(p.attributs[a] + 1);
  const cout = Math.round(brut * (K.classes[p.classe].attributs_classe.includes(a) ? 1 - K.attributs.rabais_classe : 1));
  if (p.or < cout) return res.status(400).json({ erreur: "Pas assez d'or." });
  p.or -= cout; p.attributs[a]++;
  sauver(p);
  res.json({ attribut: a, nouvelleValeur: p.attributs[a], cout, personnage: etatPublic(p) });
});

app.post('/api/soigner', (req, res) => {
  const p = charger(req.body.nom);
  if (!p) return res.status(404).json({ erreur: 'Inconnu au registre.' });
  if (!p.blesse) return res.status(400).json({ erreur: 'Frère-Portier Aldric vous examine : rien à recoudre.' });
  const cout = Math.round(orMission(Math.min(p.blessureNiveau || p.niveau, p.niveau)) * 0.8);
  if (p.or < cout) return res.status(400).json({ erreur: `Les soins coûtent ${cout} or. Le temple ne fait pas crédit.` });
  p.or -= cout; p.blesse = false;
  sauver(p);
  res.json({ cout, personnage: etatPublic(p) });
});

// ---------- Forge & équipement ----------
app.get('/api/forge/:nom', (req, res) => {
  const p = charger(req.params.nom);
  if (!p) return res.status(404).json({ erreur: 'Inconnu au registre.' });
  // Catalogue : pour chaque emplacement × rareté, la stat et le prix à VOTRE niveau.
  const catalogue = [];
  for (const emp of K.equipement.emplacements)
    for (const rar of Object.keys(K.equipement.raretes))
      catalogue.push({ emplacement: emp, rarete: rar, niveau: p.niveau,
                       stat: EQ.statObjet(p.niveau, rar), prix: EQ.prixObjet(p.niveau, rar),
                       effets: K.equipement.effets[emp] });
  res.json({ catalogue, revente: K.equipement.prix_revente });
});

app.post('/api/forge/acheter', (req, res) => {
  const p = charger(req.body.nom);
  const { emplacement, rarete } = req.body;
  if (!p || !K.equipement.emplacements.includes(emplacement) || !K.equipement.raretes[rarete])
    return res.status(400).json({ erreur: 'Commande invalide.' });
  const prix = EQ.prixObjet(p.niveau, rarete);
  if (p.or < prix) return res.status(400).json({ erreur: `Il faut ${prix} or. La forge ne fait pas crédit non plus.` });
  if (p.inventaire.length >= K.equipement.taille_inventaire) return res.status(400).json({ erreur: 'Inventaire plein. Vendez ou équipez.' });
  p.or -= prix;
  const objet = EQ.genererObjet(emplacement, p.niveau, rarete);
  p.inventaire.push(objet);
  sauver(p);
  res.json({ objet, prix, personnage: etatPublic(p) });
});

app.post('/api/equiper', (req, res) => {
  const p = charger(req.body.nom);
  const i = req.body.index;
  if (!p || p.inventaire[i] === undefined) return res.status(400).json({ erreur: 'Objet introuvable.' });
  const objet = p.inventaire.splice(i, 1)[0];
  const ancien = p.equipement[objet.emplacement];
  p.equipement[objet.emplacement] = objet;
  if (ancien) p.inventaire.push(ancien); // l'ancien objet retourne dans le sac
  sauver(p);
  res.json({ objet, ancien, personnage: etatPublic(p) });
});

app.post('/api/desequiper', (req, res) => {
  const p = charger(req.body.nom);
  const emp = req.body.emplacement;
  if (!p || !K.equipement.emplacements.includes(emp)) return res.status(400).json({ erreur: 'Emplacement inconnu.' });
  const objet = p.equipement[emp];
  if (!objet) return res.status(400).json({ erreur: 'Emplacement déjà vide.' });
  if (p.inventaire.length >= K.equipement.taille_inventaire) return res.status(400).json({ erreur: 'Sac plein : impossible d’y ranger la pièce.' });
  p.equipement[emp] = null;
  p.inventaire.push(objet);
  sauver(p);
  res.json({ objet, personnage: etatPublic(p) });
});

app.post('/api/vendre', (req, res) => {
  const p = charger(req.body.nom);
  const i = req.body.index;
  if (!p || p.inventaire[i] === undefined) return res.status(400).json({ erreur: 'Objet introuvable.' });
  const objet = p.inventaire.splice(i, 1)[0];
  const prix = EQ.prixRevente(objet);
  p.or += prix;
  sauver(p);
  res.json({ objet, prix, personnage: etatPublic(p) });
});

app.post('/api/duel', (req, res) => {
  const p = charger(req.body.nom);
  if (!p) return res.status(404).json({ erreur: 'Inconnu au registre.' });
  actualiserEnergie(p);
  const COUT_DUEL = 10;
  if (p.energie < COUT_DUEL) return res.status(400).json({ erreur: "Pas assez d'énergie pour un duel (10)." });
  p.energie -= COUT_DUEL;
  // Adversaire : bot de niveau proche, classe aléatoire, panoplie Inhabituelle (validé par verifier_equilibre.js)
  const classes = Object.keys(K.classes);
  const classeBot = classes[Math.floor(Math.random() * classes.length)];
  const niveauBot = Math.max(1, p.niveau + Math.floor(Math.random() * 3) - 1);
  const noms = ['Vesna la Balafrée', 'Karsten Deux-Doigts', 'Ilda du Rempart', 'Maro le Silencieux', 'Petra Cognefer', 'Josselin le Prompt'];
  const bot = creerBot(`${noms[Math.floor(Math.random() * noms.length)]} (${classeBot}, niv. ${niveauBot})`,
                       classeBot, niveauBot, EQ.panoplieBot(niveauBot, 'Commun'));
  const r = duel(combattantDuJoueur(p), bot);
  const victoire = r.vainqueur === p.nom;
  let gains = null;
  if (victoire) {
    p.victoires++;
    gains = { or: Math.round(orMission(p.niveau) * 0.6), xp: Math.round(xpMission(p.niveau) * 0.6) };
    p.or += gains.or;
    gains.niveauxGagnes = appliquerXp(p, gains.xp);
  } else p.defaites++;
  sauver(p);
  res.json({ victoire, adversaire: bot.nom, journal: r.journal, gains, personnage: etatPublic(p) });
});

// Outil de développement : recharge d'énergie (à retirer en production, évidemment)
app.post('/api/dev/energie', (req, res) => {
  const p = charger(req.body.nom);
  if (!p) return res.status(404).json({ erreur: 'Inconnu au registre.' });
  p.energie = energieMax(p); p.energieMajA = Date.now();
  sauver(p);
  res.json({ personnage: etatPublic(p) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Aldenfer écoute sur http://localhost:${PORT} — la Guilde des Lames ouvre son registre.`));
