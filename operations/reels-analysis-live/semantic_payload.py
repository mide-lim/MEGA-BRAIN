from common import ContractError, validate

def validate_payload(payload, duration):
    validate("model-payload.v1.schema.json", payload)
    quality = payload["quality"]
    if payload["A"]["primary_category"] == "other_uncertain":
        if not quality["review_required"] or not quality["review_reasons"]:
            raise ContractError("other_uncertain requires reason and review")
    if quality["review_required"] and not quality["review_reasons"]:
        raise ContractError("review_required requires review reasons")
    ev = payload["B"]["evidence"]
    ids = [e["evidence_id"] for e in ev]
    if len(ids) != len(set(ids)):
        raise ContractError("duplicate evidence ID")
    for item in ev:
        stamp = item.get("timestamp")
        if stamp is not None:
            start, end = stamp["start_seconds"], stamp["end_seconds"]
            if start is not None and end is not None and start > end:
                raise ContractError("timestamp start exceeds end")
            if duration is not None and any(v is not None and v > duration for v in (start, end)):
                raise ContractError("timestamp exceeds duration")
    refs = list(payload["A"]["entities"])
    for key in ("insights", "audio", "visual", "screen_text", "connections"):
        refs.extend(payload["B"][key])
    for item in refs:
        if not item["evidence_ids"] or not set(item["evidence_ids"]).issubset(ids):
            raise ContractError("claim/entity requires known evidence IDs")
    # Taxonomy is unapproved; all results remain reviewable in this release.
    if not quality["review_required"]:
        raise ContractError("draft taxonomy requires review")
