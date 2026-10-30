---
name: diagramas-svg-na-documentacao
description: Como criar ou ajustar diagramas SVG em docs/images, renderizar no macOS com qlmanage para conferir visualmente (sem rsvg/magick) e inserir nos dois READMEs (EN e pt-BR).
version: 1
uses: 0
created: 2026-10-19
updated: 2026-10-19
lastUsed: 2026-10-19
refs: docs/images, README.md, README.pt-BR.md
status: trial
origin: auto
wins: 0
losses: 0
---
## Quando usar
Ao adicionar ou alterar um diagrama explicativo na documentação do Brito (arquitetura, fluxos, comparações), por exemplo para copiar o estilo visual de outro projeto.

## Passos
1. Se houver referência externa, baixe as imagens com curl para uma pasta nova em /tmp e abra com Read (veja a skill ver-imagens-de-paginas-web). Anote o que funciona: cores por papel, caixa com o nome do arquivo real e de quando dispara, laço de retorno, comparação (a) vs (b) com legenda.
2. Confira o que já existe: `ls docs/images` e `grep -n '!\[\|^## \|mermaid' README.md README.pt-BR.md`. Use `ls src/*` para tirar nomes reais de módulos e arquivos para as caixas.
3. Escreva o SVG à mão em `docs/images/<nome>.svg`, com `viewBox` largo (~1200 de largura) e fonte de sistema (`-apple-system,Segoe UI,Helvetica,Arial,sans-serif`).
4. Renderize para conferir. Na máquina não há rsvg-convert nem ImageMagick, então use o QuickLook, passando o caminho absoluto do SVG:
   `mkdir -p /tmp/svgout && cd /tmp/svgout && rm -f *.png && qlmanage -t -s 1600 -o . <caminho-absoluto>/docs/images/<nome>.svg >/dev/null 2>&1`
   Depois abra `/tmp/svgout/<nome>.svg.png` com Read.
5. Corrija sobreposições e cortes (pílulas que transbordam, rótulos de setas em cima de outros, texto cortado na borda) com Edit e **renderize de novo depois de cada ajuste**.
6. Insira a imagem no **README.md e no README.pt-BR.md**, com alt e legenda traduzidos, na seção equivalente dos dois (ex.: "How it works" / "Como funciona"). Mantenha os dois READMEs sincronizados.
7. Rode `git status --short` para confirmar que os SVGs novos aparecem como não rastreados e não estão ignorados (`git check-ignore -v docs/images/*.svg`).

## Armadilhas
- O `sed -i` do macOS exige `sed -i '' ...`. Sem isso dá o erro "extra characters at the end of d command". Prefira a ferramenta Edit para trocar trechos do SVG.
- O qlmanage grava `<nome>.svg.png` no diretório de saída, e o cwd do shell volta para a raiz do repositório entre chamadas. Use caminhos absolutos ou um `cd` explícito.
- Não entregue um SVG sem renderizar a versão final. Rótulos sobrepostos só aparecem na imagem renderizada.

## Verificação
- Abra com Read o PNG renderizado da versão final de cada SVG e confira que não há texto sobreposto ou cortado.
- Confira com `git diff --stat` que os dois READMEs ganharam as mesmas inserções.
