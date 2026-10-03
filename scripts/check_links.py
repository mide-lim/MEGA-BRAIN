"""Check local Markdown link destinations with the Python standard library."""
import re
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
errors = []
count = 0
for source in sorted(ROOT.rglob("*.md")):
    if ".git" in source.parts:
        continue
    for match in re.finditer(r"!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)", source.read_text(encoding="utf-8")):
        target = match.group(1).strip("<>")
        url = urlsplit(target)
        if url.scheme or url.netloc or not url.path:
            continue
        count += 1
        resolved = (ROOT / unquote(url.path).lstrip("/") if url.path.startswith("/") else source.parent / unquote(url.path)).resolve()
        line = source.read_text(encoding="utf-8").count("\n", 0, match.start()) + 1
        if not resolved.is_relative_to(ROOT):
            errors.append(f"{source.relative_to(ROOT)}:{line}: link escapes repository: {target}")
        elif not resolved.exists():
            errors.append(f"{source.relative_to(ROOT)}:{line}: missing destination: {target}")
for error in errors:
    print(error, file=sys.stderr)
print(f"Checked {count} local Markdown links; {len(errors)} errors.")
sys.exit(bool(errors))
