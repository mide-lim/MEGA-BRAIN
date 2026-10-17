# Curadoria até o acervo e curadoria do acervo

Filas mostra estados, busca, resultados e diagnósticos das três etapas existentes. Cadastros prontos, falhas confirmadas, resultados incertos e publicações históricas permanecem distintos. Contagens por etapa/operação não são taxas do acervo histórico.

Categorias organiza publicações salvas por contexto, elementos e evidências. Biblioteca cruza facetas sobre os mesmos IDs e preserva navegação. A materialização contextual é somente leitura, com cache limitado e origem moderna/legada; não envia conteúdo a provedores, não reanalisa legado nem cria categorias ao visitar.

GET /api/reels/quality fornece diagnóstico paginado sanitizado; GET /api/reels/contextual fornece elementos, recorrências e cobertura; GET /api/reels/contextual/:id mostra as provas daquele publicado. GET /api/reels/items?workspace=library aceita facets como array JSON limitado a oito predicados, antes da paginação. Array vazio preserva o acervo completo. Menção, prova inválida, desconhecido e não aplicável não viram suporte automático.

O contrato contextual v2 é opcional na mesma chamada final futura. O gate v2 e a persistência candidato→recibo→publicação exigem ativação explícita; o caminho atual conserva defaults. Recibo do servidor vincula publicação, fontes e conteúdo. Um campo do modelo não se autocertifica como revisão visual ou semântica. Revisão de um trecho não certifica papel central, contexto, atributo ou unidade completa: proposições v2 permanecem não verificadas até uma política independente específica. Na projeção histórica, cruzar elementos na mesma unidade exige que a mesma prova sustente o elemento e seu vínculo à preparação. Nenhum novo Reel, repetição paga, fila, IAM ou worker deve ser ativado por esta entrega web.

Validação: testes de módulos, fronteiras API/paginação, empacotamento e jornadas browser com API real/sintéticos exclusivamente no GitHub Actions. Publicação revisada somente web, com conferência autenticada dos dados existentes e preservação de workers/filas/49 incertos.
