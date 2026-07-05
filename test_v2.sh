#!/bin/bash
node serveur.js > serveur.log 2>&1 &
PID=$!
sleep 1.5
rm -f sauvegardes/testeurv2.json sauvegardes/heros.json
python3 - << 'PYEOF'
import json, urllib.request, shutil
def api(chemin, corps=None):
    req = urllib.request.Request('http://localhost:3000'+chemin,
        data=json.dumps(corps).encode() if corps else None,
        headers={'Content-Type':'application/json'}, method='POST' if corps else 'GET')
    try: return json.load(urllib.request.urlopen(req))
    except urllib.error.HTTPError as e: return json.load(e)

print('== Création avec arme héritée ==')
p = api('/api/personnage', {'nom':'TesteurV2','classe':'Guerrier'})
print('  arme :', p['equipement']['arme']['nom'], '| bonus ATK :', round(p['bonusEquipement']['atk']), '| puissance :', p['puissance'])

print('== Forge : achat, équipement, revente ==')
# Gagner de quoi acheter d'abord (les 50 or de départ ne suffisent pas — voulu)
for _ in range(8):
    api('/api/dev/energie', {'nom':'TesteurV2'})
    r = api('/api/mission', {'nom':'TesteurV2','contratId':2})
    if 'personnage' in r: p = r['personnage']
print('  or après quelques contrats :', p['or'])
forge = api('/api/forge/TesteurV2')
ligne = next(l for l in forge['catalogue'] if l['emplacement']=='casque' and l['rarete']=='Commun')
print('  casque Commun niv 1 : prix', ligne['prix'], '| stat', ligne['stat'])
r = api('/api/forge/acheter', {'nom':'TesteurV2','emplacement':'casque','rarete':'Commun'})
print('  acheté :', r['objet']['nom'], '| or restant', r['personnage']['or'])
r = api('/api/equiper', {'nom':'TesteurV2','index':0})
print('  équipé, PV passe à', r['personnage']['puissance']['pv'])
p = api('/api/personnage/TesteurV2')
if p['inventaire']:
    r = api('/api/vendre', {'nom':'TesteurV2','index':0})
    print('  revente :', r['objet']['nom'], '->', r['prix'], 'or')
else:
    print('  (sac vide, revente testée plus loin dans le grind)')

print('== Journal d’événements structurés ==')
api('/api/dev/energie', {'nom':'TesteurV2'})
r = api('/api/duel', {'nom':'TesteurV2'})
types = [e['t'] for e in r['journal']]
print('  types :', sorted(set(types)), '| init présent :', 'init' in types, '| fin présente :', 'fin' in types)
frappe = next((e for e in r['journal'] if e['t']=='frappe'), None)
print('  exemple frappe :', {k: frappe[k] for k in ('de','degats','crit','pvRestants')} if frappe else 'aucune')

print('== Grind avec équipement jusqu’au boss ==')
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
    # Stratégie joueur : ÉPARGNER pour la prochaine pièce d'équipement, dépenser le surplus en attributs
    forge = api('/api/forge/Heros')
    prochaine = None
    for emp, rarete in (('arme','Rare'), ('armure','Commun'), ('casque','Commun'), ('bottes','Commun')):
        equipe = p['equipement'].get(emp)
        if equipe and equipe['niveau'] >= p['niveau'] - 3: continue  # pièce encore fraîche
        if emp == 'arme' and p['niveau'] < 6: rarete = 'Inhabituel'
        prochaine = (emp, rarete, next(l['prix'] for l in forge['catalogue'] if l['emplacement']==emp and l['rarete']==rarete))
        break
    if prochaine and p['or'] >= prochaine[2]:
        r2 = api('/api/forge/acheter', {'nom':'Heros','emplacement':prochaine[0],'rarete':prochaine[1]})
        if 'personnage' in r2:
            p = r2['personnage']
            p = api('/api/equiper', {'nom':'Heros','index':len(p['inventaire'])-1})['personnage']
        prochaine = None
    reserve = prochaine[2] if prochaine else 0
    while p['or'] - reserve > p['couts']['agilite']:
        p = api('/api/attribut', {'nom':'Heros','attribut':'agilite'})['personnage']
        if p['or'] - reserve > p['couts']['endurance']:
            p = api('/api/attribut', {'nom':'Heros','attribut':'endurance'})['personnage']
    # vendre le surplus du sac
    while p['inventaire']:
        p = api('/api/vendre', {'nom':'Heros','index':0})['personnage']
print('  Niveau 10 | attributs :', {k: round(v) for k,v in p['attributs'].items()})
print('  panoplie :', {e: (o['rarete'] + ' niv.' + str(o['niveau'])) if o else '—' for e,o in p['equipement'].items()})
print('  puissance :', p['puissance'])
shutil.copy('sauvegardes/heros.json', '/tmp/heros_snapshot.json')
victoires = 0
for essai in range(10):
    shutil.copy('/tmp/heros_snapshot.json', 'sauvegardes/heros.json')
    api('/api/dev/energie', {'nom':'Heros'})
    r = api('/api/mission', {'nom':'Heros','contratId':25})
    if r.get('victoire'): victoires += 1
print(f'  BRENN (préparation complète + équipement) : {victoires}/10 victoires')
PYEOF
kill $PID
