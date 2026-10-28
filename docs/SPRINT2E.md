# Sprint 2E: pipeline multimodal sob demanda

O componente atual de análise Reels é o worker Python em
`operations/reels-pilot/`. Ele integra os contratos A+B de
`operations/reels-analysis-live/`, o diagnóstico/autenticação de
`operations/reels-identity/` e o writer versionado existente.
Uma execução depende de aprovação externa assinada, identidade temporária
e reserva SQLite. Merge e CI não autorizam inferência.

## Legado preservado

A main anterior era `2a6538abf9d34d556169d700fa2e0e77308c5c08`,
árvore `c1d1e4f26bd924d42b60e4f881d91e898c6384d2`.
A branch `archive/google-v0-pre-sprint2e` aponta para esse commit.
A tag anotada `legacy/google-v0-pre-sprint2e-20261028` e um bundle
com histórico completo foram verificados localmente. A publicação remota
da tag não foi possível pelo conector disponível; não se afirma proteção
contra movimentação da branch. O pin imutável é o commit/árvore.
O bundle privado possui SHA256
`409056b39673ea7c1c8e99183b3433b85e938e3443f2abee06610b2f3f9f57f6`.

Para recuperar/comparar, faça checkout do commit exato em outro clone
ou compare-o com main usando git diff. Não mova a referência histórica
para atualizar documentação ou código.

`google-v0/` é a implementação histórica: frontend Next.js,
workers Node, filas/Storage/Firestore/STT e análise anterior.
Seu código e seus testes foram mantidos nos diretórios originais.
A presença de arquivos não demonstra que um serviço externo está ativo.
Esta Sprint não migra dados nem altera serviços legados em produção.
O frontend permanece preservado, sem integração automática com os JSONs
novos. Nenhuma rota nova despacha o pipeline histórico.

`Google manual deployment` exige acionamento manual, main exata e
fingerprint; não foi acionado. Os PRs desta Sprint não concedem
autorização de deploy. CI e CD continuam separados.

## Integração das entregas anteriores

PR101 foi integrado por merge commit
`5a067a21bce5d2dc1e52d5fc745e826933c5f201`.
PR102 foi retargetado para main. Um commit de sincronização, sem mudar
sua árvore, registrou os dois pais; o diff permaneceu em oito arquivos.
CI e revisão independente precederam o merge
`3fb65f6dde3ee485c220441155ecd65822acb89a`.
O conjunto anterior possui129 testes offline.

## Autoridade e tentativa única

A autoridade antiga em `reels-analysis-live/authorization.py` permanece
DENIED. O novo caminho é explícito e usa verificação criptográfica,
sem flag de task ou variável de ambiente capaz de aprovar uma chamada.

O operador privilegiado mantém chave privada e registro de aprovação
fora do acesso do usuário operacional. O worker recebe somente chave
pública e política protegidas. O registro humano vincula a proposta
exata; a assinatura não substitui a aprovação humana.

O grant vincula fonte/SHA, manifesto e requisição, projeto, identidade,
modelo/localização, versões/hashes, raízes, prazo, orçamento bruto e
máximo de uma chamada. A política impõe seus próprios limites.

SQLite mantém a tentativa e a resposta bruta. Antes do POST, grava
duravelmente o estado de resultado incerto. Um timeout não abre outro
grant, não devolve reserva e não autoriza retry. Alterar modelo, ID,
versão ou nome não contorna a identidade SHA da fonte.
A reserva é um controle da aplicação, não um bloqueio de cobrança Google.
Ela pressupõe execução do programa revisado e não protege contra
comprometimento completo do usuário operacional ou root.

## Requisição e contrato

O transporte direto usa GenerateContent, modelo Gemini3.8Flash,
API v1beta1 para videoMetadata/mediaProcessing STATIC, uma requisição
HTTPS e nenhuma repetição, redirect ou fallback.
Parâmetros de amostragem desaconselhados pelo guia foram removidos.
A resposta estruturada do provedor é validada novamente contra o
contrato completo A+B; JSON sintaticamente válido não basta.
Taxonomia continua proposta versionada; esta Sprint não a aprova
silenciosamente. Evidências distinguem observed, author_claim,
inference e unverified.

Uma chamada reúne áudio/vídeo para A+B, sem STT/OCR externo ou
múltiplos modelos. O modelo alternativo permanece somente candidato.
O código registra versão retornada, consumo e limitações; resposta
bloqueada, incompleta ou inconsistente não vira análise aceita.

Referências oficiais consultadas em28/10/2026:
[guia3.8](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-flash),
[vídeo](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/video-understanding),
[modelo](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-8-flash).

## Persistência e recuperação

O writer preserva original e metadata. Resultados vão para
`documents/reels-analysis/REEL_ID/versions/SOURCE_SHA256/RUN_UUID/`,
com analysis.v1.json e provenance.json; o ponteiro analysis.v1.json
do Reel é atualizado pelo protocolo existente.
Falha depois da resposta usa a cópia durável local para recuperação,
sem repetir inferência. Leitura/rechecagem dos arquivos e dos hashes
precede declarar persistência concluída.
SQLite de tentativas não é um segundo catálogo do acervo.

O ensaio sintético de escrita no Windows passou como UID999/GID987:
versões, manifesto, reabertura e preservação de arquivo parcial.
Essas verificações não provam ACL contra outros usuários,
durabilidade física ou comportamento de queda de energia no Windows.
A montagem e a fonte reais precisam ser verificadas no preflight
autorizado, antes da transmissão. Não sobrescrever originais ou
versões anteriores.

## Limites antes do primeiro Reel

A autenticação real de metadados foi comprovada na Sprint2D e a sessão
foi encerrada; isso não comprova inferência do modelo.
Nesta Sprint, nenhum grant de mídia real, permissão predict ou
chamada faturável foi ativado.

O pacote privado de autorização reúne mídia exata e rechecagem de hash,
direitos/privacidade, endpoint/localização, identidade temporária,
permissões mínimas, uma chamada/concorrência1/sem retry/fallback,
orçamento e destino. Somente a aprovação desse pacote permite ativar
a execução preparada. Resultado real e qualidade A+B ainda aguardam
esse primeiro teste autorizado.

A cobertura exata do crédito não é presumida. O orçamento usa preço
bruto e uma reserva independente de promoção; alerta não é spend cap.
Global pode servir dados em outras regiões. Cache implícito pode
persistir até24h e retenção para abuso depende dos termos aplicáveis;
não se promete retenção zero.
[Governança](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/zero-data-retention),
[abuso](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/abuse-monitoring),
[preços](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing).
