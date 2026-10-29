"""Content checks, administrative gates and non-authoritative pt-BR views.

Never repair model quality or upgrade epistemic claims to verified facts.
"""
import copy
import math
import re
import sys
from pathlib import Path

LIVE = Path(__file__).resolve().parents[1] / "reels-analysis-live"
if str(LIVE) not in sys.path:
    sys.path.insert(0, str(LIVE))
from common import ContractError, canonical, sha, validate


def validate_content(payload, duration):
    """Validate the unchanged schema and semantics, excluding taxonomy policy."""
    validate("model-payload.v1.schema.json", payload)
    if duration is not None and (type(duration) not in (int, float) or
                                 not math.isfinite(duration) or duration < 0):
        raise ContractError("invalid duration")
    quality = payload["quality"]
    if quality["review_required"] and not quality["review_reasons"]:
        raise ContractError("review_required requires review reasons")
    if payload["A"]["primary_category"] == "other_uncertain" and (
            not quality["review_required"] or not quality["review_reasons"]):
        raise ContractError("other_uncertain requires reason and review")
    evidence = payload["B"]["evidence"]
    ids = [item["evidence_id"] for item in evidence]
    if len(ids) != len(set(ids)) or any(not value.strip() for value in ids):
        raise ContractError("invalid or duplicate evidence ID")
    for item in evidence:
        stamp = item.get("timestamp")
        if stamp is not None:
            start, end = stamp["start_seconds"], stamp["end_seconds"]
            for value in (start, end):
                if value is not None and (not math.isfinite(value) or value < 0 or
                                          (duration is not None and value > duration)):
                    raise ContractError("timestamp outside duration")
            if start is not None and end is not None and start > end:
                raise ContractError("timestamp start exceeds end")
    refs = list(payload["A"]["entities"])
    for key in ("insights", "audio", "visual", "screen_text", "connections"):
        refs.extend(payload["B"][key])
    for item in refs:
        if not item["evidence_ids"] or not set(item["evidence_ids"]).issubset(ids):
            raise ContractError("claim/entity requires known evidence IDs")


def evaluate(payload, duration=None):
    validate_content(payload, duration)
    return {"governance_version": "governance.v1", "state": "NEEDS_REVIEW",
            "taxonomy_status": "draft", "human_review_mandatory": True,
            "indexing_allowed": False, "publishing_allowed": False,
            "epistemic_claims_verified": False,
            "model_quality": copy.deepcopy(payload["quality"])}


def _human_fields(payload):
    fields = {}
    def add(pointer, text, ids=()):
        fields[pointer] = {"source_text": text, "text": text, "evidence_ids": list(ids)}
    for key in ("summary", "category_reason"):
        add("/A/" + key, payload["A"][key])
    for key in ("topics", "keywords"):
        for i, text in enumerate(payload["A"][key]):
            add(f"/A/{key}/{i}", text)
    for key in ("insights", "visual", "connections", "audio"):
        for i, item in enumerate(payload["B"][key]):
            # Observed audio is a verbatim quotation, not translatable narrative.
            if key != "audio" or item["epistemic_status"] != "observed":
                add(f"/B/{key}/{i}/text", item["text"], item["evidence_ids"])
    for i, item in enumerate(payload["B"]["evidence"]):
        add(f"/B/evidence/{i}/description", item["description"], [item["evidence_id"]])
    for key in ("uncertainties", "review_reasons", "limitations"):
        for i, text in enumerate(payload["quality"][key]):
            add(f"/quality/{key}/{i}", text)
    return fields


def build_presentation(payload, source_sha256, translations=None):
    """Pointer-only view: source is the canonical original model payload hash.

    Locale is a presentation target, not a language-detection claim. Untranslated
    narrative always requires review (including Portuguese not independently
    checked). No lookup or inferred translation is performed.
    """
    validate_content(payload, None)
    if not isinstance(source_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", source_sha256):
        raise ContractError("presentation source hash")
    if source_sha256 != sha(canonical(payload)):
        raise ContractError("presentation source differs from original model payload")
    fields = _human_fields(payload)
    if translations is None:
        translations = {}
    if not isinstance(translations, dict):
        raise ContractError("translations must be a pointer mapping")
    names = {entity["name"] for entity in payload["A"]["entities"]}
    for pointer, text in translations.items():
        if pointer not in fields or not isinstance(text, str) or not text.strip():
            raise ContractError("invalid translation pointer/type or protected field")
        source = fields[pointer]["source_text"]
        if any(name in source and name not in text for name in names):
            raise ContractError("translation must preserve entity names")
        fields[pointer]["text"] = text
    return {"presentation_version": "presentation.v1", "locale": "pt-BR",
            "source_sha256": source_sha256, "source_kind": "canonical_model_payload",
            "fields": fields, "presentation_review_required": True,
            "language_status": "unverified", "translated_pointers": sorted(translations)}
