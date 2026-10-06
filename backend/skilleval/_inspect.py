import json, rollout, ground_truth as gt
payload=json.load(open('payload.json'))
g=gt.load_ground_truth(); did=g['dataset_id']
cases={
 'stats':'how many actions are over the threshold?',
 'anomaly':'which anomaly types are present?',
 'root_cause':'why are these actions slow?',
 'explorer':'which hour is busiest?',
}
for key,q in cases.items():
    r=rollout.run_rollout(q,payload,did,'auto')
    ao=(r['agent_outputs'] or {}).get(key)
    print('====',key,'intent=',r['intent'],'err=',r['error'])
    if ao is None:
        print('   NO OUTPUT for key',key,'| present keys=',list((r['agent_outputs'] or {}).keys()))
    else:
        print('   status=',ao.get('status'),'top-level keys=',list(ao.keys()))
        print(json.dumps(ao,indent=2)[:1500])
