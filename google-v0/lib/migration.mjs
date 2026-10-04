const shortcode = /^[A-Za-z0-9_-]{5,32}$/;
export function planMigration(records, {limit = 20} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Amostra deve conter de 1 a 100 itens.');
  const seen = new Set();
  const result = [];
  for (const record of records) {
    if (!shortcode.test(record.id ?? '') || seen.has(record.id)) throw new Error('Identificador inválido ou duplicado.');
    seen.add(record.id);
    const expected = `original/instagram/reels/${record.id}/video.mp4`;
    if (record.video_key && record.video_key !== expected) throw new Error('Objeto de origem fora do escopo permitido.');
    if (result.length >= limit) continue;
    result.push({id: record.id, source_status: record.status,
      media_action: record.video_key ? 'copy_and_verify' : 'defer_download',
      source_key: record.video_key ?? null,
      destination_key: record.video_key ? `originals/instagram/${record.id}/video.mp4` : null,
      transcript_action: typeof record.transcript === 'string' && record.transcript.trim() ? 'reuse_immutable' : 'inspect_before_stt',
      analysis_action: record.analysis ? 'preserve_legacy_and_create_versioned_analysis' : 'create_versioned_analysis',
      verify_audio: true, delete_source: false,
      checksum_required: Boolean(record.video_key),
      retry_uncertain_paid_request: false});
  }
  return {mode: 'dry-run', items: result, source_deletions: 0, paid_calls: 0};
}
