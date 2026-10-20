#!/usr/bin/env python3
"""Validates skill/zuma-dispatch against Chord's documented skill-package limits before upload
(docs: Skill files -> Files and access). Exit code 1 on any problem."""
import pathlib, re, sys

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "skill/zuma-dispatch")
problems, files = [], [p for p in root.rglob("*") if p.is_file()]
entry = root / "SKILL.md"
allowed_ref = {".md", ".txt", ".json", ".yaml", ".yml", ".csv"}

if not entry.exists(): problems.append("SKILL.md missing")
if len(files) > 64: problems.append(f"{len(files)} files > 64")
total = sum(p.stat().st_size for p in files)
if total > 256 * 1024: problems.append(f"package {total} bytes > 256 KiB")
for p in files:
    if p.suffix not in allowed_ref: problems.append(f"unsupported type: {p}")
    try: p.read_text(encoding="utf-8")
    except UnicodeDecodeError: problems.append(f"not UTF-8: {p}")
text = entry.read_text(encoding="utf-8") if entry.exists() else ""
fm = re.match(r"^---\nname: ([a-z0-9-]+)\ndescription: (.+?)\n---\n", text, re.S)
if not fm: problems.append("frontmatter must start the file with name and description")
if len(text) > 64_000: problems.append(f"entrypoint {len(text)} chars > 64,000")
for ref in sorted(set(re.findall(r"`(references/[^`]+)`", text))):
    if not (root / ref).exists(): problems.append(f"SKILL.md mentions {ref}, which is not in the package")

print(f"{root}: {len(files)} files, {total} bytes, entrypoint {len(text)} chars, name={fm.group(1) if fm else '?'}")
for p in problems: print("  PROBLEM:", p)
print("OK" if not problems else f"{len(problems)} problem(s)")
sys.exit(1 if problems else 0)
