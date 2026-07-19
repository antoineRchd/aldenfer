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
  // Migration v5.1 : le spatial passe du sac au harnois. Le sac redevient simple,
  // les pièces portées reçoivent une position sur le harnois (extensions offertes si besoin).
  for (const o of p.inventaire) { delete o.pos; if (!o.taille) o.taille = EQ.tailleObjet(o.emplacement, o.rarete); }
  p.extensionsHarnois = p.extensionsHarnois ?? p.extensionsSac ?? 0;
  delete p.extensionsSac;
  const portees = Object.values(p.equipement).filter(Boolean);
  if (portees.some(o => !o.pos || !o.taille)) {
    for (const o of portees) { if (!o.taille) o.taille = EQ.tailleObjet(o.emplacement, o.rarete); delete o.pos; }
    // Les plus grosses d'abord, pour maximiser les chances de tout caser.
    for (const o of [...portees].sort((a, b) => b.taille.w * b.taille.h - a.taille.w * a.taille.h)) {
      let pos = placeSurHarnois(p, o);
      while (!pos && (p.extensionsHarnois || 0) < K.equipement.harnois.extensions_max) { p.extensionsHarnois = (p.extensionsHarnois || 0) + 1; pos = placeSurHarnois(p, o); }
      if (pos) o.pos = pos;
      else { // vraiment pas la place : la pièce retourne au sac (ou est vendue)
        const emp = Object.keys(p.equipement).find(e => p.equipement[e] === o);
        p.equipement[emp] = null;
        if (!placerObjet(p, o)) p.or += EQ.prixRevente(o);
      }
    }
  }
  // Migration arène : ELO de départ et attaques quotidiennes.
  if (p.elo === undefined) p.elo = K.arene.elo_depart;
  const jour = new Date().toISOString().slice(0, 10);
  if (!p.arene || p.arene.jour !== jour) p.arene = { jour, restantes: K.arene.attaques_par_jour };
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
    statsSpeciales: EQ.statsSpeciales(p.equipement),
    harnois: etatHarnois(p),
    sac: { cases: SAC_CASES },
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

// ---------- Harnois spatial (l'équipement porté occupe des cases, façon Tetris) ----------
const HARNOIS = K.equipement.harnois;
// Ordre de déverrouillage : par colonnes de deux lignes — une épée (1×2) tient
// debout dès les six premières cases.
const ORDRE_CELLULES = (() => {
  const ordre = [];
  for (let bande = 0; bande < HARNOIS.lignes; bande += 2)
    for (let x = 0; x < HARNOIS.colonnes; x++)
      for (let dy = 0; dy < 2 && bande + dy < HARNOIS.lignes; dy++)
        ordre.push({ x, y: bande + dy });
  return ordre;
})();
const nbCasesHarnois = p => Math.min(HARNOIS.colonnes * HARNOIS.lignes,
  HARNOIS.cases_base + Math.floor((p.niveau - 1) / HARNOIS.niveaux_par_case) + HARNOIS.extension_cases * (p.extensionsHarnois || 0));
const prixExtension = p => Math.round(orMission(p.niveau) * HARNOIS.extension_prix_mult * 2 ** (p.extensionsHarnois || 0));
const cellulesDebloquees = p => new Set(ORDRE_CELLULES.slice(0, nbCasesHarnois(p)).map(c => c.x + ',' + c.y));
// Occupation du harnois par les pièces PORTÉES (chacune connaît sa position).
function occupationHarnois(p, sansEmplacement = null) {
  const occ = new Set();
  for (const [emp, o] of Object.entries(p.equipement)) {
    if (!o || emp === sansEmplacement || !o.pos) continue;
    for (let dx = 0; dx < o.taille.w; dx++) for (let dy = 0; dy < o.taille.h; dy++)
      occ.add((o.pos.x + dx) + ',' + (o.pos.y + dy));
  }
  return occ;
}
function peutPoser(taille, x, y, debloquees, occ) {
  for (let dx = 0; dx < taille.w; dx++) for (let dy = 0; dy < taille.h; dy++) {
    if (x + dx >= HARNOIS.colonnes || y + dy >= HARNOIS.lignes) return false;
    const cle = (x + dx) + ',' + (y + dy);
    if (!debloquees.has(cle) || occ.has(cle)) return false;
  }
  return true;
}
// Cherche une place sur le harnois pour une pièce (hors celle qu'elle remplace).
function placeSurHarnois(p, objet, sansEmplacement = null) {
  const deb = cellulesDebloquees(p), occ = occupationHarnois(p, sansEmplacement);
  for (const c of ORDRE_CELLULES)
    if (peutPoser(objet.taille, c.x, c.y, deb, occ)) return { x: c.x, y: c.y };
  return null;
}
function etatHarnois(p) {
  return { colonnes: HARNOIS.colonnes, lignes: HARNOIS.lignes, cases: nbCasesHarnois(p),
           casesMax: HARNOIS.colonnes * HARNOIS.lignes, extensions: p.extensionsHarnois || 0,
           extensionsMax: HARNOIS.extensions_max, prixExtension: prixExtension(p),
           ordre: ORDRE_CELLULES.slice(0, nbCasesHarnois(p)) };
}
// Le sac, lui, est simple : une pièce, une case.
const SAC_CASES = K.equipement.sac.cases;
function placerObjet(p, objet) {
  if (p.inventaire.length >= SAC_CASES) return null;
  delete objet.pos;
  p.inventaire.push(objet);
  return objet;
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
  reforge_part_prix: K.equipement.reforge_part_prix,
  affixes: K.equipement.affixes,
  tailles: K.equipement.tailles,
  harnois: { colonnes: K.equipement.harnois.colonnes, lignes: K.equipement.harnois.lignes },
  sac_cases: K.equipement.sac.cases,
  stats_speciales: K.equipement.stats_speciales,
  series: K.equipement.series,
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
    inventaire: [], extensionsHarnois: 0
  };
  for (const a of K.classes[classe].attributs_classe) p.attributs[a] += 3;
  // Arme de départ : héritée, comme le veut le pitch.
  p.equipement.arme = { ...EQ.genererObjet('arme', 1, 'Commun'), nom: 'Lame héritée' };
  p.equipement.arme.pos = placeSurHarnois(p, p.equipement.arme);
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
      const sp = EQ.statsSpeciales(p.equipement);
      recompenses = { or: Math.round(orMission(c.niveau) * 5 * (1 + sp.aubaine / 100)),
                      xp: Math.round(xpMission(c.niveau) * 5 * (1 + sp.sagesse / 100)), titre: c.boss.titre };
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
    const sp = EQ.statsSpeciales(p.equipement);
    const gains = { or: Math.round(orMission(c.niveau) * mult('or') * (1 + sp.aubaine / 100)),
                    xp: Math.round(xpMission(c.niveau) * mult('xp') * (1 + sp.sagesse / 100)) };
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
  const objet = p.inventaire[i];
  const ancien = p.equipement[objet.emplacement];
  // La pièce doit tenir sur le harnois (l'ancienne du même emplacement libère ses cases).
  const pos = placeSurHarnois(p, objet, objet.emplacement);
  if (!pos) return res.status(400).json({ erreur: `Pas la place sur votre harnois pour ${objet.nom} (${objet.taille.w}×${objet.taille.h}) : déséquipez, ou passez chez le sellier.` });
  if (ancien && p.inventaire.length >= SAC_CASES)
    return res.status(400).json({ erreur: `Le sac est plein : impossible d'y ranger ${ancien.nom}.` });
  p.inventaire.splice(i, 1);
  objet.pos = pos;
  p.equipement[objet.emplacement] = objet;
  if (ancien) { delete ancien.pos; p.inventaire.push(ancien); }
  sauver(p);
  res.json({ objet, ancien, personnage: etatPublic(p) });
});

app.post('/api/desequiper', (req, res) => {
  const p = charger(req.body.nom);
  const emp = req.body.emplacement;
  if (!p || !K.equipement.emplacements.includes(emp)) return res.status(400).json({ erreur: 'Emplacement inconnu.' });
  const objet = p.equipement[emp];
  if (!objet) return res.status(400).json({ erreur: 'Emplacement déjà vide.' });
  if (!placerObjet(p, objet)) return res.status(400).json({ erreur: 'Le sac est plein.' });
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
  for (const i of [indexA, indexB].sort((x, y) => y - x)) p.inventaire.splice(i, 1);
  const objet = EQ.genererObjet(a.emplacement, niveau, rareteSup);
  placerObjet(p, objet); // deux pièces retirées : il y a forcément une case
  sauver(p);
  res.json({ objet, cout, personnage: etatPublic(p) });
});

// Déplacer une pièce PORTÉE sur le harnois (réagencement façon Tetris).
app.post('/api/deplacer', (req, res) => {
  const p = charger(req.body.nom);
  const { emplacement, x, y } = req.body;
  const o = p && p.equipement[emplacement];
  if (!o || !Number.isInteger(x) || !Number.isInteger(y)) return res.status(400).json({ erreur: 'Déplacement invalide.' });
  if (!peutPoser(o.taille, x, y, cellulesDebloquees(p), occupationHarnois(p, emplacement)))
    return res.status(400).json({ erreur: 'Cette pièce ne tient pas là.' });
  o.pos = { x, y };
  sauver(p);
  res.json({ objet: o, personnage: etatPublic(p) });
});

// Agrandir le harnois chez le sellier : +2 cases, prix doublant à chaque extension.
app.post('/api/harnois/extension', (req, res) => {
  const p = charger(req.body.nom);
  if (!p) return res.status(404).json({ erreur: 'Inconnu au registre.' });
  if ((p.extensionsHarnois || 0) >= HARNOIS.extensions_max) return res.status(400).json({ erreur: 'Le sellier ne fait pas plus grand.' });
  const prix = prixExtension(p);
  if (p.or < prix) return res.status(400).json({ erreur: `L'extension coûte ${prix} or.` });
  p.or -= prix;
  p.extensionsHarnois = (p.extensionsHarnois || 0) + 1;
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

// ---------- Arène classée (ELO, document de design §7.2) ----------
const ligueDe = elo => [...K.arene.ligues].reverse().find(([, seuil]) => elo >= seuil)[0];
const deltaElo = (eloA, eloB, score) => Math.round(K.arene.k * (score - 1 / (1 + 10 ** ((eloB - eloA) / 400))));

// Tous les personnages du registre (les snapshots servent de défenseurs PvP asynchrones).
function tousLesPersonnages(sauf) {
  const liste = [];
  for (const f of fs.readdirSync(DOSSIER_SAUVEGARDES)) {
    if (!f.endsWith('.json')) continue;
    try {
      const q = JSON.parse(fs.readFileSync(path.join(DOSSIER_SAUVEGARDES, f)));
      if (q.nom && q.nom.toLowerCase() !== (sauf || '').toLowerCase()) liste.push(q);
    } catch {}
  }
  return liste;
}

app.get('/api/arene/:nom', (req, res) => {
  const p = charger(req.params.nom);
  if (!p) return res.status(404).json({ erreur: 'Inconnu au registre.' });
  sauver(p);
  const classement = [...tousLesPersonnages(null)]
    .map(q => ({ nom: q.nom, classe: q.classe, niveau: q.niveau, elo: q.elo === undefined ? K.arene.elo_depart : q.elo }))
    .sort((a, b) => b.elo - a.elo).slice(0, 10)
    .map((q, i) => ({ rang: i + 1, ...q, ligue: ligueDe(q.elo) }));
  res.json({ elo: p.elo, ligue: ligueDe(p.elo), attaquesRestantes: p.arene.restantes,
             attaquesParJour: K.arene.attaques_par_jour, classement });
});

app.post('/api/arene/attaquer', (req, res) => {
  const p = charger(req.body.nom);
  if (!p) return res.status(404).json({ erreur: 'Inconnu au registre.' });
  if (p.arene.restantes <= 0) return res.status(400).json({ erreur: "Plus d'attaques classées aujourd'hui. L'arène rouvre demain." });
  p.arene.restantes--;

  // Appariement : ELO ± 100 ET niveau ± 8 (élargi progressivement s'il n'y a personne).
  const candidats = tousLesPersonnages(p.nom).filter(q => Math.abs(q.niveau - p.niveau) <= K.arene.plage_niveau);
  let adv = null;
  for (const plage of [1, 2, 4]) {
    const dansLaPlage = candidats.filter(q => Math.abs((q.elo ?? K.arene.elo_depart) - p.elo) <= K.arene.plage_elo * plage);
    if (dansLaPlage.length) { adv = dansLaPlage[Math.floor(Math.random() * dansLaPlage.length)]; break; }
  }
  let defenseur, eloDefenseur, defenseurReel = false;
  if (adv) {
    defenseurReel = true;
    eloDefenseur = adv.elo ?? K.arene.elo_depart;
    defenseur = new Combattant(`${adv.nom} (${adv.classe}, niv. ${adv.niveau})`, adv.classe, adv.attributs, adv.equipement);
  } else {
    // Personne dans la fourchette : un champion de l'arène fait le sparring (ELO simulé).
    const classes = Object.keys(K.classes);
    const classeBot = classes[Math.floor(Math.random() * classes.length)];
    eloDefenseur = p.elo + Math.floor(Math.random() * 80) - 40;
    defenseur = creerBot(`Champion de l'arène (${classeBot}, niv. ${p.niveau})`, classeBot, p.niveau, EQ.panoplieBot(p.niveau, 'Inhabituel'));
  }
  const r = duel(combattantDuJoueur(p), defenseur);
  const victoire = r.vainqueur === p.nom;
  const delta = deltaElo(p.elo, eloDefenseur, victoire ? 1 : 0);
  p.elo += delta;
  let gains = null;
  if (victoire) {
    p.victoires++;
    const sp = EQ.statsSpeciales(p.equipement);
    gains = { or: Math.round(orMission(p.niveau) * 0.8 * (1 + sp.aubaine / 100)),
              xp: Math.round(xpMission(p.niveau) * 0.8 * (1 + sp.sagesse / 100)) };
    p.or += gains.or;
    gains.niveauxGagnes = appliquerXp(p, gains.xp);
  } else p.defaites++;
  sauver(p);
  // Le défenseur réel gagne/perd aussi son ELO (PvP asynchrone).
  if (defenseurReel) {
    const q = charger(adv.nom);
    if (q) { q.elo += deltaElo(eloDefenseur, p.elo - delta, victoire ? 0 : 1); sauver(q); }
  }
  res.json({ victoire, adversaire: defenseur.nom, defenseurReel, journal: r.journal, gains,
             elo: p.elo, delta, ligue: ligueDe(p.elo), attaquesRestantes: p.arene.restantes,
             personnage: etatPublic(p) });
});

// Reforge : relance les affixes d'une pièce Rare+ contre une part de son prix.
app.post('/api/reforger', (req, res) => {
  const p = charger(req.body.nom);
  const o = p && p.inventaire[req.body.index];
  if (!p || !o) return res.status(400).json({ erreur: 'Objet introuvable.' });
  if (!K.equipement.affixes[o.rarete]) return res.status(400).json({ erreur: 'Seules les pièces Rare et plus portent des affixes.' });
  const cout = Math.round(EQ.prixObjet(o.niveau, o.rarete) * K.equipement.reforge_part_prix);
  if (p.or < cout) return res.status(400).json({ erreur: `Le reforgeage coûte ${cout} or.` });
  p.or -= cout;
  o.affixes = EQ.tirerAffixes(o.rarete);
  sauver(p);
  res.json({ objet: o, cout, personnage: etatPublic(p) });
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
    const sp = EQ.statsSpeciales(p.equipement);
    gains = { or: Math.round(orMission(p.niveau) * 0.6 * (1 + sp.aubaine / 100)),
              xp: Math.round(xpMission(p.niveau) * 0.6 * (1 + sp.sagesse / 100)) };
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
