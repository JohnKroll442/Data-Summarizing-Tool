import json, rollout, ground_truth as gt
payload=json.load(open('payload.json'))
g=gt.load_ground_truth(); did=g['dataset_id']
for q in ['what are the KPI summary statistics?','how many slow actions exceed 120 seconds?']:
    r=rollout.run_rollout(q,payload,did,'auto')
    ao=(r['agent_outputs'] or {}).get('stats')
    print('==== Q:',q,'| intent=',r['intent'],'| keys=',list((r['agent_outputs'] or {}).keys()))
    if ao:
        k=ao.get('kpis')
        print('   stats.kpis =',json.dumps(k,indent=2) if k else '(none)')
        print('   stats top-level keys=',list(ao.keys()))
