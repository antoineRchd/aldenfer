#!/bin/bash
# Parcours complet de la région 2 : bat Brenn, déverrouille les Terrasses, grinde
# jusqu'au niveau 20 (forge + fusion), prépare puis assaut l'Éveilleur ×10.
node serveur.js > serveur.log 2>&1 &
PID=$!
sleep 1.5
rm -f sauvegardes/pelerin.json
python3 - << 'PYEOF'
import json, urllib.request, shutil
def api(chemin, corps=None):
    req = urllib.request.Request('http://localhost:3000'+chemin,
        data=json.dumps(corps).encode() if corps else None,
        headers={'Content-Type':'application/json'}, method='POST' if corps else 'GET')
    try: return json.load(urllib.request.urlopen(req))
    except urllib.error.HTTPError as e: return json.load(e)

p = api('/api/personnage', {'nom':'Pelerin','classe':'Rôdeur'})
missions = 0
while True:
    api('/api/dev/energie', {'nom':'Pelerin'})
    tous = api('/api/contrats/Pelerin')
    boss2 = next(c for c in tous if c['id'] == 50)
    if p['niveau'] >= 20 and not boss2['verrouille']: break
    contrats = [c for c in tous if not c['verrouille'] and c['type'] != 'boss']
    # Frontière d'abord (les boss de région se battent quand ils sont la frontière)
    frontiere = next((c for c in tous if not c['accompli'] and not c['verrouille']), None)
    cible = frontiere or max(contrats, key=lambda c: (c['niveau'], c['type'] == 'or', -c['id']))
    for pid in (46, 47, 48):
        prep = next((c for c in contrats if c['id'] == pid), None)
        if prep and prep['accompli'] < (4 if pid == 46 else 1): cible = prep; break
    r = api('/api/mission', {'nom':'Pelerin','contratId':cible['id']})
    missions += 1
    if 'erreur' in r: continue
    p = r['personnage']
    if p['blesse']:
        r2 = api('/api/soigner', {'nom':'Pelerin'})
        if 'personnage' in r2: p = r2['personnage']
    # Équipement : arme Inhabituelle fraîche, le reste en Commun
    forge = api('/api/forge/Pelerin')
    prochaine = None
    for emp, rarete in (('arme','Inhabituel'), ('armure','Commun'), ('casque','Commun'), ('bottes','Commun'), ('amulette','Commun')):
        equipe = p['equipement'].get(emp)
        if equipe and equipe['niveau'] >= p['niveau'] - 3: continue
        prochaine = (emp, rarete, next(l['prix'] for l in forge['catalogue'] if l['emplacement']==emp and l['rarete']==rarete))
        break
    if prochaine and p['or'] >= prochaine[2]:
        r2 = api('/api/forge/acheter', {'nom':'Pelerin','emplacement':prochaine[0],'rarete':prochaine[1]})
        if 'personnage' in r2:
            p = r2['personnage']
            r3 = api('/api/equiper', {'nom':'Pelerin','index':len(p['inventaire'])-1})
            if 'personnage' in r3: p = r3['personnage']
        prochaine = None
    # Fusion : deux pièces jumelles au sac -> rareté supérieure, qu'on équipe si mieux
    doubles = {}
    for i, o in enumerate(p['inventaire']):
        cle = (o['emplacement'], o['rarete'])
        if cle in doubles:
            r2 = api('/api/fusionner', {'nom':'Pelerin','indexA':doubles[cle],'indexB':i})
            if 'personnage' in r2:
                p = r2['personnage']
                r3 = api('/api/equiper', {'nom':'Pelerin','index':len(p['inventaire'])-1})
                if 'personnage' in r3: p = r3['personnage']
            break
        doubles[cle] = i
    reserve = prochaine[2] if prochaine else 0
    while p['or'] - reserve > p['couts']['agilite']:
        p = api('/api/attribut', {'nom':'Pelerin','attribut':'agilite'})['personnage']
        if p['or'] - reserve > p['couts']['endurance']:
            p = api('/api/attribut', {'nom':'Pelerin','attribut':'endurance'})['personnage']
    while len(p['inventaire']) > 6:
        p = api('/api/vendre', {'nom':'Pelerin','index':0})['personnage']

print(f'Niveau 20 en {missions} missions | attributs :', {k: round(v) for k,v in p['attributs'].items()})
print('  panoplie :', {e: (o['rarete'] + ' niv.' + str(o['niveau'])) if o else '—' for e,o in p['equipement'].items()})
prepa = {c['id']: c['accompli'] for c in api('/api/contrats/Pelerin') if c.get('prep') and c['region']==2}
print('  préparations (46/47/48) :', prepa)
shutil.copy('sauvegardes/pelerin.json', '/tmp/pelerin_snapshot.json')
victoires, legendaire = 0, None
for essai in range(10):
    shutil.copy('/tmp/pelerin_snapshot.json', 'sauvegardes/pelerin.json')
    api('/api/dev/energie', {'nom':'Pelerin'})
    r = api('/api/mission', {'nom':'Pelerin','contratId':50})
    if r.get('victoire'):
        victoires += 1
        if r['recompenses'].get('objet'): legendaire = r['recompenses']['objet']
print(f"L'ÉVEILLEUR (préparation complète) : {victoires}/10 victoires")
if legendaire: print('  butin :', legendaire['nom'], '|', legendaire['rarete'], '| stat', legendaire['stat'])
PYEOF
kill $PID
