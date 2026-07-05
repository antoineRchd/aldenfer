#!/bin/bash
node serveur.js > serveur.log 2>&1 &
PID=$!
sleep 1.5
rm -f sauvegardes/heros.json
python3 - << 'PYEOF'
import json, urllib.request, shutil
def api(chemin, corps=None):
    req = urllib.request.Request('http://localhost:3000'+chemin,
        data=json.dumps(corps).encode() if corps else None,
        headers={'Content-Type':'application/json'}, method='POST' if corps else 'GET')
    try: return json.load(urllib.request.urlopen(req))
    except urllib.error.HTTPError as e: return json.load(e)

p = api('/api/personnage', {'nom':'Heros','classe':'Rôdeur'})
while p['niveau'] < 10:
    api('/api/dev/energie', {'nom':'Heros'})
    contrats = [c for c in api('/api/contrats/Heros') if not c['verrouille'] and c['type'] != 'boss']
    cible = max(contrats, key=lambda c: c['niveau'])
    for pid in (19, 21, 22):
        prep = next((c for c in contrats if c['id']==pid), None)
        if prep and prep['accompli'] < (4 if pid==19 else 1): cible = prep; break
    r = api('/api/mission', {'nom':'Heros','contratId':cible['id']})
    if 'erreur' in r: continue
    p = r['personnage']
    if p['blesse']:
        r2 = api('/api/soigner', {'nom':'Heros'})
        if 'personnage' in r2: p = r2['personnage']
    while p['or'] > p['couts']['agilite']:
        p = api('/api/attribut', {'nom':'Heros','attribut':'agilite'})['personnage']
        if p['or'] > p['couts']['endurance']:
            p = api('/api/attribut', {'nom':'Heros','attribut':'endurance'})['personnage']
        if p['or'] > p['couts']['chance'] * 2:
            p = api('/api/attribut', {'nom':'Heros','attribut':'chance'})['personnage']
print('Niveau 10. Attributs:', {k: round(v) for k, v in p['attributs'].items()})
shutil.copy('sauvegardes/heros.json', '/tmp/heros_snapshot.json')
victoires = 0
for essai in range(10):
    shutil.copy('/tmp/heros_snapshot.json', 'sauvegardes/heros.json')
    api('/api/dev/energie', {'nom':'Heros'})
    r = api('/api/mission', {'nom':'Heros','contratId':25})
    if r.get('victoire'): victoires += 1
print(f'BRENN (avec préparation complète) : {victoires}/10 victoires')
PYEOF
kill $PID
