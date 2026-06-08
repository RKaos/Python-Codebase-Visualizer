import json, sys

path = sys.argv[1]
d = json.load(open(path))
print("n_init_targeted:", d['stats']['n_init_targeted_definition_edges'])
nm = {n['id']: n for n in d['nodes']}
for n in d['nodes']:
    ep = n['attributes'].get('framework_entrypoint', False)
    tag = " [FRAMEWORK_EP]" if ep else ""
    print(" ", n['kind'], n['qualname'] + tag)
print("---edges---")
for e in d['edges']:
    s = nm[e['source']]['qualname']
    t = nm[e['target']]['qualname']
    print(" ", e['kind'], e['provenance'], s, "->", t)
