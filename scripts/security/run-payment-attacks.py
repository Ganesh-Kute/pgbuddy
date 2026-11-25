#!/usr/bin/env python3
"""Run scripts/security/payment-attacks.sql against the live database (always rolled back).

  python3 scripts/security/run-payment-attacks.py                       # check production as it is
  python3 scripts/security/run-payment-attacks.py --with MIGRATION.sql  # dry-run a migration first, then check

Uses the Supabase Management API (token from the environment's proxy); prints PASS/FAIL per check and
exits 1 if any check fails.
"""
import json, subprocess, sys, pathlib

PROJECT = "vcpohetbsyyjqqkzuzxj"
here = pathlib.Path(__file__).parent
sql = (here / "payment-attacks.sql").read_text()
if "--with" in sys.argv:
    sql = pathlib.Path(sys.argv[sys.argv.index("--with") + 1]).read_text() + "\n" + sql
# One explicit transaction: the check always raises, so the migration and the test data are rolled back.
body = json.dumps({"query": "BEGIN;\n" + sql + "\nCOMMIT;"})
out = subprocess.run(["curl", "-s", "-X", "POST", f"https://api.supabase.com/v1/projects/{PROJECT}/database/query",
                      "-H", "Content-Type: application/json", "-d", body], capture_output=True, text=True).stdout
msg = json.loads(out).get("message", out) if out.startswith("{") else out
if "AUDIT_RESULTS" not in msg:
    print("Check did not run:", msg[:800]); sys.exit(2)
lines = msg.split("AUDIT_RESULTS", 1)[1].split("\nCONTEXT")[0].strip().splitlines()
print("\n".join(lines))
fails = [l for l in lines if l.startswith("FAIL")]
print(f"\n{len(lines) - len(fails)} passed, {len(fails)} failed")
sys.exit(1 if fails else 0)
