"""A8 timing oracle: python3 a8_oracle.py <transcript-json-or-cli-stdout>.
Reference anchors are the video's own YouTube English captions (start seconds).
PASS needs: every anchor found within +-6 s, last block end <= 540 s, last block
text contains the closing line, blocks monotonic and <= 8 s."""
import json, sys
ANCHORS = [("cohort 005", 262.0), ("enjoy my self-paced", 501.2), ("that is the home repo", 513.9), ("see you in the next one", 531.0)]
t = open(sys.argv[1]).read(); d = json.loads(t[t.rfind("\n{") + 1:] if not t.lstrip().startswith("{") else t)
b = d["blocks"]; ok = True
def norm(s): return " ".join(s.lower().replace(",", " ").split())
for phrase, ref in ANCHORS:
    hits = [x for x in b if phrase in norm(x["text"])]
    if not hits: print(f"FAIL anchor '{phrase}' missing"); ok = False; continue
    got = hits[0]["start"]; good = abs(got - ref) <= 6
    print(f"{'ok  ' if good else 'FAIL'} anchor '{phrase}' ref {ref} got {round(got,1)}"); ok &= good
end = b[-1]["end"]; print(f"{'ok  ' if end <= 540 else 'FAIL'} last end {round(end,1)} <= 540"); ok &= end <= 540
mono = all(b[i]["start"] <= b[i + 1]["start"] for i in range(len(b) - 1)); mx = max(x["end"] - x["start"] for x in b)
print(f"{'ok  ' if mono and mx <= 8 else 'FAIL'} monotonic {mono} max block {round(mx,2)} s"); ok &= mono and mx <= 8
print("A8 TIMING PASS" if ok else "A8 TIMING FAIL"); sys.exit(0 if ok else 1)
