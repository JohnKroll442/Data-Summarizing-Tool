"""Remove duplicate export function declarations from actionBoxplot/Pareto/Scatter."""
import re

FILES = [
    'src/components/charts/options/actionBoxplot.js',
    'src/components/charts/options/actionPareto.js',
    'src/components/charts/options/actionScatter.js',
]

for filepath in FILES:
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # Find all top-level export function declarations
    matches = list(re.finditer(r'^export function \w+', content, re.MULTILINE))

    if len(matches) < 2:
        print(f'{filepath}: only {len(matches)} export(s) — nothing to do')
        continue

    second_start = matches[1].start()

    # Walk back to the blank line (\n\n) immediately before the duplicate.
    # Everything from that blank line onwards is the unwanted second copy.
    before = content[:second_start]
    last_blank = before.rfind('\n\n')
    cut_pos = (last_blank + 1) if last_blank != -1 else second_start

    new_content = content[:cut_pos] + '\n'

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(new_content)

    kept  = len(new_content.splitlines())
    total = len(content.splitlines())
    print(f'{filepath}: removed lines {kept + 1}–{total}  ({total - kept} lines dropped, {kept} kept)')
