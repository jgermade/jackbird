"""Validates every file the semantics run wrote: mutagen parses it, ffmpeg
decodes it without errors, and the decoded audio's MD5 equals the source's."""
import subprocess, sys, pathlib, collections
from mutagen.id3 import ID3, ID3NoHeaderError
from mutagen.flac import FLAC

out = pathlib.Path(sys.argv[1])

def decoded_md5(path):
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a", "-f", "md5", "-"], capture_output=True, text=True)
    return r.stdout.strip(), r.stderr.strip()

def describe(path):
    if path.suffix == ".flac":
        f = FLAC(str(path))
        blocks = [type(b).__name__ for b in f.metadata_blocks]
        tags = f.tags.as_dict() if f.tags else {}
        return f"blocks={blocks} artist={tags.get('artist')} pictures={len(f.pictures)}"
    try:
        t = ID3(str(path))
    except ID3NoHeaderError:
        return "no ID3"
    counts = collections.Counter(k.split(":")[0] for k in t.keys())
    return f"v2.{t.version[1]} frames={sum(counts.values())} TDRC/TYER={[str(t[k]) for k in t.keys() if k in ('TDRC','TYER')]}"

problems = 0
sources = {}
paths = sorted(out.iterdir(), key=lambda p: (p.name.split(".")[0], ".src." not in p.name, p.name))
for path in paths:
    case, way = path.name.split(".")[0], ".".join(path.name.split(".")[1:-1])
    md5, err = decoded_md5(path)
    if way == "src":
        sources[case] = md5
    try:
        info = describe(path)
    except Exception as e:  # noqa
        info, problems = f"MUTAGEN ERROR {e!r}", problems + 1
    same = "" if way == "src" else ("audio=same" if md5 == sources.get(case) else "AUDIO DIFFERS")
    if err or "DIFFERS" in same:
        problems += 1
    print(f"{path.name:48} {same:14} {('FFMPEG: ' + err[:80]) if err else ''} {info}")
print("problems:", problems)
