# Publicação fechada — PR61

Continuação humana autoriza integrar o PR e publicar a web e os três workers por etapa com processamento desligado. O publicador `web_stages` mantém o worker legado e as quatro filas intactos, com comparação da configuração completa dos cinco serviços e das quatro filas, sem dados de Reels, IAM ou exclusões.

A implantação altera somente imagem e a variável protegida `MEGABRAIN_REELS_CLOSED_RELEASE=v2` nos quatro alvos. Essa variável força seleção v2 e processamento booleano false antes de escolher runtime/adaptadores; valor inválido falha fechado. Ela também bloqueia escrita dos controles legados e o importador legado da web. Cadastro novo de Reels continua separado de admissão. O ambiente não consegue habilitar processamento; sua remoção futura é uma operação de ativação explicitamente revisada.

O modo review valida o payload exato sem persistir serviços. O deploy publica duas imagens e atualiza aquisição, transcrição, análise e web, nessa ordem. Mantém argumentos, secrets/versionamentos, escala, identidade e tráfego. Baseline inclui o legado mesmo sem PATCH. Falhas de rede não repetem PATCH; rollback só restaura o próprio payload quando a configuração atual corresponde exatamente ao que foi enviado, recusando concorrência ou reconciliação incerta.

Filas vazias podem permanecer em seu estado atual: legado pausado e etapas abertas. A trava de processamento está nos serviços; nenhuma pausa, retomada, purge ou alteração de retry é aplicada. A preparação do piloto pode exigir mudanças futuras em uma autorização própria.

Builds, suites, navegador e smokes de imagens ocorrem somente no GitHub Actions, sem provedores ou dados privados. O aceite real consulta a web e confere versão/trava dos workers sem fornecer execução válida. Piloto permanece não executado; ocupações antigas, permissões efetivas, política de reentrega e amostra retida não são liberadas por esta publicação.
