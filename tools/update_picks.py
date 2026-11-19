#!/usr/bin/env python3
"""Publish the "Our Picks" page data from a GitHub issue body.

Flow (no Muse, no build step): Jay opens a GitHub issue from the
"Our Picks" issue form and types one pick per line —

    League | Player | Pick | Note (optional)

— and the Update Our Picks workflow (.github/workflows/update-picks.yml)
dumps the issue body to a file and runs this script against it. On
success the script rewrites assets/picks.js, which the /our-picks/
page renders into cards, and the workflow commits it. On any
validation error the script prints every error, exits 1 and writes
NOTHING, so the previously published picks stay live; the workflow
comments the errors back onto the issue and leaves it open (editing
the issue re-runs the workflow).

Usage:
    python3 tools/update_picks.py <body-file>
    PICKS_BODY="..." python3 tools/update_picks.py

The target repo root is LEGLOCK_REPO_ROOT when set, else the parent
directory of this script's tools/ folder.

Parsing rules: only lines containing "|" are pick candidates; every
other line (blank lines, the form's headings and guidance text) is
ignored. A candidate line must be League | Player | Pick with an
optional note; the league is case-insensitive and must be NBA, NFL or
NHL; player and pick must be non-empty; a note may itself contain
"|" (the extra fields are joined back into the note). At most 20
picks per post. A body with no candidate lines at all is an error.
"""

import json
import os
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

LEAGUES = {"NBA", "NFL", "NHL"}
MAX_PICKS = 20
ET = ZoneInfo("America/Toronto")


def repo_root():
    env = os.environ.get("LEGLOCK_REPO_ROOT")
    if env:
        return env
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read_body():
    if len(sys.argv) > 1:
        with open(sys.argv[1], "r", encoding="utf-8") as f:
            return f.read()
    return os.environ.get("PICKS_BODY")


def parse(body):
    """Return (picks, errors). picks is a list of dicts in posted
    order; errors is a list of human-readable strings with line
    numbers, one per problem found."""
    picks, errors = [], []
    saw_candidate = False
    for lineno, raw in enumerate(body.splitlines(), 1):
        line = raw.strip()
        if not line or "|" not in line:
            continue  # blank line or form text — not a pick line
        saw_candidate = True
        parts = [p.strip() for p in line.split("|")]
        if len(parts) < 3:
            errors.append(
                f"Line {lineno}: expected 'League | Player | Pick | Note "
                f"(optional)' but found only {len(parts)} field(s): {line!r}")
            continue
        league_raw, player, pick = parts[0], parts[1], parts[2]
        note = " | ".join(parts[3:]).strip()
        league = league_raw.upper()
        if league not in LEAGUES:
            errors.append(
                f"Line {lineno}: league {league_raw!r} is not one of "
                f"NBA, NFL, NHL.")
            continue
        if not player:
            errors.append(f"Line {lineno}: the player field is empty.")
            continue
        if not pick:
            errors.append(f"Line {lineno}: the pick field is empty.")
            continue
        picks.append({"league": league, "player": player,
                      "pick": pick, "note": note})
    if not saw_candidate:
        errors.append(
            "No picks found — no lines matched the "
            "'League | Player | Pick' format.")
    if len(picks) > MAX_PICKS:
        errors.append(
            f"Too many picks: {len(picks)} (the limit is {MAX_PICKS}).")
    return picks, errors


def main():
    body = read_body()
    if body is None:
        print("ERROR: no issue body — pass the body file as argv[1] "
              "or set PICKS_BODY.", file=sys.stderr)
        return 1
    picks, errors = parse(body)
    if errors:
        for e in errors:
            print(e, file=sys.stderr)
        return 1
    date_str = datetime.now(ET).strftime("%Y-%m-%d")
    data = {"date": date_str, "picks": picks}
    payload = json.dumps(data, ensure_ascii=False)
    # U+2028/U+2029 are legal JSON but line terminators in older JS
    # parsers; escape them so picks.js is safe everywhere.
    payload = payload.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    out_path = os.path.join(repo_root(), "assets", "picks.js")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("window.__PICKS = " + payload + ";\n")
    print(f"Published {len(picks)} pick(s) for {date_str} to assets/picks.js")
    return 0


if __name__ == "__main__":
    sys.exit(main())
