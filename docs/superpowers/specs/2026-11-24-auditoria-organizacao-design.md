# Auditoria — correção e compactação (opção A)

Escolha do dono (2026-11-24): opção A. Status: **proposta (aguardando aprovação)**.

## Problema (medido no browser, não estimado)

1. **Bug de API do Carbon** em `apps/web/src/components/AuditPanel.tsx`. O código usa
   `<TableHeader>` como se fosse o `<thead>` e `<TableHead>` como célula, mas é o
   contrário: `TableHead` = `<thead>`, `TableHeader` = `<th>`. DOM real capturado:
   ```html
   <th scope="col"><div class="cds--table-header-label">
     <tr><thead>Hora</thead><thead>Evento</thead>…<thead>Duração</thead></tr>
   </div></th>
   ```
   Efeito: os 6 títulos empilham num quadrado no canto superior esquerdo e o
   cabeçalho fica desalinhado do corpo ("Hora / Evento / Nó / Resumo / Status em
   cima um do outro"). São **5 tabelas** (Todos, Decisões, Execuções, Plano,
   Latência) com **5 `<TableHeader>` e 36 `<TableHead>`** invertidos.
   `AuditPanel.tsx` é o **único** arquivo do `apps/web` que usa `Table`.

2. **Espaço desperdiçado / inconsistência.**
   - Cada aba carrega uma `TableToolbar` de 48px com **só a lupa** à direita.
   - O filtro de busca existe em **3 das 8 abas** (Todos/Decisões/Execuções);
     Gates, RAG, Plano, Validação e Latência não têm filtro.
   - Gates e Validação usam `StructuredList` enquanto as demais usam `Table` —
     duas linguagens visuais em abas irmãs.

## Decisão

Opção **A — correção + compactação**. Descartadas: **B** (unificar tudo em `Table`
e densidade) mexe em mais código sem ganho visível imediato; **C** (reagrupar as
abas) cria 2 níveis de navegação e risco de regressão.

## Desenho

1. **Corrigir as tags**: trocar `<TableHeader>` ↔ `<TableHead>` nas 5 tabelas do
   `AuditPanel` (`TableHeader` = `<thead>`, `TableHead` = célula `<th>`). As duas
   visões em `StructuredList` (Gates, Validação) já renderizam certo e ficam.
2. **Busca única na faixa das abas**: remover as 3 `TableToolbar`; colocar **um**
   campo de busca alinhado à direita, na mesma linha das 8 sub-abas. O `filter`
   passa a valer em **todas** as abas. Some a faixa de 48px quase vazia.
3. **Preservar a ponte conversa→Auditoria**: manter `id="audit-filter-decisions"`
   no campo único, porque o `LogsPanel` injeta o `nodeId` por DOM nesse id
   (efeito `auditFocus`). A ponte continua funcionando sem tocar no `LogsPanel`.
4. **Larguras de coluna** sensatas por tabela (`<Table size="sm">` preservado);
   coluna de expandir das Execuções mantém `2.5rem`.
5. **Cabeçalho sticky** dentro da área rolável da aba (barato; autorizado pelo
   dono ao escolher A).

## Não-objetivos
- Não mudar motor/host/SSE nem o formato dos eventos de auditoria.
- Não re-estilizar Logs nem Terminal (dono: "estão perfeitas").
- Não criar nó, campo ou dado novo.

## Anti-objetivos (o que faria falhar)
- Quebrar a ponte de foco da conversa para a Auditoria (`auditFocus`).
- Esconder contagem de abas ou colunas que o dono reconhece na captura.

## Restrições
- Carbon primeiro; tokens oficiais; sem `!important`/inline style novos.
- Preservar `.logs-panel-*`, a aba expandida (72vh) e o recolher/expandir.

## Verificação
- `tsc --noEmit` e `vite build` verdes.
- Playwright:
  - caso novo que assere o DOM — `table > thead > tr > th` na ordem dos títulos
    e **nenhum** `<thead>` dentro de `<th>`, em cada aba de tabela;
  - busca visível em todas as abas e filtrando (ex.: digitar `exec` e ver só as
    linhas correspondentes);
  - `audit-panel.spec.ts` existente verde; `ui-smoke.spec.ts` verde em porta
    isolada.
- Screenshot antes/depois da aba Auditoria (evidência).

## O que fica para o implementador (eu)
- O mecanismo exato de posicionar a busca na faixa das abas (a `Tabs` do Carbon
  não tem slot de "trailing"; resolvo com contêiner relativo + busca à direita,
  garantindo que as 8 abas não colidam).
- Ajuste fino de larguras por coluna.
