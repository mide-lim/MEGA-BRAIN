"""Offline state verification only; never approves or applies operator cutover."""
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
PATHS = ('AGENTS.md', 'docs/history/AGENTS-2026-10-28.txt',
         'operations/hermes-control/proposals/AGENTS.md.txt',
         '.github/workflows/paperclip-control.yml',
         'ops/paperclip/history/paperclip-control.workflow.yml')
PENDING = 'pending-independent-review-and-operator-cutover'
APPLIED = 'applied-reviewed-operator-cutover'
# Immutable pre-cutover baselines, not derived from a mutable manifest.
ORIGINAL_AGENTS_SHA256 = 'b5f68918a7667a1a764212379f043eb622d32b8f0465d7e4aa641d602363d60a'
ORIGINAL_WORKFLOW_SHA256 = '0695ec04052a2db1ba88ac187fdfae628d353812716d224141ab0b2d58356cbb'


def hashes(root=None):
    root = ROOT if root is None else Path(root)
    return {p: hashlib.sha256((root / p).read_bytes()).hexdigest() for p in PATHS
            if p != PATHS[3] or (root / p).exists() or (root / p).is_symlink()}


def verify(root=None):
    root = ROOT if root is None else Path(root)
    manifest = json.loads((root / 'ops/hermes/cutover.json').read_text())

    def require(condition, message):
        if not condition:
            raise ValueError(message)

    phase = manifest.get('status')
    require(phase in (PENDING, APPLIED), 'Unknown cutover status')
    require(manifest.get('schema_version') == 'megabrain.hermes-cutover.v1',
            'Unknown cutover schema')
    actual = hashes(root)
    require(manifest.get('historical_agents') == {
        'path': PATHS[1], 'sha256': ORIGINAL_AGENTS_SHA256}, 'Historical baseline changed')
    require(actual[PATHS[1]] == ORIGINAL_AGENTS_SHA256, 'Historical AGENTS bytes changed')
    require(manifest.get('agents_replacement') == {
        'source': PATHS[2], 'target': PATHS[0], 'sha256': actual[PATHS[2]]},
        'Proposal hash or route mismatch')
    require(manifest.get('workflow_archive') == {
        'source': PATHS[3], 'target': PATHS[4], 'sha256': ORIGINAL_WORKFLOW_SHA256},
        'Workflow baseline or route changed')
    require(actual[PATHS[4]] == ORIGINAL_WORKFLOW_SHA256, 'Workflow archive bytes changed')
    expected_active = ORIGINAL_AGENTS_SHA256 if phase == PENDING else actual[PATHS[2]]
    require(manifest.get('active_agents') == {
        'path': PATHS[0], 'sha256': expected_active}, 'Active AGENTS manifest inconsistent with phase')
    require(actual[PATHS[0]] == expected_active, 'Active AGENTS bytes inconsistent with phase')
    if phase == PENDING:
        require((root / PATHS[0]).read_bytes() == (root / PATHS[1]).read_bytes(),
                'Pending AGENTS differs from history')
        require((root / PATHS[3]).read_bytes() == (root / PATHS[4]).read_bytes(),
                'Pending workflow differs from archive')
    else:
        require(not (root / PATHS[3]).exists() and not (root / PATHS[3]).is_symlink(),
                'Old workflow still present after applied cutover')
    return actual


if __name__ == '__main__':
    print(json.dumps(hashes() if sys.argv[1:] == ['--hashes'] else verify(), indent=2))
