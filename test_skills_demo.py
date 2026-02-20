#!/usr/bin/env python3
"""Simple demonstration script for SkillsLoader."""

from pathlib import Path
from agents.skills import SkillsLoader

# Get the workspace root (parent of this script)
workspace = Path(__file__).parent

# Initialize the loader
loader = SkillsLoader(workspace)

print("=" * 60)
print("SkillsLoader Demonstration")
print("=" * 60)

# List all available skills
print("\n1. Listing all available skills:")
print("-" * 60)
skills = loader.list_skills(filter_unavailable=False)
print(f"Found {len(skills)} skills:")
for skill in skills[:10]:  # Show first 10
    print(f"  - {skill['name']} ({skill['source']})")
if len(skills) > 10:
    print(f"  ... and {len(skills) - 10} more")

# Show workspace vs essential vs open breakdown
workspace_count = sum(1 for s in skills if s['source'] == 'workspace')
essential_count = sum(1 for s in skills if s['source'] == 'essential')
open_count = sum(1 for s in skills if s['source'] == 'open')
print(f"\n  Workspace skills: {workspace_count}")
print(f"  Essential skills: {essential_count}")
print(f"  Open skills: {open_count}")

# Try loading a specific skill
print("\n2. Loading a specific skill:")
print("-" * 60)
if skills:
    test_skill_name = skills[0]['name']
    print(f"Loading skill: {test_skill_name}")
    content = loader.load_skill(test_skill_name)
    if content:
        # Show first 200 characters
        preview = content[:200].replace('\n', ' ')
        print(f"  Preview: {preview}...")
        print(f"  Full length: {len(content)} characters")
    else:
        print(f"  Could not load {test_skill_name}")
else:
    print("  No skills available to load")

# Build skills summary
print("\n3. Building skills summary (XML format):")
print("-" * 60)
summary = loader.build_skills_summary()
if summary:
    # Show first 500 characters
    preview = summary[:500]
    print(preview)
    if len(summary) > 500:
        print(f"\n  ... (truncated, full summary is {len(summary)} characters)")
else:
    print("  No skills available")

# Get always skills
print("\n4. Skills marked as 'always':")
print("-" * 60)
always_skills = loader.get_always_skills()
if always_skills:
    print(f"  Found {len(always_skills)} always skills:")
    for skill_name in always_skills:
        print(f"    - {skill_name}")
else:
    print("  No skills marked as 'always'")

print("\n" + "=" * 60)
print("Demonstration complete!")
print("=" * 60)
