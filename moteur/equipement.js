// Équipement — génération d'objets, prix, et calcul des bonus.
// Courbe de stat identique au tableur : stat = base × niveau^exposant × multiplicateur de rareté.
const K = require('./constantes.json');
const E = K.equipement;
const P = K.progression;

const NOMS_BASE = {
  arme: ['Lame', 'Épée', 'Hachette', 'Estoc'],
  armure: ['Cuirasse', 'Brigandine', 'Haubert'],
  casque: ['Heaume', 'Capuce renforcée', 'Bassinet'],
  bottes: ['Bottes', 'Brodequins', 'Houseaux'],
  amulette: ['Amulette', 'Talisman', 'Médaillon'],
  anneau: ['Anneau', 'Chevalière', 'Bague sigillaire']
};
// Suffixes suivant les conventions de nommage de la bible (§8)
const SUFFIXES = {
  'Commun': ['de fer', 'de facture honnête', 'du colporteur'],
  'Inhabituel': ['du Gué', 'des Comptoirs', 'de la Braise'],
  'Rare': ["d'ambrefeu", 'du Rempart-aux-Corbeaux', 'des Terrasses'],
  'Épique': ['du Long Hiver', 'de la Chiffonnière', 'vaskarien'],
  'Légendaire': ['du Premier Éveil', 'de la Garnison sans sommeil', 'des Rois-Bâtisseurs']
};

const statObjet = (niveau, rarete) => Math.round(E.stat_base * niveau ** E.stat_exposant * E.raretes[rarete].mult);
const orMission = n => Math.round(P.or_mission_base * n ** P.or_mission_exposant);
const prixObjet = (niveau, rarete) => Math.round(orMission(niveau) * E.raretes[rarete].prix);
const prixRevente = objet => Math.round(prixObjet(objet.niveau, objet.rarete) * E.prix_revente);

// Empreinte de l'objet dans le sac : les grandes lames (Rare et +) prennent
// une case de plus en hauteur — la puissance a un coût en place.
function tailleObjet(emplacement, rarete) {
  const t = { ...E.tailles[emplacement] };
  const rangs = Object.keys(E.raretes);
  if (emplacement === 'arme' && rangs.indexOf(rarete) >= rangs.indexOf(E.arme_grande_rarete_min))
    t.h = E.arme_grande_h;
  return t;
}

function genererObjet(emplacement, niveau, rarete) {
  const base = NOMS_BASE[emplacement][Math.floor(Math.random() * NOMS_BASE[emplacement].length)];
  const suffixe = SUFFIXES[rarete][Math.floor(Math.random() * SUFFIXES[rarete].length)];
  return { emplacement, niveau, rarete, stat: statObjet(niveau, rarete),
           taille: tailleObjet(emplacement, rarete), nom: `${base} ${suffixe}` };
}

// Tire une rareté selon les poids de butin (les objets vendus, eux, se choisissent).
function tirerRarete() {
  const total = Object.values(E.raretes).reduce((s, r) => s + r.poids_butin, 0);
  let jet = Math.random() * total;
  for (const [nom, r] of Object.entries(E.raretes)) {
    jet -= r.poids_butin;
    if (jet <= 0) return nom;
  }
  return 'Commun';
}

function tirerButin(niveau, rareteForcee = null) {
  const emplacement = E.emplacements[Math.floor(Math.random() * E.emplacements.length)];
  return genererObjet(emplacement, niveau, rareteForcee || tirerRarete());
}

// Somme les effets des objets équipés -> { atk, def, pv, force, agilite, intelligence, chance, ruse }
function bonusEquipement(equipement) {
  const bonus = { atk: 0, def: 0, pv: 0, force: 0, agilite: 0, intelligence: 0, endurance: 0, chance: 0, ruse: 0 };
  for (const objet of Object.values(equipement || {})) {
    if (!objet) continue;
    for (const [effet, coeff] of Object.entries(E.effets[objet.emplacement]))
      bonus[effet] += objet.stat * coeff;
  }
  return bonus;
}

// Panoplie de bots : équipement complet d'une rareté donnée (duels équitables).
function panoplieBot(niveau, rarete = 'Inhabituel') {
  const equipement = {};
  for (const emp of E.emplacements) equipement[emp] = genererObjet(emp, niveau, rarete);
  return equipement;
}

module.exports = { genererObjet, tirerButin, bonusEquipement, panoplieBot, prixObjet, prixRevente, statObjet, tailleObjet };
