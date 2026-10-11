# Alinhamento de fontes e imagens

## Resultado da comparação

A comparação detalhada corrigiu o levantamento inicial: as diferenças de código entre Git e a release local eram apenas quebras de linha. Uma diferença efetiva permaneceu na documentação e foi recuperada.

Os arquivos de código examinados na imagem do worker correspondem ao Git após normalização de quebras de linha. A aplicação web está compilada, e esse método não comprova a correspondência integral de suas fontes. Os detalhes e os identificadores da produção ficam no registro privado.

As imagens existentes não registram o commit. Elas não foram substituídas nesta etapa.

## Proposta de build

- Quebras de linha LF para os arquivos textuais da implementação Google.
- Contexto criado somente a partir dos arquivos rastreados no commit, sem arquivos locais extras ou credenciais.
- Manifesto com commit e hashes das fontes; texto UTF-8 normalizado para LF.
- Commit declarado em label OCI e manifesto incorporado à imagem.
- Build rejeita divergência entre o commit declarado e o manifesto.
- CI compila a aplicação web uma vez, constrói as imagens e verifica os artefatos produzidos.
- Smoke do worker usa mídia sintética, sem rede.
- Verificações anônimas da aplicação web usam a imagem compilada, sem credenciais Google.
- Artefatos pequenos de proveniência são guardados por sete dias; imagens inteiras não são armazenadas como artefatos da CI.

## Preparação local de um candidato

Na raiz do repositório, use Python 3.12 ou superior:

```sh
python3 ops/prepare-release-context.py --output /tmp/megabrain-candidate
commit="$(git rev-parse HEAD)"
docker build --build-arg VCS_REF="$commit" -t megabrain-web:candidate -f /tmp/megabrain-candidate/Dockerfile.web-google /tmp/megabrain-candidate
docker build --build-arg VCS_REF="$commit" -t megabrain-worker:candidate -f /tmp/megabrain-candidate/Dockerfile.worker /tmp/megabrain-candidate
```

O diretório de saída deve estar ausente ou vazio. O gerador exporta o commit, não as alterações locais ainda não commitadas. O manifesto gerado não deve ser commitado.

## Limites

Este fluxo produz e verifica candidatos. Não faz login no Google, push de imagens, deploy, alteração de configuração ou ativação de processamento.

Um ID de configuração local Docker não é o digest publicado no registry. O deploy futuro deve registrar o digest obtido após o push, as versões de configuração e a revisão publicada, vinculados ao mesmo commit.

Labels e manifestos tornam a origem verificável no fluxo de CI, mas não equivalem a uma atestação criptográfica independente. Atualização manual de configuração ou ambiente pode alterar comportamento sem alterar a imagem.

A autenticação federada de CI/CD, a operação de deploy com acionamento manual e a execução de uma tarefa pelo Paperclip continuam sendo etapas posteriores. Os dados operacionais e os procedimentos de recuperação permanecem privados.
