"""Parse saved public Arena HTML without evaluating JavaScript or making requests.
Usage: python -X utf8 parse-arena-evidence.py [sources-directory]
Verifies raw byte SHA, decodes JSON-string Flight chunks, preserves raw locators.
"""
import hashlib, json, re, sys
from pathlib import Path

base = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / 'sources'
manifest = json.loads((base / 'manifest.json').read_text(encoding='utf-8-sig'))
manifest = manifest['sources'] if isinstance(manifest,dict) else manifest
pattern = re.compile(r'self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)')
results = []
for source in manifest:
    if source.get('status') != 200 or '/leaderboard/' not in source['url']:
        continue
    path = Path(source['evidenceFile'])
    raw = path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    assert digest == source['sha256'], f'Raw hash mismatch: {path}'
    html = raw.decode('utf-8')
    parts, spans, cursor = [], [], 0
    for match in pattern.finditer(html):
        literal = match.group(1)
        decoded = json.loads(literal)
        # Locate the complete JSON string literal in raw HTML, not rendered DOM.
        spans.append({'decodedStart': cursor, 'decodedEnd': cursor + len(decoded),
                      'htmlCharStart': match.start(1), 'htmlCharEnd': match.end(1),
                      'rawByteStart': len(html[:match.start(1)].encode('utf-8')),
                      'rawByteEnd': len(html[:match.end(1)].encode('utf-8')),
                      'literalSha256': hashlib.sha256(literal.encode('utf-8')).hexdigest()})
        parts.append(decoded)
        cursor += len(decoded) + 1
    flight = '\n'.join(parts)
    marker = flight.find('"leaderboard":{"arenaSlug"')
    assert marker >= 0, f'Leaderboard missing: {path}'
    start = flight.find('{', marker)
    board, consumed = json.JSONDecoder().raw_decode(flight[start:])
    end = start + consumed
    # Each relevant chunk can be independently sliced from raw bytes and JSON-decoded.
    bindings = [s for s in spans if s['decodedStart'] < end and s['decodedEnd'] > start]
    for span in bindings:
        literal_bytes = raw[span['rawByteStart']:span['rawByteEnd']]
        assert hashlib.sha256(literal_bytes).hexdigest() == span['literalSha256']
        assert json.loads(literal_bytes) == flight[span['decodedStart']:span['decodedEnd']]
    results.append({'sourceId': source['id'], 'url': source['url'], 'sourceSha256': digest,
                    'encoding': 'UTF-8 HTML containing JavaScript JSON string literals; JSON decoding only',
                    'decodedLeaderboardStart': start, 'decodedLeaderboardEnd': end,
                    'flightChunkBindings': bindings, 'leaderboard': board})
out = base / 'arena-reparsed-bindings.json'
out.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'output': str(out), 'verifiedSources': len(results),
                  'entryCounts': {r['sourceId']: len(r['leaderboard']['entries']) for r in results}}))
