# Perfil compacto para Worker delimitado

Estado: candidato; não habilitado por padrão. Risco alto por afetar instruções operacionais e a inicialização do adaptador. Exige CI, revisão independente e aprovação humana conforme [política](../../../docs/REVIEW_POLICY.md).

## Decisão

A skill upstream permanece em `/app/skills/paperclip`. Uma cópia compacta, versionada e somente leitura na imagem candidata pode ser selecionada para uma tarefa comum e delimitada. Não é uma substituição equivalente para todos os modos do Paperclip. Rotinas, contratação, gestão, delegação, chat externo e esquemas especializados de segredos exigem suporte próprio; o perfil manda parar quando faltar esse suporte. As regras centrais sempre ficam no `SKILL.md`; referências detalhadas são carregadas pela necessidade da tarefa.

## Seleção e compatibilidade

O operador configura `adapterConfig.paperclipSkillProfile` com `bounded-worker-v1`. É permitido apenas em `codex_local`, `command=/usr/local/bin/codex-pilot`, `engine=cli`, execução local e sem override de connector skill digest. Configuração ausente ou `upstream` conserva a seleção original. Não basta mudar uma variável do processo ou uma instrução no prompt. Outros agentes permanecem no comportamento upstream.

Antes da seleção, a identidade e a origem da skill operacional devem ser únicas e corresponder ao upstream fixado. O hash do `SKILL.md` original precisa corresponder à versão aprovada. O manifesto verifica o conjunto exato dos seis arquivos compactos e seus hashes. Symlinks no pacote são recusados. Depois do injetor upstream, o adaptador confere o link no `CODEX_HOME/skills/paperclip` antes de iniciar o CLI. Uma montagem ausente, customizada ou divergente interrompe o run; não inicia um modelo com instruções incertas.

O teste da montagem exerce o injetor real; o teste completo do servidor usa CLI falso e banco descartável. Nenhum deles mede comportamento de modelo. Integridade de arquivo e instruções de segurança não são isolamento contra um agente malicioso com permissão de escrita no próprio home. As permissões do launcher e a autorização por execução continuam necessárias.

## Validação e medida

- Testes de seleção padrão/opt-in e rejeição de combinações incompatíveis.
- Hash original divergente, arquivos compactos alterados/ausentes/extras e symlinks recusados.
- Troca original → compacto → original com o injetor upstream real.
- Servidor isolado: perfil realmente montado antes do CLI falso, autenticação MCP preservada, uma tentativa e nenhum sucessor automático.
- Core compacto: cerca de 5,8 mil caracteres contra 60,3 mil no original. Isso é tamanho do texto disponível; o consumo total de tokens/cota não foi medido. Ler referências aumenta o contexto.

## Instalação, ativação e rollback

1. Revisar o commit final, seus testes e as instruções em cada referência; registrar decisão independente.
2. Obter aprovação humana e merge. Conferir CI do commit em `main` e a imagem imutável resultante.
3. Instalar por procedimento privado com backup, sem ativar agentes. A instalação da imagem não seleciona o perfil automaticamente.
4. Habilitar o flag somente no Worker elegível e autorizar uma única tarefa pequena, com packet e orçamento. Comparar arquivos de contexto, resultado e uso informado pelo runtime. Não iniciar piloto sem autorização própria.
5. Para rollback da seleção, remover o flag ou usar `upstream`; a próxima montagem usa a origem upstream. Para falha da imagem, aplicar o procedimento privado de rollback para a imagem anterior. Não reiniciar tarefas nem autorizar uma tentativa por conta própria.

## CocoIndex Code: próxima etapa separada

Após validar este perfil, avaliar um piloto de busca em código com embeddings locais. Usar somente uma cópia do código público permitida explicitamente; excluir credenciais, dados de produção, backups e documentação privada. Medir tempo de indexação, CPU/memória e recuperação em perguntas fixas, comparando uma busca convencional. Não indexar regras obrigatórias para substituí-las por recuperação semântica. Não mudar banco, infraestrutura de produção ou categorização neste PR. Não afirmar economia de cota sem uma medida de tarefas equivalentes.

[Origem e operação](../README.md)
