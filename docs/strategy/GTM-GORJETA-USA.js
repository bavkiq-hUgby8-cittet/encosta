const fs = require("fs");
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
        Header, Footer, AlignmentType, LevelFormat, HeadingLevel,
        BorderStyle, WidthType, ShadingType, PageNumber, PageBreak } = require("docx");

const W = 12240, H = 15840, M = 1440;
const CW = W - M*2; // 9360

const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const borders = { top: border, bottom: border, left: border, right: border };
const noBorder = { style: BorderStyle.NONE, size: 0 };
const noBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };
const cellM = { top: 80, bottom: 80, left: 120, right: 120 };

function h1(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 360, after: 200 },
    children: [new TextRun({ text, bold: true, size: 32, font: "Arial", color: "1a1a2e" })] });
}
function h2(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 280, after: 160 },
    children: [new TextRun({ text, bold: true, size: 26, font: "Arial", color: "2d2d4e" })] });
}
function h3(text) {
  return new Paragraph({ spacing: { before: 200, after: 120 },
    children: [new TextRun({ text, bold: true, size: 22, font: "Arial", color: "ff6b35" })] });
}
function p(text, opts = {}) {
  return new Paragraph({ spacing: { after: 160 }, alignment: opts.center ? AlignmentType.CENTER : AlignmentType.LEFT,
    children: [new TextRun({ text, size: 22, font: "Arial", color: opts.color || "333333", bold: !!opts.bold, italics: !!opts.italic })] });
}
function pRuns(runs) {
  return new Paragraph({ spacing: { after: 160 },
    children: runs.map(r => new TextRun({ text: r.text, size: 22, font: "Arial", color: r.color || "333333", bold: !!r.bold, italics: !!r.italic })) });
}

function cell(text, opts = {}) {
  return new TableCell({
    borders: opts.noBorders ? noBorders : borders,
    width: { size: opts.w || 4680, type: WidthType.DXA },
    shading: opts.bg ? { fill: opts.bg, type: ShadingType.CLEAR } : undefined,
    margins: cellM,
    verticalAlign: "center",
    children: [new Paragraph({ alignment: opts.center ? AlignmentType.CENTER : AlignmentType.LEFT,
      children: [new TextRun({ text: String(text), size: opts.size || 20, font: "Arial", color: opts.color || "333333", bold: !!opts.bold })] })]
  });
}

const doc = new Document({
  styles: {
    default: { document: { run: { font: "Arial", size: 22 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 32, bold: true, font: "Arial" },
        paragraph: { spacing: { before: 360, after: 200 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 26, bold: true, font: "Arial" },
        paragraph: { spacing: { before: 280, after: 160 }, outlineLevel: 1 } },
    ]
  },
  numbering: {
    config: [
      { reference: "bullets",
        levels: [{ level: 0, format: LevelFormat.BULLET, text: "\u2022", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      { reference: "numbers",
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
    ]
  },
  sections: [{
    properties: {
      page: { size: { width: W, height: H }, margin: { top: M, right: M, bottom: M, left: M } }
    },
    headers: {
      default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT,
        children: [new TextRun({ text: "Touch? | Go-to-Market USA | Confidencial", size: 16, font: "Arial", color: "999999", italics: true })] })] })
    },
    footers: {
      default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: "encosta.app | ", size: 16, font: "Arial", color: "999999" }),
          new TextRun({ children: [PageNumber.CURRENT], size: 16, font: "Arial", color: "999999" })] })] })
    },
    children: [
      // ===== COVER =====
      new Paragraph({ spacing: { before: 3000 }, alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: "Touch?", size: 72, bold: true, font: "Arial", color: "ff6b35" })] }),
      new Paragraph({ spacing: { after: 200 }, alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: "tudo nasce no gesto", size: 28, font: "Arial", color: "666666", italics: true })] }),
      new Paragraph({ spacing: { before: 600, after: 100 }, alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: "GO-TO-MARKET STRATEGY", size: 40, bold: true, font: "Arial", color: "1a1a2e" })] }),
      new Paragraph({ spacing: { after: 100 }, alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: "Gorjeta Digital nos EUA", size: 30, font: "Arial", color: "2d2d4e" })] }),
      new Paragraph({ spacing: { after: 400 }, alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: "Lancamento via Trafego Pago em Redes Sociais", size: 24, font: "Arial", color: "666666" })] }),
      new Paragraph({ spacing: { before: 1200 }, alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: "Marco 2026 | Versao 1.0", size: 20, font: "Arial", color: "999999" })] }),

      new Paragraph({ children: [new PageBreak()] }),

      // ===== 1. MERCADO =====
      h1("1. O Mercado de Gorjetas nos EUA"),
      p("Os Estados Unidos possuem a maior cultura de gorjeta do mundo. Dar tip nao e opcional, e parte do contrato social. Isso cria um mercado massivo e recorrente que esta em plena transicao do cash para o digital."),

      h2("1.1 Numeros-Chave"),
      new Table({
        width: { size: CW, type: WidthType.DXA },
        columnWidths: [4680, 4680],
        rows: [
          new TableRow({ children: [
            cell("Metrica", { bold: true, bg: "1a1a2e", color: "ffffff", w: 4680 }),
            cell("Valor", { bold: true, bg: "1a1a2e", color: "ffffff", w: 4680, center: true }),
          ]}),
          new TableRow({ children: [
            cell("Gorjetas anuais so em restaurantes", { w: 4680 }),
            cell("US$ 47 bilhoes/ano", { w: 4680, bold: true, center: true }),
          ]}),
          new TableRow({ children: [
            cell("Gorjetas totais na economia (todos setores)", { w: 4680 }),
            cell("US$ 50+ bilhoes/ano", { w: 4680, bold: true, center: true }),
          ]}),
          new TableRow({ children: [
            cell("Tips como % do salario em restaurantes", { w: 4680 }),
            cell("23% da remuneracao total", { w: 4680, center: true }),
          ]}),
          new TableRow({ children: [
            cell("Gorjeta media em full-service restaurant", { w: 4680 }),
            cell("19.4% (Q1 2025)", { w: 4680, center: true }),
          ]}),
          new TableRow({ children: [
            cell("Tips dados em cash (2025)", { w: 4680 }),
            cell("Apenas 15% (era 30% em 2020)", { w: 4680, center: true }),
          ]}),
          new TableRow({ children: [
            cell("Restaurantes com sistema digital de tip", { w: 4680 }),
            cell("74% (era 10% ha 10 anos)", { w: 4680, center: true }),
          ]}),
          new TableRow({ children: [
            cell("Aumento de ganho com tip digital vs cash-only", { w: 4680 }),
            cell("+23% no salario do trabalhador", { w: 4680, bold: true, center: true, color: "22883e" }),
          ]}),
        ]
      }),

      new Paragraph({ spacing: { after: 160 } }),
      p("Ponto critico: 85% das gorjetas ja sao digitais. O cash esta morrendo. Quem nao tem solucao digital perde gorjeta. E e ai que o Touch? entra."),

      h2("1.2 O Problema Real"),
      pRuns([
        { text: "Tipping fatigue: ", bold: true },
        { text: "65% dos consumidores se sentem cansados de pedidos constantes de gorjeta. 89% acham que a cultura de tip esta fora de controle. As telas de POS (aquele iPad virado pra voce com 18%, 20%, 25%) criam pressao social negativa." }
      ]),
      p("O Touch? resolve isso de forma elegante: a gorjeta acontece por um gesto fisico natural (encostar o celular), nao por uma tela constrangedora. E rapido, e pessoal, e nao tem aquele momento desconfortavel de escolher porcentagem na frente do atendente."),

      h2("1.3 Segmentos de Maior Potencial"),
      new Table({
        width: { size: CW, type: WidthType.DXA },
        columnWidths: [2200, 2200, 2200, 2760],
        rows: [
          new TableRow({ children: [
            cell("Segmento", { bold: true, bg: "1a1a2e", color: "ffffff", w: 2200 }),
            cell("Volume", { bold: true, bg: "1a1a2e", color: "ffffff", w: 2200, center: true }),
            cell("Tip Medio", { bold: true, bg: "1a1a2e", color: "ffffff", w: 2200, center: true }),
            cell("Oportunidade Touch?", { bold: true, bg: "1a1a2e", color: "ffffff", w: 2760, center: true }),
          ]}),
          new TableRow({ children: [
            cell("Restaurantes", { w: 2200 }),
            cell("1M+ estab.", { w: 2200, center: true }),
            cell("19.4%", { w: 2200, center: true }),
            cell("Garcom, bartender, delivery", { w: 2760 }),
          ]}),
          new TableRow({ children: [
            cell("Hoteis", { w: 2200 }),
            cell("55K+ hoteis", { w: 2200, center: true }),
            cell("$5-20/dia", { w: 2200, center: true }),
            cell("Housekeeping, valet, bellboy", { w: 2760 }),
          ]}),
          new TableRow({ children: [
            cell("Saloes/Barbearias", { w: 2200 }),
            cell("1.2M+ estab.", { w: 2200, center: true }),
            cell("15-25%", { w: 2200, center: true }),
            cell("Cabeleireiro, barbeiro, nail tech", { w: 2760 }),
          ]}),
          new TableRow({ children: [
            cell("Delivery/Gig", { w: 2200 }),
            cell("70M workers", { w: 2200, center: true }),
            cell("$3-8", { w: 2200, center: true }),
            cell("Entregador, motorista", { w: 2760 }),
          ]}),
          new TableRow({ children: [
            cell("Servicos pessoais", { w: 2200 }),
            cell("Milhoes", { w: 2200, center: true }),
            cell("15-20%", { w: 2200, center: true }),
            cell("Dog walker, cleaner, tutor", { w: 2760 }),
          ]}),
        ]
      }),

      new Paragraph({ children: [new PageBreak()] }),

      // ===== 2. CONCORRENCIA =====
      h1("2. Analise Competitiva"),
      p("O mercado de digital tipping ja tem players, mas nenhum combina tipping + rede social + proximidade fisica como o Touch?."),

      h2("2.1 Competidores Diretos"),
      new Table({
        width: { size: CW, type: WidthType.DXA },
        columnWidths: [1800, 1500, 2200, 1500, 2360],
        rows: [
          new TableRow({ children: [
            cell("Empresa", { bold: true, bg: "1a1a2e", color: "ffffff", w: 1800 }),
            cell("Funding", { bold: true, bg: "1a1a2e", color: "ffffff", w: 1500, center: true }),
            cell("Foco", { bold: true, bg: "1a1a2e", color: "ffffff", w: 2200 }),
            cell("Modelo", { bold: true, bg: "1a1a2e", color: "ffffff", w: 1500, center: true }),
            cell("Fraqueza vs Touch?", { bold: true, bg: "1a1a2e", color: "ffffff", w: 2360 }),
          ]}),
          new TableRow({ children: [
            cell("Tippy", { w: 1800, bold: true }),
            cell("$6.1M", { w: 1500, center: true }),
            cell("Saloes e spas", { w: 2200 }),
            cell("QR + NFC", { w: 1500, center: true }),
            cell("So tipping, sem social", { w: 2360 }),
          ]}),
          new TableRow({ children: [
            cell("eTip", { w: 1800, bold: true }),
            cell("$990K", { w: 1500, center: true }),
            cell("Hoteis e hospitalidade", { w: 2200 }),
            cell("QR code", { w: 1500, center: true }),
            cell("B2B puro, sem consumer", { w: 2360 }),
          ]}),
          new TableRow({ children: [
            cell("TipHaus", { w: 1800, bold: true }),
            cell("N/D", { w: 1500, center: true }),
            cell("Distribuicao de tips", { w: 2200 }),
            cell("SaaS B2B", { w: 1500, center: true }),
            cell("Back-office, sem front-end", { w: 2360 }),
          ]}),
          new TableRow({ children: [
            cell("Canary", { w: 1800, bold: true }),
            cell("N/D", { w: 1500, center: true }),
            cell("Hoteis (Marriott, Hilton)", { w: 2200 }),
            cell("Enterprise", { w: 1500, center: true }),
            cell("So hotel, preco alto", { w: 2360 }),
          ]}),
          new TableRow({ children: [
            cell("bene", { w: 1800, bold: true }),
            cell("N/D", { w: 1500, center: true }),
            cell("Hoteis (QR cards)", { w: 2200 }),
            cell("B2B", { w: 1500, center: true }),
            cell("Sem rede social", { w: 2360 }),
          ]}),
        ]
      }),

      new Paragraph({ spacing: { after: 160 } }),
      h2("2.2 Vantagem Competitiva do Touch?"),
      p("Nenhum competidor oferece o que o Touch? oferece. Eles sao ferramentas de pagamento. O Touch? e uma experiencia social que inclui pagamento."),

      new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 100 },
        children: [new TextRun({ text: "Cadastro instantaneo via QR code (nick + nascimento + email + senha) - o outro usuario nao precisa ter conta previa", size: 22, font: "Arial" })] }),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 100 },
        children: [new TextRun({ text: "Web app - zero fricao de download, funciona direto no navegador", size: 22, font: "Arial" })] }),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 100 },
        children: [new TextRun({ text: "Rede social embutida - conexoes, chat 24h, reveal de identidade, constellation de relacoes", size: 22, font: "Arial" })] }),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 100 },
        children: [new TextRun({ text: "Carteira digital com Apple Pay / Google Pay - gorjeta instantanea via celular", size: 22, font: "Arial" })] }),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 100 },
        children: [new TextRun({ text: "Gesto fisico (touch) cria memoria emocional - nao e um tap frio num iPad", size: 22, font: "Arial" })] }),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 160 },
        children: [new TextRun({ text: "Operador mode: estabelecimentos podem gerenciar rotinas (check-in, split de conta, gorjeta da casa)", size: 22, font: "Arial" })] }),

      new Paragraph({ children: [new PageBreak()] }),

      // ===== 3. ESTRATEGIA =====
      h1("3. Estrategia de Lancamento"),
      p("Lancamento 100% remoto via trafego pago em redes sociais. Sem presenca fisica nos EUA. Dois publicos-alvo simultaneos: prestadores de servico (supply) e consumidores (demand)."),

      h2("3.1 Dois Lados do Mercado"),

      h3("Lado A: Prestadores de Servico (Supply)"),
      p("Sao quem precisa do Touch? pra ganhar gorjeta. Eles sao o motor de distribuicao porque vao mostrar o QR code pros clientes."),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 100 },
        children: [new TextRun({ text: "Barbeiros e cabeleireiros independentes", size: 22, font: "Arial" })] }),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 100 },
        children: [new TextRun({ text: "Bartenders e garcons", size: 22, font: "Arial" })] }),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 100 },
        children: [new TextRun({ text: "Valets, bellboys, housekeeping", size: 22, font: "Arial" })] }),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 100 },
        children: [new TextRun({ text: "Dog walkers, cleaners, personal trainers", size: 22, font: "Arial" })] }),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 160 },
        children: [new TextRun({ text: "Delivery drivers e gig workers", size: 22, font: "Arial" })] }),
      pRuns([
        { text: "Mensagem-chave: ", bold: true },
        { text: "\"Stop losing tips. 85% of your customers don't carry cash. Get your tips instantly with Touch? - no app download needed for your clients.\"" , italic: true }
      ]),

      h3("Lado B: Operadores / Estabelecimentos"),
      p("Donos de barbearias, restaurantes, cafes, hoteis. Eles adotam o modo Operador pra gerenciar rotinas do estabelecimento e garantir que seus funcionarios recebam gorjeta digital."),
      pRuns([
        { text: "Mensagem-chave: ", bold: true },
        { text: "\"Your staff deserves every tip. Touch? lets customers tip instantly - no awkward iPad screens, no cash needed. Set up your venue in 2 minutes.\"", italic: true }
      ]),

      h3("Lado C: Consumidores (Demand)"),
      p("Chegam organicamente via QR code dos prestadores. O prestador mostra o QR, o consumidor le, cadastra em 15 segundos, e ja pode dar gorjeta ativando a carteira do celular. Esse lado nao precisa de trafego pago - cresce pelo QR code."),

      h2("3.2 Funil de Aquisicao"),
      new Table({
        width: { size: CW, type: WidthType.DXA },
        columnWidths: [1800, 3780, 3780],
        rows: [
          new TableRow({ children: [
            cell("Etapa", { bold: true, bg: "ff6b35", color: "ffffff", w: 1800 }),
            cell("Prestador de Servico", { bold: true, bg: "ff6b35", color: "ffffff", w: 3780, center: true }),
            cell("Consumidor", { bold: true, bg: "ff6b35", color: "ffffff", w: 3780, center: true }),
          ]}),
          new TableRow({ children: [
            cell("Descoberta", { w: 1800, bold: true }),
            cell("Ad no TikTok/Instagram/YouTube", { w: 3780 }),
            cell("QR code do prestador", { w: 3780 }),
          ]}),
          new TableRow({ children: [
            cell("Cadastro", { w: 1800, bold: true }),
            cell("encosta.app - nick, nasc, email, senha", { w: 3780 }),
            cell("Scan QR - nick, nasc, email, senha", { w: 3780 }),
          ]}),
          new TableRow({ children: [
            cell("Ativacao", { w: 1800, bold: true }),
            cell("Configura perfil, gera QR pessoal", { w: 3780 }),
            cell("Ativa carteira (Apple/Google Pay)", { w: 3780 }),
          ]}),
          new TableRow({ children: [
            cell("Retencao", { w: 1800, bold: true }),
            cell("Recebe tips, ve conexoes, chat", { w: 3780 }),
            cell("Rede social, conexoes, eventos", { w: 3780 }),
          ]}),
        ]
      }),

      new Paragraph({ children: [new PageBreak()] }),

      // ===== 4. TRAFEGO PAGO =====
      h1("4. Estrategia de Trafego Pago"),

      h2("4.1 Plataformas e Custos"),
      new Table({
        width: { size: CW, type: WidthType.DXA },
        columnWidths: [2000, 1500, 1500, 1500, 2860],
        rows: [
          new TableRow({ children: [
            cell("Plataforma", { bold: true, bg: "1a1a2e", color: "ffffff", w: 2000 }),
            cell("CPC Medio", { bold: true, bg: "1a1a2e", color: "ffffff", w: 1500, center: true }),
            cell("CPM Medio", { bold: true, bg: "1a1a2e", color: "ffffff", w: 1500, center: true }),
            cell("Engajamento", { bold: true, bg: "1a1a2e", color: "ffffff", w: 1500, center: true }),
            cell("Melhor Para", { bold: true, bg: "1a1a2e", color: "ffffff", w: 2860 }),
          ]}),
          new TableRow({ children: [
            cell("TikTok Ads", { w: 2000, bold: true }),
            cell("$0.35-1.00", { w: 1500, center: true }),
            cell("$4-7", { w: 1500, center: true }),
            cell("5.7%", { w: 1500, center: true, color: "22883e", bold: true }),
            cell("Awareness + viralizacao", { w: 2860 }),
          ]}),
          new TableRow({ children: [
            cell("Instagram/Meta", { w: 2000, bold: true }),
            cell("~$1.10", { w: 1500, center: true }),
            cell("~$7", { w: 1500, center: true }),
            cell("<2%", { w: 1500, center: true }),
            cell("Conversao direta, retargeting", { w: 2860 }),
          ]}),
          new TableRow({ children: [
            cell("YouTube Shorts", { w: 2000, bold: true }),
            cell("$0.10-0.30", { w: 1500, center: true }),
            cell("$3-6", { w: 1500, center: true }),
            cell("3-5%", { w: 1500, center: true }),
            cell("Demos + tutorials", { w: 2860 }),
          ]}),
        ]
      }),

      new Paragraph({ spacing: { after: 160 } }),
      h2("4.2 Budget Sugerido (Primeiros 3 Meses)"),
      new Table({
        width: { size: CW, type: WidthType.DXA },
        columnWidths: [3120, 2080, 2080, 2080],
        rows: [
          new TableRow({ children: [
            cell("Item", { bold: true, bg: "1a1a2e", color: "ffffff", w: 3120 }),
            cell("Mes 1", { bold: true, bg: "1a1a2e", color: "ffffff", w: 2080, center: true }),
            cell("Mes 2", { bold: true, bg: "1a1a2e", color: "ffffff", w: 2080, center: true }),
            cell("Mes 3", { bold: true, bg: "1a1a2e", color: "ffffff", w: 2080, center: true }),
          ]}),
          new TableRow({ children: [
            cell("TikTok Ads (60% do budget)", { w: 3120 }),
            cell("$600", { w: 2080, center: true }),
            cell("$900", { w: 2080, center: true }),
            cell("$1,200", { w: 2080, center: true }),
          ]}),
          new TableRow({ children: [
            cell("Instagram/Meta Ads (30%)", { w: 3120 }),
            cell("$300", { w: 2080, center: true }),
            cell("$450", { w: 2080, center: true }),
            cell("$600", { w: 2080, center: true }),
          ]}),
          new TableRow({ children: [
            cell("YouTube Shorts (10%)", { w: 3120 }),
            cell("$100", { w: 2080, center: true }),
            cell("$150", { w: 2080, center: true }),
            cell("$200", { w: 2080, center: true }),
          ]}),
          new TableRow({ children: [
            cell("TOTAL MENSAL", { bold: true, w: 3120, bg: "f0f0f0" }),
            cell("$1,000", { w: 2080, center: true, bold: true, bg: "f0f0f0" }),
            cell("$1,500", { w: 2080, center: true, bold: true, bg: "f0f0f0" }),
            cell("$2,000", { w: 2080, center: true, bold: true, bg: "f0f0f0" }),
          ]}),
        ]
      }),

      new Paragraph({ spacing: { after: 160 } }),
      pRuns([
        { text: "Estimativa com $1,000/mes em TikTok: ", bold: true },
        { text: "Com CPC de $0.50 e taxa de conversao de 5%, sao ~2,000 cliques e ~100 cadastros de prestadores/mes. Cada prestador que adota vira um ponto de distribuicao via QR code, gerando 5-20 consumidores organicos. Potencial: 100 prestadores geram 500-2,000 consumidores sem custo adicional." }
      ]),

      h2("4.3 Tipos de Conteudo para Ads"),

      h3("Formato 1: Pain Point (5-10s)"),
      p("\"When was the last time someone tipped you in cash?\" - corta pra prestador mostrando carteira vazia - corta pra Touch? QR code - \"Get 100% of your tips. Instantly.\"", { italic: true }),

      h3("Formato 2: Demo Real (15-30s)"),
      p("Barbeiro termina corte, cliente aproxima celular do QR code do barbeiro, tip aparece na tela, barbeiro sorri. Texto: \"No app needed for your client. Just scan, tip, done.\"", { italic: true }),

      h3("Formato 3: Operador (15s)"),
      p("Dono de restaurante mostrando o painel do Touch? no celular. \"My staff's tips went up 40% since we started using Touch?. Setup took 2 minutes.\"", { italic: true }),

      h3("Formato 4: Social Proof / UGC"),
      p("Compilacao de prestadores mostrando suas gorjetas no app. Trend style do TikTok. Musica viral. Hashtag #TouchTip ou #GetYourTouch.", { italic: true }),

      new Paragraph({ children: [new PageBreak()] }),

      // ===== 5. TARGETING =====
      h1("5. Segmentacao e Targeting"),

      h2("5.1 Publico Primario: Prestadores de Servico"),
      new Table({
        width: { size: CW, type: WidthType.DXA },
        columnWidths: [3120, 6240],
        rows: [
          new TableRow({ children: [
            cell("Criterio", { bold: true, bg: "1a1a2e", color: "ffffff", w: 3120 }),
            cell("Detalhamento", { bold: true, bg: "1a1a2e", color: "ffffff", w: 6240 }),
          ]}),
          new TableRow({ children: [
            cell("Idade", { w: 3120, bold: true }),
            cell("18-45", { w: 6240 }),
          ]}),
          new TableRow({ children: [
            cell("Localizacao", { w: 3120, bold: true }),
            cell("Miami, Austin, Los Angeles, New York, Las Vegas (cidades com forte cultura de tip)", { w: 6240 }),
          ]}),
          new TableRow({ children: [
            cell("Interesses", { w: 3120, bold: true }),
            cell("Barbershop, bartending, waitress life, gig economy, side hustle, tips, service industry", { w: 6240 }),
          ]}),
          new TableRow({ children: [
            cell("Comportamento", { w: 3120, bold: true }),
            cell("Seguidores de contas de bartenders, barbers, nail techs no TikTok/Instagram", { w: 6240 }),
          ]}),
          new TableRow({ children: [
            cell("Idioma", { w: 3120, bold: true }),
            cell("Ingles (primario), Espanhol (Miami, LA, Texas - grande populacao latina)", { w: 6240 }),
          ]}),
        ]
      }),

      new Paragraph({ spacing: { after: 160 } }),
      h2("5.2 Cidades Prioritarias"),
      p("A estrategia nao e lancar nos EUA inteiros. E saturar cidades especificas onde a cultura de gorjeta e forte e o publico e receptivo a tecnologia."),

      new Paragraph({ numbering: { reference: "numbers", level: 0 }, spacing: { after: 100 },
        children: [new TextRun({ text: "Miami (Wynwood, South Beach, Brickell) - vida noturna forte, populacao latina, turismo o ano todo", size: 22, font: "Arial" })] }),
      new Paragraph({ numbering: { reference: "numbers", level: 0 }, spacing: { after: 100 },
        children: [new TextRun({ text: "Austin - tech-friendly, SXSW, cena de bares e restaurantes forte", size: 22, font: "Arial" })] }),
      new Paragraph({ numbering: { reference: "numbers", level: 0 }, spacing: { after: 100 },
        children: [new TextRun({ text: "Los Angeles - maior cidade de servicos dos EUA, enorme populacao de gig workers", size: 22, font: "Arial" })] }),
      new Paragraph({ numbering: { reference: "numbers", level: 0 }, spacing: { after: 100 },
        children: [new TextRun({ text: "Las Vegas - tips sao a alma da cidade, bartenders, dealers, valets", size: 22, font: "Arial" })] }),
      new Paragraph({ numbering: { reference: "numbers", level: 0 }, spacing: { after: 160 },
        children: [new TextRun({ text: "New York - volume massivo, mas mais caro pra anunciar (fase 2)", size: 22, font: "Arial" })] }),

      new Paragraph({ children: [new PageBreak()] }),

      // ===== 6. METRICAS =====
      h1("6. Metricas de Sucesso"),

      h2("6.1 KPIs por Fase"),
      new Table({
        width: { size: CW, type: WidthType.DXA },
        columnWidths: [2340, 2340, 2340, 2340],
        rows: [
          new TableRow({ children: [
            cell("KPI", { bold: true, bg: "ff6b35", color: "ffffff", w: 2340 }),
            cell("Mes 1", { bold: true, bg: "ff6b35", color: "ffffff", w: 2340, center: true }),
            cell("Mes 3", { bold: true, bg: "ff6b35", color: "ffffff", w: 2340, center: true }),
            cell("Mes 6", { bold: true, bg: "ff6b35", color: "ffffff", w: 2340, center: true }),
          ]}),
          new TableRow({ children: [
            cell("Prestadores cadastrados", { w: 2340 }),
            cell("100", { w: 2340, center: true }),
            cell("500", { w: 2340, center: true }),
            cell("2,000", { w: 2340, center: true }),
          ]}),
          new TableRow({ children: [
            cell("Consumidores (via QR)", { w: 2340 }),
            cell("300", { w: 2340, center: true }),
            cell("2,500", { w: 2340, center: true }),
            cell("15,000", { w: 2340, center: true }),
          ]}),
          new TableRow({ children: [
            cell("Tips processados/mes", { w: 2340 }),
            cell("50", { w: 2340, center: true }),
            cell("800", { w: 2340, center: true }),
            cell("5,000", { w: 2340, center: true }),
          ]}),
          new TableRow({ children: [
            cell("Volume de tips (USD)", { w: 2340 }),
            cell("$500", { w: 2340, center: true }),
            cell("$8,000", { w: 2340, center: true }),
            cell("$50,000", { w: 2340, center: true }),
          ]}),
          new TableRow({ children: [
            cell("Operadores (estabelec.)", { w: 2340 }),
            cell("5", { w: 2340, center: true }),
            cell("30", { w: 2340, center: true }),
            cell("150", { w: 2340, center: true }),
          ]}),
          new TableRow({ children: [
            cell("CAC medio (prestador)", { w: 2340 }),
            cell("$10", { w: 2340, center: true }),
            cell("$6", { w: 2340, center: true }),
            cell("$3", { w: 2340, center: true }),
          ]}),
        ]
      }),

      new Paragraph({ spacing: { after: 160 } }),
      h2("6.2 O Efeito Multiplicador do QR Code"),
      p("Essa e a mecanica mais poderosa do Touch? e a razao pela qual o engajamento vai funcionar. Cada prestador que adota o Touch? se torna um ponto de aquisicao gratuito e permanente."),
      pRuns([
        { text: "Exemplo real: ", bold: true },
        { text: "Um barbeiro em Miami atende 15 clientes/dia. Se 20% escaneia o QR code e se cadastra, sao 3 novos usuarios por dia, 90 por mes. Um unico barbeiro. Com 100 barbeiros, sao 9,000 consumidores novos por mes, sem pagar nada por eles." }
      ]),
      p("Esse efeito e exponencial porque cada consumidor que entra tambem ganha seu proprio QR code e pode trazer outros. O custo de aquisicao de consumidor tende a zero conforme a rede cresce."),

      new Paragraph({ children: [new PageBreak()] }),

      // ===== 7. RISCOS =====
      h1("7. Riscos e Mitigacoes"),

      new Table({
        width: { size: CW, type: WidthType.DXA },
        columnWidths: [2800, 3280, 3280],
        rows: [
          new TableRow({ children: [
            cell("Risco", { bold: true, bg: "c0392b", color: "ffffff", w: 2800 }),
            cell("Impacto", { bold: true, bg: "c0392b", color: "ffffff", w: 3280 }),
            cell("Mitigacao", { bold: true, bg: "c0392b", color: "ffffff", w: 3280 }),
          ]}),
          new TableRow({ children: [
            cell("Restricao 18+", { w: 2800, bold: true }),
            cell("Corta publico teen (alto engajamento)", { w: 3280 }),
            cell("Publico que gasta dinheiro e 18+. Tipping e adulto por natureza.", { w: 3280 }),
          ]}),
          new TableRow({ children: [
            cell("Cold start local", { w: 2800, bold: true }),
            cell("Sem massa critica, ninguem acha ninguem", { w: 3280 }),
            cell("QR code resolve: cada prestador e um ponto de entrada. Nao depende de \"ter gente\" pra funcionar.", { w: 3280 }),
          ]}),
          new TableRow({ children: [
            cell("Sem presenca fisica nos EUA", { w: 2800, bold: true }),
            cell("Dificil B2B sem reunioes presenciais", { w: 3280 }),
            cell("Foco em prestadores individuais (B2C) via redes sociais. Operadores vem depois, organicamente.", { w: 3280 }),
          ]}),
          new TableRow({ children: [
            cell("Competidores levantam rodada", { w: 2800, bold: true }),
            cell("Tippy, eTip aceleram", { w: 3280 }),
            cell("Touch? tem moat: e rede social, nao so pagamento. Competidores sao tools, Touch? e plataforma.", { w: 3280 }),
          ]}),
          new TableRow({ children: [
            cell("Regulacao financeira", { w: 2800, bold: true }),
            cell("Money transmitter license por estado", { w: 3280 }),
            cell("Usar Stripe Connect como intermediario (eles possuem as licencas). Touch? nao toca no dinheiro.", { w: 3280 }),
          ]}),
          new TableRow({ children: [
            cell("Tipping fatigue do consumidor", { w: 2800, bold: true }),
            cell("Consumidor cansado de dar tip", { w: 3280 }),
            cell("Touch? e opt-in e pessoal (gesto fisico), nao e tela de POS forjando porcentagem. E o anti-fatigue.", { w: 3280 }),
          ]}),
        ]
      }),

      new Paragraph({ children: [new PageBreak()] }),

      // ===== 8. TIMELINE =====
      h1("8. Timeline de Lancamento"),

      h2("Fase 1: Pre-lancamento (Semanas 1-2)"),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 100 },
        children: [new TextRun({ text: "Criar contas de negocio: TikTok Business, Meta Business, Google Ads", size: 22, font: "Arial" })] }),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 100 },
        children: [new TextRun({ text: "Produzir 10-15 videos criativos com Veo 3 (cenarios de gorjeta, demos, social proof)", size: 22, font: "Arial" })] }),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 100 },
        children: [new TextRun({ text: "Configurar landing page em ingles (encosta.app/en ou subdominio us.encosta.app)", size: 22, font: "Arial" })] }),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 100 },
        children: [new TextRun({ text: "Preparar pixel de tracking (Meta Pixel, TikTok Pixel) pra otimizacao", size: 22, font: "Arial" })] }),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 160 },
        children: [new TextRun({ text: "Criar perfis organicos: @touchapp no TikTok/IG com conteudo pre-lancamento", size: 22, font: "Arial" })] }),

      h2("Fase 2: Lancamento Soft (Semanas 3-6)"),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 100 },
        children: [new TextRun({ text: "Comecar trafego pago: $30-50/dia, 60% TikTok, 30% Meta, 10% YouTube", size: 22, font: "Arial" })] }),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 100 },
        children: [new TextRun({ text: "Target: prestadores de servico em Miami e Austin", size: 22, font: "Arial" })] }),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 100 },
        children: [new TextRun({ text: "A/B testing de criativos (pain point vs demo vs UGC)", size: 22, font: "Arial" })] }),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 160 },
        children: [new TextRun({ text: "Coletar feedback dos primeiros prestadores, iterar produto", size: 22, font: "Arial" })] }),

      h2("Fase 3: Aceleracao (Semanas 7-12)"),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 100 },
        children: [new TextRun({ text: "Dobrar budget nos canais que performam melhor", size: 22, font: "Arial" })] }),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 100 },
        children: [new TextRun({ text: "Expandir para LA e Las Vegas", size: 22, font: "Arial" })] }),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 100 },
        children: [new TextRun({ text: "Iniciar conteudo de Operador (convencer estabelecimentos a adotar)", size: 22, font: "Arial" })] }),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 100 },
        children: [new TextRun({ text: "Criar programa de referral: prestador que traz outros prestadores ganha beneficio", size: 22, font: "Arial" })] }),
      new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 160 },
        children: [new TextRun({ text: "Medir efeito multiplicador do QR code e ajustar projecoes", size: 22, font: "Arial" })] }),

      new Paragraph({ spacing: { before: 400 } }),
      h1("9. Conclusao"),
      p("O mercado de gorjeta digital nos EUA e de US$ 50+ bilhoes/ano e esta em plena transicao do cash pro digital. Os competidores existentes sao ferramentas de pagamento B2B sem camada social. O Touch? e o unico que combina gorjeta + rede social + proximidade fisica num web app sem fricao."),
      p("A estrategia de lancamento via trafego pago focado em prestadores de servico e viavel com budget acessivel ($1,000-2,000/mes) porque cada prestador adquirido via ads se torna um ponto de distribuicao permanente via QR code, gerando crescimento organico exponencial no lado do consumidor."),
      pRuns([
        { text: "O 18+ nao e um problema, e uma vantagem: ", bold: true },
        { text: "o publico que da e recebe gorjeta e adulto por definicao. A preocupacao com engajamento se resolve pela mecanica do QR code - o Touch? nao depende de viralidade digital pra crescer, depende de presenca fisica nos pontos de servico." }
      ]),

      new Paragraph({ spacing: { before: 600 }, alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: "---", size: 20, color: "cccccc" })] }),
      new Paragraph({ spacing: { before: 200 }, alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: "Touch? | tudo nasce no gesto | encosta.app", size: 20, font: "Arial", color: "999999", italics: true })] }),
    ]
  }]
});

Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync("/sessions/trusting-gifted-mccarthy/mnt/encosta/GTM-GORJETA-USA.docx", buf);
  console.log("OK - " + buf.length + " bytes");
});
