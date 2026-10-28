# MEGA-BRAIN

MEGABRAIN reúne o desenvolvimento de Reels, com execução nativa Codex sob demanda e validação por PR/GitHub CI.

O caminho atual de análise multimodal é o [worker Python VPS → Vertex AI](docs/SPRINT2E.md). O diretório google-v0 preserva a implementação anterior e o frontend; seus serviços externos não são alterados automaticamente pelo novo pipeline.

Inferência e mídia reais exigem autorização específica, grant externo e reserva durável. Merge não autoriza deploy.

O backup MegaBrain é uma referência histórica. Seu conteúdo não comprova a existência de serviços na VPS.

## Documentação

- [Pipeline atual, legado e operação Sprint 2E](docs/SPRINT2E.md)
- [Contratos A+B e validação offline](docs/reels-analysis/README.md)
- [Diagnóstico de identidade e contrato de autorização](docs/reels-identity/README.md)

- [Piloto Paperclip e Codex](docs/PILOT.md)
- [Regras dos agentes](AGENTS.md)
- [Fluxo com cota controlada](docs/AGENT_WORKFLOW.md)
- [Task Packets](docs/TASK_PACKETS.md)
- [Revisão por risco](docs/REVIEW_POLICY.md)
- [Referências históricas](docs/HISTORY.md)
- [Alinhamento após manutenção — 11/10/2026](docs/MAINTENANCE-2026-10-11.md)

## Validação local

Execute `python3 scripts/check_links.py` para verificar os destinos dos links locais da documentação. O GitHub Actions executa a mesma verificação em pushes e pull requests, sem chamadas a modelos.
