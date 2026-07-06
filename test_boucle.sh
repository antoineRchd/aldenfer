#!/bin/bash
node serveur.js > serveur.log 2>&1 &
PID=$!
sleep 1.5
rm -f sauvegardes/testeur.json
echo "== Création =="
curl -s -X POST localhost:3000/api/personnage -H 'Content-Type: application/json' -d '{"nom":"Testeur","classe":"Rôdeur"}' | python3 -c "import json,sys; d=json.load(sys.stdin); print('niv',d['niveau'],'| or',d['or'],'| énergie',d['energie'],'| agilité',d['attributs']['agilite'],'| coût +1 agi (rabais):',d['couts']['agilite'],'vs force:',d['couts']['force'])"
echo "== Mission 1 =="
curl -s -X POST localhost:3000/api/mission -H 'Content-Type: application/json' -d '{"nom":"Testeur","contratId":1}' | python3 -c "import json,sys; d=json.load(sys.stdin); print('réussite' if d['reussite'] else 'échec','| chance',d['chance'],'% | gains',d['gains'],'| énergie',d['personnage']['energie'])"
echo "== Contrat 25 (doit être verrouillé) =="
curl -s -X POST localhost:3000/api/mission -H 'Content-Type: application/json' -d '{"nom":"Testeur","contratId":25}' | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('erreur','PROBLÈME: accepté !'))"
echo "== Achat d'attribut =="
curl -s -X POST localhost:3000/api/attribut -H 'Content-Type: application/json' -d '{"nom":"Testeur","attribut":"agilite"}' | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('erreur') or 'agilité -> %s pour %s or (reste %s or)'%(d['nouvelleValeur'],d['cout'],d['personnage']['or']))"
echo "== Duel =="
curl -s -X POST localhost:3000/api/duel -H 'Content-Type: application/json' -d '{"nom":"Testeur"}' | python3 -c "import json,sys; d=json.load(sys.stdin); print('vs',d['adversaire'],'->','VICTOIRE' if d['victoire'] else 'défaite','|',len(d['journal']),'lignes de rapport'); print('  extrait:',d['journal'][2]['texte'][:110])"
echo "== Grind automatisé : monter au niveau 10 et affronter Brenn =="
python3 - << 'PYEOF'
import json, urllib.request
def api(chemin, corps=None):
    req = urllib.request.Request('http://localhost:3000'+chemin,
        data=json.dumps(corps).encode() if corps else None,
        headers={'Content-Type':'application/json'}, method='POST' if corps else 'GET')
    try:
        return json.load(urllib.request.urlopen(req))
    except urllib.error.HTTPError as e:
        return json.load(e)
p = api('/api/personnage/Testeur')
prep_faites = 0
while True:
    api('/api/dev/energie', {'nom':'Testeur'})
    tous = api('/api/contrats/Testeur')
    # Prêt pour l'assaut : niveau 10 ET la trame menée jusqu'au boss.
    if p['niveau'] >= 10 and not next(c for c in tous if c['type'] == 'boss')['verrouille']: break
    contrats = [c for c in tous if not c['verrouille'] and c['type'] != 'boss']
    # La trame se suit dans l'ordre : frontière d'abord, sinon le meilleur contrat accompli.
    frontiere = next((c for c in contrats if not c['accompli']), None)
    cible = frontiere or max(contrats, key=lambda c: (c['niveau'], c['type'] == 'or', -c['id']))
    # faire les contrats de préparation quand disponibles
    for prep_id in (19, 21, 22):
        prep = next((c for c in contrats if c['id']==prep_id), None)
        if prep and (prep['accompli'] < (4 if prep_id==19 else 1)):
            cible = prep; break
    r = api('/api/mission', {'nom':'Testeur','contratId':cible['id']})
    if 'erreur' in r: api('/api/dev/energie', {'nom':'Testeur'}); continue
    p = r['personnage']
    if p['blesse']:
        r2 = api('/api/soigner', {'nom':'Testeur'})
        if 'personnage' in r2: p = r2['personnage']
    # dépenser l'or en attributs de classe
    while p['or'] > p['couts']['agilite']:
        p = api('/api/attribut', {'nom':'Testeur','attribut':'agilite'})['personnage']
        if p['or'] > p['couts']['endurance']:
            p = api('/api/attribut', {'nom':'Testeur','attribut':'endurance'})['personnage']
print('Niveau 10 atteint. Attributs :', {k: round(v) for k,v in p['attributs'].items()}, '| or restant:', p['or'])
api('/api/dev/energie', {'nom':'Testeur'})
prepa = {c['id']: c['accompli'] for c in api('/api/contrats/Testeur') if c.get('prep')}
print('Contrats de préparation accomplis :', prepa)
r = api('/api/mission', {'nom':'Testeur','contratId':25})
print('ASSAUT DE VIEUX-BIEF :', 'VICTOIRE' if r['victoire'] else 'défaite', '| préparation appliquée :', r['preparation'])
if r['victoire']: print('Titre gagné :', r['recompenses']['titre'], '| or :', r['recompenses']['or'])
print('Dernière ligne du rapport :', r['journal'][-1])
PYEOF
kill $PID
