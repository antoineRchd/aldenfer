// Moteur de combat v2 — mêmes formules validées, mais le journal devient une liste
// d'ÉVÉNEMENTS structurés : le client peut animer la scène ET afficher le registre.
// Chaque événement porte un champ `texte` prêt pour le registre du greffier.
const K = require('./constantes.json');
const C = K.combat;
const CLASSES = K.classes;
const { bonusEquipement } = require('./equipement.js');

const alea = (a, b) => a + Math.random() * (b - a);

class Combattant {
  // attrs : {force, agilite, intelligence, endurance, chance, ruse}
  // equipement : {arme, armure, ...} (objets ou null) ; modifs : {pv_mult, atk_mult}
  constructor(nom, classe, attrs, equipement = {}, modifs = {}) {
    this.nom = nom; this.classe = classe;
    const g = bonusEquipement(equipement);
    // L'équipement ne donne que des attributs : on somme attributs propres + panoplie.
    this.agi = attrs.agilite + g.agilite;
    this.chanceStat = attrs.chance + g.chance;
    const endurance = attrs.endurance + g.endurance;
    this.pvMax = Math.round((C.pv_base + C.pv_par_endurance * endurance + g.pv) * (modifs.pv_mult || 1));
    this.pv = this.pvMax;
    const offensif = { Guerrier: 'force', 'Rôdeur': 'agilite', Mage: 'intelligence', Ombre: 'agilite' }[classe];
    this.atk = (C.atk_base + C.atk_par_point * (attrs[offensif] + (g[offensif] || 0)) + g.atk) * (modifs.atk_mult || 1);
    this.def = C.def_base + C.def_par_endurance * endurance + g.def;
    this.bouclier = classe === 'Guerrier' ? C.guerrier_bouclier_pct * this.pvMax : 0;
    this.rage = 0;
    this.esquives = classe === 'Ombre' ? C.ombre_esquives_auto : 0;
    this.tourPerso = 0;
  }
  precisionContre(cible) {
    if (this.classe === 'Mage') return C.mage_precision_fixe;
    const p = C.precision_base + (this.agi - cible.agi) * C.precision_par_agi;
    return Math.max(C.precision_min, Math.min(C.precision_max, p));
  }
  chanceCrit() {
    if (this.classe === 'Ombre')
      return Math.min(C.ombre_crit_cap, (C.crit_base + this.chanceStat * C.crit_par_chance) * C.ombre_crit_mult_chance);
    return Math.min(C.crit_cap, C.crit_base + this.chanceStat * C.crit_par_chance);
  }
  attaquer(cible, journal) {
    this.tourPerso++;
    let frappes = 1;
    if (this.classe === 'Rôdeur' && Math.random() < C.rodeur_double_frappe) frappes = 2;
    for (let f = 0; f < frappes; f++) {
      if (cible.pv <= 0) return;
      if (cible.esquives > 0) {
        cible.esquives--;
        journal.push({ t: 'esquive', de: this.nom, vers: cible.nom, genre: 'ombre',
          texte: `${cible.nom} s'évanouit dans l'ombre — esquive parfaite.` });
        continue;
      }
      if (cible.classe === 'Ombre' && Math.random() * 100 < C.ombre_esquive_passive) {
        journal.push({ t: 'esquive', de: this.nom, vers: cible.nom, genre: 'passive',
          texte: `${cible.nom} se dérobe d'un pas de côté.` });
        continue;
      }
      if (Math.random() * 100 > this.precisionContre(cible)) {
        journal.push({ t: 'rate', de: this.nom, vers: cible.nom, texte: `${this.nom} frappe dans le vide.` });
        continue;
      }
      let def = cible.def;
      if (this.classe === 'Mage') def *= 1 - C.mage_ignore_def;
      let deg = this.atk ** 2 / (this.atk + def);
      deg *= 1 + alea(-C.degats_alea, C.degats_alea);
      const ev = { t: 'frappe', de: this.nom, vers: cible.nom, crit: false, surcharge: false, embuscade: false, absorbe: 0,
                   double: frappes === 2 ? f + 1 : 0 };
      if (this.classe === 'Mage' && this.tourPerso % 3 === 0) { deg *= C.mage_surcharge_mult; ev.surcharge = true; }
      if (this.classe === 'Guerrier' && this.rage > 0) deg *= 1 + this.rage;
      if (this.tourPerso === 1 && this.classe === 'Ombre') { deg *= 1 + C.ombre_embuscade; ev.embuscade = true; }
      if (Math.random() * 100 < this.chanceCrit()) {
        deg *= this.classe === 'Ombre' ? C.ombre_crit_mult : C.crit_mult;
        ev.crit = true;
      }
      if (cible.bouclier > 0) {
        const abs = Math.min(cible.bouclier, deg);
        cible.bouclier -= abs; deg -= abs;
        ev.absorbe = Math.round(abs);
      }
      deg = Math.round(deg);
      cible.pv -= deg;
      if (cible.classe === 'Guerrier') cible.rage += C.guerrier_rage_par_coup;
      ev.degats = deg;
      ev.pvRestants = Math.max(0, Math.round(cible.pv));
      ev.pvMax = cible.pvMax;
      const notes = [];
      if (ev.surcharge) notes.push('SURCHARGE ARCANIQUE');
      if (ev.embuscade) notes.push('embuscade');
      if (ev.crit) notes.push('CRITIQUE');
      if (ev.absorbe) notes.push(`${ev.absorbe} absorbés par le bouclier`);
      const dbl = ev.double ? ` (${ev.double === 1 ? '1re' : '2e'} frappe)` : '';
      ev.texte = `${this.nom} inflige ${deg} dégâts à ${cible.nom}${dbl}${notes.length ? ' — ' + notes.join(', ') : ''}. [PV ${ev.pvRestants}/${cible.pvMax}]`;
      journal.push(ev);
    }
  }
}

// Résout un duel ; modifs.initiative_a === true force A à frapper en premier.
function duel(a, b, modifs = {}) {
  const journal = [];
  journal.push({ t: 'init',
    a: { nom: a.nom, classe: a.classe, pvMax: a.pvMax, figure: a.figure || null },
    b: { nom: b.nom, classe: b.classe, pvMax: b.pvMax, figure: b.figure || null },
    texte: `${a.nom} affronte ${b.nom}.` });
  let premier, second;
  if (modifs.initiative_a) [premier, second] = [a, b];
  else if (a.classe === 'Rôdeur' && b.classe !== 'Rôdeur') [premier, second] = [a, b];
  else if (b.classe === 'Rôdeur' && a.classe !== 'Rôdeur') [premier, second] = [b, a];
  else [premier, second] = a.agi + alea(0, 30) >= b.agi + alea(0, 30) ? [a, b] : [b, a];
  journal.push({ t: 'initiative', qui: premier.nom, texte: `${premier.nom} a l'initiative.` });
  for (let t = 1; t <= C.tours_max; t++) {
    journal.push({ t: 'tour', n: t, texte: `— Tour ${t} —` });
    premier.attaquer(second, journal);
    if (second.pv <= 0) {
      journal.push({ t: 'fin', vainqueur: premier.nom, texte: `${second.nom} s'effondre. ${premier.nom} l'emporte.` });
      return { vainqueur: premier.nom, journal };
    }
    second.attaquer(premier, journal);
    if (premier.pv <= 0) {
      journal.push({ t: 'fin', vainqueur: second.nom, texte: `${premier.nom} s'effondre. ${second.nom} l'emporte.` });
      return { vainqueur: second.nom, journal };
    }
  }
  const va = a.pv / a.pvMax >= b.pv / b.pvMax ? a : b;
  journal.push({ t: 'fin', vainqueur: va.nom, timeout: true,
    texte: `Les juges arrêtent le duel au bout de ${C.tours_max} tours. ${va.nom} l'emporte aux points (PV restants).` });
  return { vainqueur: va.nom, journal };
}

// Budget recalé sur la puissance RÉALISTE d'un joueur (soins, échecs, arbitrage or/équipement inclus) — mesures du 05/07.
function budgetPourNiveau(n) { return Math.floor(36 + 5.2 * n ** 1.25); }
function creerBot(nom, classe, niveau, equipement = {}, modifs = {}) {
  const pts = budgetPourNiveau(niveau);
  const [f, a, i, e, c, r] = CLASSES[classe].build_bot;
  return new Combattant(nom, classe, {
    force: pts * f, agilite: pts * a, intelligence: pts * i,
    endurance: pts * e, chance: pts * c, ruse: pts * r
  }, equipement, modifs);
}

module.exports = { Combattant, duel, creerBot, budgetPourNiveau };
