# MEGA-BRAIN

Repositório para documentação e validação do fluxo Paperclip → Codex → PR → GitHub CI.

O backup MegaBrain é uma referência histórica. Seu conteúdo não comprova a existência de serviços na VPS.

## Documentação

- [Piloto Paperclip e Codex](docs/PILOT.md)
- [Regras dos agentes](AGENTS.md)
- [Fluxo com cota controlada](docs/AGENT_WORKFLOW.md)
- [Task Packets](docs/TASK_PACKETS.md)
- [Revisão por risco](docs/REVIEW_POLICY.md)
- [Referências históricas](docs/HISTORY.md)

## Validação local

Execute `python3 scripts/check_links.py` para verificar os destinos dos links locais da documentação. O GitHub Actions executa a mesma verificação em pushes e pull requests, sem chamadas a modelos.
