#!/usr/bin/env python3
"""Check structural installation and private-memory Git boundaries without writing."""
from pathlib import Path
import json
import subprocess
import sys

ROOT_DEPTH = 2
CONFIG_PATH = "workspace/harness-config/project-meta/project.json"

def main():
    repo = Path(__file__).resolve().parents[ROOT_DEPTH]
    try:
        config = json.loads((repo / CONFIG_PATH).read_text(encoding="utf-8"))
        private = config["areas"]["private_memory"]
        (repo / private).resolve().relative_to(repo)
        owner = subprocess.run(["aicatlog", "harness", "check", "--repo", str(repo),
                                "--format", "json", *sys.argv[1:]], capture_output=True, text=True)
        data = json.loads(owner.stdout)
        data = data.get("data", data)
        probe = subprocess.run(["git", "-C", str(repo), "check-ignore", "--no-index",
                                "--quiet", "--", private + "/.project-meta-private-probe"])
        tracked = subprocess.run(["git", "--literal-pathspecs", "-C", str(repo),
                                  "ls-files", "--", private], capture_output=True, text=True)
        count = len(tracked.stdout.splitlines())
        ok = (owner.returncode == 0 and data.get("ok") is True
              and not data.get("modified_files") and probe.returncode == 0
              and tracked.returncode == 0 and count == 0)
        result = {"ok": ok, "scope": "Structure and Git ignore/tracking only; task acceptance is separate.",
                  "foundation": data, "private_memory_ignored": probe.returncode == 0,
                  "tracked_private_files": count if tracked.returncode == 0 else None}
    except (OSError, ValueError, KeyError, TypeError) as error:
        result = {"ok": False, "error": str(error)}
    print(json.dumps(result, indent=2))
    return 0 if result["ok"] else 1

if __name__ == "__main__":
    raise SystemExit(main())
