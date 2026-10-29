"""Tool capabilities for the user-authorized Hermes role chain."""
from pathlib import Path
TOOLS={
    'hermes-home':frozenset({'delegate_task'}),
    'reels-pilot':frozenset({'delegate_task','read_file','search_files'}),
    'developer':frozenset({'terminal','read_file','search_files','write_file','patch'}),
    'validator':frozenset({'terminal','read_file','search_files'}),
}
OFFLINE_MODELS={'central':'gpt-6-luna','reels':'gpt-6.1-sol',
    'developer':'gpt-6.1-sol','validator':'gpt-6.1-sol'}
OFFLINE_PROFILE_MODELS={'hermes-home':OFFLINE_MODELS['central'],
    'reels-pilot':OFFLINE_MODELS['reels'],'developer':OFFLINE_MODELS['developer'],
    'validator':OFFLINE_MODELS['validator']}
def allowed_tools(profile):return TOOLS.get(Path(profile).name,frozenset())
def require_role(parent_profile,child_profile):
    allowed={'hermes-home':{'reels-pilot'},'reels-pilot':{'developer','validator'}}.get(Path(parent_profile).name,set())
    if Path(child_profile).name not in allowed:raise ValueError('Delegation outside authorized role chain')
