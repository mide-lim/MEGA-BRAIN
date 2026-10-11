# MegaBrain — alinhamento após manutenção

Registro de **11/10/2026**.

## Estado do projeto

A versão atual do MegaBrain utiliza serviços Google para aplicação, processamento, banco, arquivos e fila. O ambiente de orquestração e o acesso administrativo permanecem separados da aplicação.

O repositório contém a implementação Google em `google-v0/`. O workspace de desenvolvimento foi alinhado com a versão atual do repositório. Alterações locais anteriores foram preservadas.

## Mudanças concluídas

- Remoção do sistema antigo da VPS, após preservação dos arquivos e verificação da restauração do banco.
- Preservação do ambiente de orquestração, de seu banco e do acesso administrativo.
- Separação das identidades de consulta e deploy.
- Migração dos scripts operacionais para usar impersonação completa, sem substituir a identidade configurada pela credencial direta do usuário.
- Bloqueio de procedimentos históricos de criação de infraestrutura, edição de dados e ativação de processamento até existir um fluxo específico revisado.
- Preservação do acervo histórico e dos recursos externos que ainda precisam de levantamento adicional.

A manutenção não iniciou agentes, inferências, processamento da fila ou publicação de uma nova versão da aplicação.

## Verificações realizadas

O acesso às APIs foi conferido, assim como as permissões efetivas das identidades e a disponibilidade básica da aplicação e dos serviços preservados.

A verificação das permissões de deploy não equivale a executar um deploy completo. A suíte de testes da aplicação não foi executada durante esta manutenção.

## Desenvolvimento e deploy

Git, fontes locais de release e imagens em execução ainda precisam de uma correspondência documentada. Foram encontradas diferenças entre as fontes; nenhuma versão foi sobrescrita automaticamente.

Para a próxima publicação:

1. Escolher um commit revisado e um Task Packet atual.
2. Executar testes e build pelas ferramentas convencionais e pela CI.
3. Registrar a correspondência entre commit, imagem, configuração e revisão publicada.
4. Publicar somente por uma operação específica autorizada.
5. Preservar uma recuperação da versão anterior.

A autenticação de deploy foi preparada. Deploy automático não foi configurado por esta manutenção.

## Continuidade

- Agentes de desenvolvimento não recebem credenciais administrativas.
- Não reintroduzir serviços antigos como fallback do runtime Google.
- Conservar limites de concorrência, tentativas e consumo.
- Usar CI e automações convencionais para verificações repetitivas.
- O MCP próprio não elimina a cota dos modelos da assinatura; serviços Google também podem gerar custos.
- Definir uma cópia externa protegida dos backups.
- Avaliar autenticação federada para CI/CD, sem armazenar credenciais pessoais no workflow.

## Documentação privada

O inventário detalhado, as identidades, os caminhos de credenciais, os registros de versões e os procedimentos de recuperação estão na documentação privada mantida pelo proprietário.

Não incluir esses registros, credenciais, backups ou configurações reais neste repositório público.

## Referências do projeto

- [Regras dos agentes](../AGENTS.md).
- [Task Packets](TASK_PACKETS.md).
- [Fluxo de desenvolvimento](AGENT_WORKFLOW.md).
