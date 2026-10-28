"""Strict JSON and local contracts, independent from immutable 2A module."""
import json
import math
import hashlib
from pathlib import Path
from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parent

class ContractError(ValueError):
    pass

def ensure_finite(value):
    if isinstance(value, float) and not math.isfinite(value):
        raise ContractError("non-finite JSON number")
    if isinstance(value, dict):
        for item in value.values():
            ensure_finite(item)
    elif isinstance(value, list):
        for item in value:
            ensure_finite(item)

def parse_json(data):
    def reject(value):
        raise ContractError("non-standard JSON constant: " + value)
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ContractError("duplicate JSON key: " + key)
            result[key] = value
        return result
    value = json.loads(data, parse_constant=reject, object_pairs_hook=pairs)
    ensure_finite(value)
    return value

def canonical(value):
    ensure_finite(value)
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode()

def sha(data):
    return hashlib.sha256(data).hexdigest()

def validate(name, value):
    ensure_finite(value)
    schema = parse_json((ROOT / "contracts" / name).read_bytes())
    errors = sorted(Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(value),
                    key=lambda e: str(list(e.path)))
    if errors:
        raise ContractError(f"{name} {list(errors[0].path)}: {errors[0].message}")
