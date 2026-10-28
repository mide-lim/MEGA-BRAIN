"""Installed external authority. CURRENT STATE: no live authority, zero budget."""
POLICY_REVISION = "Sprint2B-preparation/revision11"
LIVE_EXECUTION_ENABLED = False
CURRENT_AUTHORIZED_GROSS_USD = 0
CURRENT_AUTHORIZED_INFERENCE_CALLS = 0

class AuthorizationDenied(PermissionError):
    pass

def require_live_grant(task):
    # No task flag, CLI argument, environment variable or imported JSON can issue a grant.
    # A future separately reviewed change must integrate an external, scoped human grant.
    raise AuthorizationDenied("real inference/media transmission/spending not authorized; installed authority denied")

def current_status():
    return {"policy_revision": POLICY_REVISION, "live_enabled": False,
            "gross_budget_usd": 0, "inference_calls": 0,
            "grant_issuer": "none", "task_json_cannot_authorize": True}

def verify_live_grant(grant, task):
    raise AuthorizationDenied("installed policy cannot validate a live grant in this release")
