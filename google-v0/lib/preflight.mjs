export function assessPilot(config, {now = Date.now(), nextCostBrl = 0} = {}) {
  const reasons = [];
  const credit = config.credit ?? {};
  const budget = config.budget ?? {};
  if (config.environment !== 'google-v0') reasons.push('Ambiente deve ser google-v0.');
  if (!config.project_id || config.project_id === config.production_project_id) reasons.push('Projeto Google dedicado ainda não configurado.');
  if (credit.verified !== true) reasons.push('Cobertura dos créditos ainda não verificada.');
  const values = [credit.remaining_brl, budget.pilot_allocation_brl, budget.reserve_brl,
    budget.spent_brl, budget.reserved_brl, budget.known_other_account_spend_brl, nextCostBrl];
  const validValues = values.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  if (!validValues) reasons.push('Saldo ou estimativa de custo indisponível/inválido.');
  const expiry = Date.parse(credit.expires_at);
  const margin = budget.expiry_margin_hours;
  if (!Number.isFinite(expiry) || !Number.isFinite(margin) || margin < 0 || expiry <= now + margin * 3600000) reasons.push('Validade dos créditos ausente ou próxima do vencimento.');
  const covered = new Set(credit.covered_services ?? []);
  const missing = (config.required_services ?? []).filter(service => !covered.has(service));
  if (missing.length) reasons.push(`Serviços sem cobertura confirmada: ${missing.join(', ')}.`);
  const concurrency = config.concurrency;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) reasons.push('Concorrência deve ser um inteiro de 1 a 4.');
  if (typeof config.automatic_processing !== 'boolean') reasons.push('Controle automático inválido.');
  const remaining = validValues ? Math.min(
    credit.remaining_brl - budget.known_other_account_spend_brl,
    budget.pilot_allocation_brl - budget.spent_brl
  ) - budget.reserved_brl - budget.reserve_brl : NaN;
  if (Number.isFinite(remaining) && nextCostBrl > remaining) reasons.push('Reserva financeira insuficiente para iniciar a etapa.');
  return {ready: reasons.length === 0, uploads_enabled: config.activation?.uploads_enabled === true, paid_calls_enabled: config.activation?.paid_model_calls_enabled === true, reasons, available_brl: Number.isFinite(remaining) ? Math.max(0, remaining) : null,
    note: 'Pré-verificação local; não é um bloqueio de cobrança do Google. Armazenamento e trabalhos em andamento continuam gerando consumo.'};
}
