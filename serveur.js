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
  // Migration vers le sac spatial : on redonne une empreinte et une position à chaque
  // objet ; s'il en déborde, on agrandit gratuitement, puis on vend le surplus.
  if (p.inventaire.some(o => !o.pos || !o.taille)) {
    const objets = p.inventaire.map(o => ({ ...o, taille: EQ.tailleObjet(o.emplacement, o.rarete) }));
    p.inventaire = [];
    p.extensionsSac = p.extensionsSac || 0;
    for (const o of objets) {
      delete o.pos;
      let pose = placerObjet(p, o);
      while (!pose && p.extensionsSac < K.equipement.sac.extensions_max) { p.extensionsSac++; pose = placerObjet(p, o); }
      if (!pose) p.or += EQ.prixRevente(o);
    }
  }
  for (const o of Object.values(p.equipement)) if (o && !o.taille) o.taille = EQ.tailleObjet(o.emplacement, o.rarete);
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
    sac: etatSac(p),
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
    bot.figure = c.adversaire.figure || null;
    const r = duel(combattantDuJoueur(p), bot);
    if ((r.vainqueur === p.nom) === reussite) return r.journal;
    journal = r.journal;
    mult *= reussite ? 0.88 : 1.15;
  }
  return journal;
}

// ---------- Sac spatial (façon Tetris) ----------
const SAC = K.equipement.sac;
// Ordre de déverrouillage des cases : par colonnes de deux lignes, bande par bande —
// une épée (1×2) tient debout dès les six premières cases.
const ORDRE_CELLULES = (() => {
  const ordre = [];
  for (let bande = 0; bande < SAC.lignes; bande += 2)
    for (let x = 0; x < SAC.colonnes; x++)
      for (let dy = 0; dy < 2 && bande + dy < SAC.lignes; dy++)
        ordre.push({ x, y: bande + dy });
  return ordre;
})();
const nbCases = p => Math.min(SAC.colonnes * SAC.lignes,
  SAC.cases_base + SAC.cases_par_niveau * (p.niveau - 1) + SAC.extension_cases * (p.extensionsSac || 0));
const prixExtension = p => Math.round(orMission(p.niveau) * SAC.extension_prix_mult * 2 ** (p.extensionsSac || 0));
const cellulesDebloquees = p => new Set(ORDRE_CELLULES.slice(0, nbCases(p)).map(c => c.x + ',' + c.y));
function grilleOccupation(p) {
  const occ = new Map();
  p.inventaire.forEach((o, i) => {
    for (let dx = 0; dx < o.taille.w; dx++) for (let dy = 0; dy < o.taille.h; dy++)
      occ.set((o.pos.x + dx) + ',' + (o.pos.y + dy), i);
  });
  return occ;
}
function peutPoser(p, taille, x, y, debloquees, occ, ignorer = -1) {
  for (let dx = 0; dx < taille.w; dx++) for (let dy = 0; dy < taille.h; dy++) {
    if (x + dx >= SAC.colonnes || y + dy >= SAC.lignes) return false;
    const cle = (x + dx) + ',' + (y + dy);
    if (!debloquees.has(cle)) return false;
    const qui = occ.get(cle);
    if (qui !== undefined && qui !== ignorer) return false;
  }
  return true;
}
// Pose l'objet au premier emplacement libre (balaie l'ordre de déverrouillage).
// Retourne l'objet posé, ou null si le sac ne peut pas l'accueillir.
function placerObjet(p, objet) {
  const deb = cellulesDebloquees(p), occ = grilleOccupation(p);
  for (const c of ORDRE_CELLULES)
    if (peutPoser(p, objet.taille, c.x, c.y, deb, occ)) {
      objet.pos = { x: c.x, y: c.y };
      p.inventaire.push(objet);
      return objet;
    }
  return null;
}
function etatSac(p) {
  return { colonnes: SAC.colonnes, lignes: SAC.lignes, cases: nbCases(p), casesMax: SAC.colonnes * SAC.lignes,
           extensions: p.extensionsSac || 0, extensionsMax: SAC.extensions_max, prixExtension: prixExtension(p),
           ordre: ORDRE_CELLULES.slice(0, nbCases(p)) };
}

// Butin de mission : tirage d'objet, posé dans le sac s'il y a la place.
function tirerButinMission(p, contrat) {
  const chance = contrat.type === 'butin' ? K.equipement.chance_butin_contrat_butin : K.equipement.chance_butin_mission;
  if (Math.random() > chance) return null;
  const objet = EQ.tirerButin(contrat.niveau);
  if (!placerObjet(p, objet)) return { plein: true };
  return objet;
}

// ---------- API ----------
// Constantes utiles au client (effets d'équipement, emplacements...) — une seule
// source de vérité : constantes.json. Le client ne duplique plus ces valeurs.
app.get('/api/constantes', (_req, res) => res.json({
  effets: K.equipement.effets,
  emplacements: K.equipement.emplacements,
  raretes: Object.keys(K.equipement.raretes),
  raretes_prix: Object.fromEntries(Object.entries(K.equipement.raretes).map(([r, i]) => [r, i.prix])),
  or_mission: { base: K.progression.or_mission_base, exposant: K.progression.or_mission_exposant },
  fusion_part_prix: K.equipement.fusion_part_prix,
  tailles: K.equipement.tailles,
  // De quoi écrire noir sur blanc ce que rapporte chaque attribut.
  combat: {
    atk_par_point: K.combat.atk_par_point,
    pv_par_endurance: K.combat.pv_par_endurance,
    def_par_endurance: K.combat.def_par_endurance,
    crit_par_chance: K.combat.crit_par_chance,
    precision_par_agi: K.combat.precision_par_agi
  }
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
    inventaire: [], extensionsSac: 0
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

  // --- Prime majeure : combat de boss avec les bonus de préparation de SA région ---
  if (c.type === 'boss') {
    const preps = CONTRATS.filter(x => x.region === c.region && x.prep);
    const accomplis = prep => preps.filter(x => x.prep === prep).reduce((s, x) => s + (p.contratsAccomplis[x.id] || 0), 0);
    const prepPv = Math.min(4, accomplis('pv_boss'));
    const initiative = accomplis('initiative') > 0;
    const modifsBoss = { pv_mult: 1.5 * (1 - 0.05 * prepPv), atk_mult: accomplis('atk_boss') > 0 ? 0.9 : 1 };
    const boss = creerBot(c.boss.nom, c.boss.classe, c.niveau, EQ.panoplieBot(c.niveau, 'Commun'), modifsBoss);
    boss.figure = c.boss.figure;
    const joueur = combattantDuJoueur(p);
    const r = duel(joueur, boss, { initiative_a: initiative });
    const victoire = r.vainqueur === p.nom;
    let recompenses = null;
    if (victoire) {
      recompenses = { or: orMission(c.niveau) * 5, xp: xpMission(c.niveau) * 5, titre: c.boss.titre };
      p.or += recompenses.or;
      p.contratsAccomplis[c.id] = (p.contratsAccomplis[c.id] || 0) + 1;
      p.titre = recompenses.titre;
      // Butin garanti, comme promis par l'avis de prime (Légendaire pour les régions 2+).
      const butinBoss = EQ.tirerButin(c.niveau, c.boss.butin);
      if (placerObjet(p, butinBoss)) recompenses.objet = butinBoss;
      recompenses.niveauxGagnes = appliquerXp(p, recompenses.xp);
    } else if (Math.random() < K.missions.echec_chance_blessure) { p.blesse = true; p.blessureNiveau = c.niveau; }
    sauver(p);
    return res.json({ boss: true, victoire, journal: r.journal, recompenses,
      preparation: { pvReduits: prepPv * 5, atkReduite: modifsBoss.atk_mult < 1, initiative },
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
    for (const [rar, infos] of Object.entries(K.equipement.raretes)) {
      if (!infos.prix) continue; // le Légendaire ne se forge pas : butin de primes majeures
      catalogue.push({ emplacement: emp, rarete: rar, niveau: p.niveau,
                       stat: EQ.statObjet(p.niveau, rar), prix: EQ.prixObjet(p.niveau, rar),
                       effets: K.equipement.effets[emp] });
    }
  res.json({ catalogue, revente: K.equipement.prix_revente });
});

app.post('/api/forge/acheter', (req, res) => {
  const p = charger(req.body.nom);
  const { emplacement, rarete } = req.body;
  if (!p || !K.equipement.emplacements.includes(emplacement) || !K.equipement.raretes[rarete])
    return res.status(400).json({ erreur: 'Commande invalide.' });
  const prix = EQ.prixObjet(p.niveau, rarete);
  if (p.or < prix) return res.status(400).json({ erreur: `Il faut ${prix} or. La forge ne fait pas crédit non plus.` });
  const objet = EQ.genererObjet(emplacement, p.niveau, rarete);
  if (!placerObjet(p, objet)) return res.status(400).json({ erreur: 'Pas la place dans le sac : vendez, équipez, ou agrandissez-le.' });
  p.or -= prix;
  sauver(p);
  res.json({ objet, prix, personnage: etatPublic(p) });
});

app.post('/api/equiper', (req, res) => {
  const p = charger(req.body.nom);
  const i = req.body.index;
  if (!p || p.inventaire[i] === undefined) return res.status(400).json({ erreur: 'Objet introuvable.' });
  const objet = p.inventaire.splice(i, 1)[0];
  const posOrigine = objet.pos;
  const ancien = p.equipement[objet.emplacement];
  p.equipement[objet.emplacement] = objet;
  delete objet.pos;
  if (ancien && !placerObjet(p, ancien)) {
    // pas la place de ranger l'ancien : on annule l'échange
    p.equipement[objet.emplacement] = ancien;
    objet.pos = posOrigine;
    p.inventaire.splice(i, 0, objet);
    return res.status(400).json({ erreur: `Pas la place de ranger ${ancien.nom} : faites de la place d'abord.` });
  }
  sauver(p);
  res.json({ objet, ancien, personnage: etatPublic(p) });
});

app.post('/api/desequiper', (req, res) => {
  const p = charger(req.body.nom);
  const emp = req.body.emplacement;
  if (!p || !K.equipement.emplacements.includes(emp)) return res.status(400).json({ erreur: 'Emplacement inconnu.' });
  const objet = p.equipement[emp];
  if (!objet) return res.status(400).json({ erreur: 'Emplacement déjà vide.' });
  if (!placerObjet(p, objet)) return res.status(400).json({ erreur: 'Pas la place dans le sac pour cette pièce.' });
  p.equipement[emp] = null;
  sauver(p);
  res.json({ objet, personnage: etatPublic(p) });
});

// Fusion d'Orin : deux pièces identiques (même emplacement, même rareté) forgent
// une pièce de la rareté supérieure au niveau de la meilleure des deux. Évier d'or
// et évier d'objets — le Légendaire reste réservé aux primes majeures.
const ORDRE_RARETES = Object.keys(K.equipement.raretes);
app.post('/api/fusionner', (req, res) => {
  const p = charger(req.body.nom);
  const { indexA, indexB } = req.body;
  const a = p && p.inventaire[indexA], b = p && p.inventaire[indexB];
  if (!p || !a || !b || indexA === indexB) return res.status(400).json({ erreur: 'Il faut deux pièces du sac.' });
  if (a.emplacement !== b.emplacement || a.rarete !== b.rarete)
    return res.status(400).json({ erreur: 'Orin exige deux pièces de même type et de même rareté.' });
  const rangSuivant = ORDRE_RARETES.indexOf(a.rarete) + 1;
  const rareteSup = ORDRE_RARETES[rangSuivant];
  if (!rareteSup || !K.equipement.raretes[rareteSup].prix)
    return res.status(400).json({ erreur: 'Seules les primes majeures produisent du Légendaire — Orin refuse poliment.' });
  const niveau = Math.max(a.niveau, b.niveau);
  const cout = Math.round(EQ.prixObjet(niveau, rareteSup) * K.equipement.fusion_part_prix);
  if (p.or < cout) return res.status(400).json({ erreur: `La fusion coûte ${cout} or de charbon et de sueur.` });
  p.or -= cout;
  // Retirer les deux pièces (indices décroissants pour ne pas se décaler)
  const retires = [indexA, indexB].sort((x, y) => y - x).map(i => p.inventaire.splice(i, 1)[0]);
  const objet = EQ.genererObjet(a.emplacement, niveau, rareteSup);
  if (!placerObjet(p, objet)) {
    for (const o of retires.reverse()) p.inventaire.push(o); // positions conservées : les cases viennent d'être libérées
    p.or += cout;
    return res.status(400).json({ erreur: 'La pièce fondue est plus grande : faites de la place dans le sac.' });
  }
  sauver(p);
  res.json({ objet, cout, personnage: etatPublic(p) });
});

// Déplacer une pièce du sac vers une case précise (réagencement façon Tetris).
app.post('/api/deplacer', (req, res) => {
  const p = charger(req.body.nom);
  const { index, x, y } = req.body;
  const o = p && p.inventaire[index];
  if (!o || !Number.isInteger(x) || !Number.isInteger(y)) return res.status(400).json({ erreur: 'Déplacement invalide.' });
  if (!peutPoser(p, o.taille, x, y, cellulesDebloquees(p), grilleOccupation(p), index))
    return res.status(400).json({ erreur: 'Cette pièce ne tient pas là.' });
  o.pos = { x, y };
  sauver(p);
  res.json({ objet: o, personnage: etatPublic(p) });
});

// Agrandir le sac : +4 cases contre de l'or, prix doublant à chaque extension.
app.post('/api/sac/extension', (req, res) => {
  const p = charger(req.body.nom);
  if (!p) return res.status(404).json({ erreur: 'Inconnu au registre.' });
  if ((p.extensionsSac || 0) >= SAC.extensions_max) return res.status(400).json({ erreur: 'Le sellier ne fait pas plus grand.' });
  const prix = prixExtension(p);
  if (p.or < prix) return res.status(400).json({ erreur: `L'extension coûte ${prix} or.` });
  p.or -= prix;
  p.extensionsSac = (p.extensionsSac || 0) + 1;
  sauver(p);
  res.json({ prix, personnage: etatPublic(p) });
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
