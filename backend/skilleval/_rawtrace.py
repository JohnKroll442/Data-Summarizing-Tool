import json
import rollout            # sets sys.path + loads .env + imports orchestrate
import orchestrate, llm
_orig = orchestrate.call_llm
captured = []
def wrap(system, user, *a, **k):
    r = _orig(system, user, *a, **k)
    captured.append((len(system), r))
    return r
orchestrate.call_llm = wrap
payload=json.load(open('payload.json'))
gt=json.load(open('ground_truth.json'))
out=rollout.run_rollout('which widget is the bottleneck in the worst action?', payload, gt['dataset_id'],'auto')
print('intent', out['intent'])
print('MAX_TOKENS=', llm.AI_CORE_MAX_TOKENS)
for slen, r in captured:
    tag='<-TRACE' if slen>15000 else ''
    print('--- syslen', slen, tag, 'resplen', len(r), '| has ```json:', '```json' in r, '| has brace:', '{' in r)
    if slen>15000:
        print('LAST 400 CHARS:\n', repr(r[-400:]))
