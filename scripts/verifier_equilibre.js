// Vérificateur d'équilibre — utilise le VRAI moteur du jeu (mieux que le simulateur Python séparé).
// Usage : node scripts/verifier_equilibre.js [nbCombats] [rareté]
const { duel, creerBot } = require('../moteur/combat.js');
const { panoplieBot } = require('../moteur/equipement.js');

const N = parseInt(process.argv[2] || '4000');
const RARETE = process.argv[3] || 'Rare';
const CLASSES = ['Guerrier', 'Rôdeur', 'Mage', 'Ombre'];
const NIVEAUX = [15, 40, 80];

console.log(`${N} combats par matchup — panoplie complète ${RARETE} des deux côtés\n`);
const global_ = Object.fromEntries(CLASSES.map(c => [c, []]));
for (const niv of NIVEAUX) {
  console.log(`=== Niveau ${niv} ===`);
  for (let i = 0; i < CLASSES.length; i++) for (let j = i + 1; j < CLASSES.length; j++) {
    let v = 0;
    for (let k = 0; k < N; k++) {
      const a = creerBot('A', CLASSES[i], niv, panoplieBot(niv, RARETE));
      const b = creerBot('B', CLASSES[j], niv, panoplieBot(niv, RARETE));
      if (duel(a, b).vainqueur === 'A') v++;
    }
    const wr = 100 * v / N;
    global_[CLASSES[i]].push(wr); global_[CLASSES[j]].push(100 - wr);
    const marque = wr < 42 || wr > 58 ? '  <-- HORS CIBLE' : '';
    console.log(`  ${CLASSES[i].padEnd(9)} vs ${CLASSES[j].padEnd(9)} : ${wr.toFixed(1)}% / ${(100 - wr).toFixed(1)}%${marque}`);
  }
}
console.log('\n=== Moyennes globales (cible 47-53%) ===');
for (const c of CLASSES) {
  const m = global_[c].reduce((s, x) => s + x, 0) / global_[c].length;
  console.log(`  ${c.padEnd(9)} : ${m.toFixed(1)}%`);
}
