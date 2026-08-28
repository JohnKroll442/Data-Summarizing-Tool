import re, pathlib, os

css_path = pathlib.Path(os.getcwd()) / 'src' / 'pages' / 'SummaryPage.css'
text = css_path.read_text(encoding='utf-8')

pattern = (
    r'\.summary-page ui5-bar::part\(bar\) \{[^}]+\}\s*'
    r'\.summary-page ui5-bar \{[^}]+\}\s*'
)
cleaned = re.sub(pattern, '', text)

css_path.write_text(cleaned, encoding='utf-8')
print("Done.")
print(f"Original: {len(text)} chars  →  New: {len(cleaned)} chars")
