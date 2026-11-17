// Relatórios gerenciais e exportação em CSV e PDF
const { db } = require('../database/db');

function gerarDadosRelatorio() {
  const produtosMaisVendidos = db
    .prepare(`
      SELECT p.id, p.nome, p.categoria, p.unidadeMedida, p.precoVenda,
             COALESCE(SUM(CASE WHEN m.tipo = 'Saida' THEN m.quantidade ELSE 0 END), 0) AS totalSaidas,
             COUNT(CASE WHEN m.tipo = 'Saida' THEN 1 END) AS numeroOperacoesSaida,
             ROUND(COALESCE(SUM(CASE WHEN m.tipo = 'Saida' THEN m.quantidade ELSE 0 END), 0) * p.precoVenda, 2) AS valorEstimadoSaidas
      FROM Produto p
      LEFT JOIN Movimentacao m ON m.produtoId = p.id
      GROUP BY p.id
      HAVING totalSaidas > 0
      ORDER BY totalSaidas DESC, valorEstimadoSaidas DESC
    `)
    .all();

  const produtosParados = db
    .prepare(`
      SELECT p.id, p.nome, p.categoria, p.unidadeMedida, p.precoVenda,
             COALESCE((SELECT SUM(l.quantidadeAtual) FROM Lote l WHERE l.produtoId = p.id), 0) AS saldoEmEstoque,
             COALESCE((SELECT MIN(l.dataEntrada) FROM Lote l WHERE l.produtoId = p.id AND l.quantidadeAtual > 0), '-') AS entradaMaisAntiga,
             ROUND(COALESCE((SELECT SUM(l.quantidadeAtual) FROM Lote l WHERE l.produtoId = p.id), 0) * p.precoVenda, 2) AS valorParadoEmEstoque
      FROM Produto p
      WHERE COALESCE((SELECT SUM(l.quantidadeAtual) FROM Lote l WHERE l.produtoId = p.id), 0) > 0
        AND NOT EXISTS (SELECT 1 FROM Movimentacao m WHERE m.produtoId = p.id AND m.tipo = 'Saida')
      ORDER BY valorParadoEmEstoque DESC, p.nome ASC
    `)
    .all();

  const perdasRegistradas = db
    .prepare(`
      SELECT m.id AS movimentacaoId, m.quantidade, m.dataHora, m.observacao,
             p.id AS produtoId, p.nome AS produtoNome, p.categoria, p.unidadeMedida, p.precoVenda,
             ROUND(m.quantidade * p.precoVenda, 2) AS prejuizoEstimado,
             l.codigoLote, l.dataValidade,
             u.nome AS responsavelBaixa
      FROM Movimentacao m
      JOIN Produto p ON p.id = m.produtoId
      JOIN Lote l ON l.id = m.loteId
      JOIN Usuario u ON u.id = m.usuarioId
      WHERE m.tipo = 'Perda'
      ORDER BY m.id DESC
    `)
    .all();

  const lotesVencidosEmEstoque = db
    .prepare(`
      SELECT l.id AS loteId, l.codigoLote, l.quantidadeAtual, l.dataEntrada, l.dataValidade, l.estado,
             p.id AS produtoId, p.nome AS produtoNome, p.categoria, p.unidadeMedida, p.precoVenda,
             ROUND(l.quantidadeAtual * p.precoVenda, 2) AS prejuizoPotencial
      FROM Lote l
      JOIN Produto p ON p.id = l.produtoId
      WHERE l.estado = 'Vencido' AND l.quantidadeAtual > 0
      ORDER BY l.dataValidade ASC
    `)
    .all();

  const movimentacoesPorFuncionario = db
    .prepare(`
      SELECT u.id AS usuarioId, u.nome, u.login, u.perfil,
             COUNT(m.id) AS totalOperacoes,
             COALESCE(SUM(CASE WHEN m.tipo = 'Entrada' THEN m.quantidade ELSE 0 END), 0) AS qtdTotalEntradas,
             COALESCE(SUM(CASE WHEN m.tipo = 'Saida' THEN m.quantidade ELSE 0 END), 0) AS qtdTotalSaidas,
             COALESCE(SUM(CASE WHEN m.tipo = 'Perda' THEN m.quantidade ELSE 0 END), 0) AS qtdTotalPerdas,
             COUNT(CASE WHEN m.tipo = 'Saida' THEN 1 END) AS operacoesSaida
      FROM Usuario u
      LEFT JOIN Movimentacao m ON m.usuarioId = u.id
      GROUP BY u.id
      ORDER BY totalOperacoes DESC, u.nome ASC
    `)
    .all();

  const inventarioPatrimonial = db
    .prepare(`
      SELECT p.id, p.nome, p.categoria, p.unidadeMedida, p.precoVenda, p.estoqueMinimo,
             COALESCE(SUM(l.quantidadeAtual), 0) AS quantidadeTotalFisica,
             ROUND(COALESCE(SUM(l.quantidadeAtual), 0) * p.precoVenda, 2) AS valorPatrimonialItem
      FROM Produto p
      LEFT JOIN Lote l ON l.produtoId = p.id
      GROUP BY p.id
      ORDER BY p.categoria ASC, p.nome ASC
    `)
    .all();

  const valorTotalPatrimonio = Number(
    inventarioPatrimonial
      .reduce((acc, item) => acc + Number(item.valorPatrimonialItem || 0), 0)
      .toFixed(2)
  );

  const valorTotalPrejuizoPerdas = Number(
    perdasRegistradas
      .reduce((acc, item) => acc + Number(item.prejuizoEstimado || 0), 0)
      .toFixed(2)
  );

  return {
    geradoEm: new Date().toLocaleString('pt-BR'),
    resumoFinanceiroPatrimonial: {
      totalProdutosCatalogados: inventarioPatrimonial.length,
      valorTotalPatrimonio,
      valorTotalPrejuizoPerdas,
      totalLotesVencidosPendentes: lotesVencidosEmEstoque.length,
    },
    produtosMaisVendidos,
    produtosParados,
    perdasPorVencimento: {
      perdasBaixadas: perdasRegistradas,
      lotesVencidosPendentesBaixa: lotesVencidosEmEstoque,
    },
    movimentacoesPorFuncionario,
    inventarioPatrimonial,
  };
}

function obterRelatorios(req, res) {
  return res.status(200).json(gerarDadosRelatorio());
}

function exportarCSV(req, res) {
  const dados = gerarDadosRelatorio();
  const linhas = [];

  const esc = (val) => {
    if (val === null || val === undefined) return '""';
    return `"${String(val).replace(/"/g, '""')}"`;
  };

  linhas.push('"RELATORIO DE DECLARACAO DE ESTOQUE E PATRIMONIO - MERCEARIA"');
  linhas.push(`"Gerado em:";${esc(dados.geradoEm)};"Responsavel:";${esc(req.usuario.nome)}`);
  linhas.push('');

  linhas.push('"1. DECLARACAO DE INVENTARIO E PATRIMONIO"');
  linhas.push('"ID";"Produto";"Categoria";"Unidade";"Preco Unitario (R$)";"Qtd em Estoque";"Valor Patrimonial (R$)"');
  for (const item of dados.inventarioPatrimonial) {
    linhas.push(
      [
        item.id,
        esc(item.nome),
        esc(item.categoria),
        esc(item.unidadeMedida),
        item.precoVenda,
        item.quantidadeTotalFisica,
        item.valorPatrimonialItem,
      ].join(';')
    );
  }
  linhas.push(`"TOTAL PATRIMONIAL (R$)";;;;;;${dados.resumoFinanceiroPatrimonial.valorTotalPatrimonio}`);
  linhas.push('');

  linhas.push('"2. PRODUTOS COM MAIOR SAIDA"');
  linhas.push('"ID";"Produto";"Categoria";"Unidade";"Total Saidas";"Num Operacoes";"Valor Estimado (R$)"');
  for (const item of dados.produtosMaisVendidos) {
    linhas.push(
      [
        item.id,
        esc(item.nome),
        esc(item.categoria),
        esc(item.unidadeMedida),
        item.totalSaidas,
        item.numeroOperacoesSaida,
        item.valorEstimadoSaidas,
      ].join(';')
    );
  }
  linhas.push('');

  linhas.push('"3. PRODUTOS PARADOS NO ESTOQUE"');
  linhas.push('"ID";"Produto";"Categoria";"Saldo Parado";"Entrada Mais Antiga";"Valor Imobilizado (R$)"');
  for (const item of dados.produtosParados) {
    linhas.push(
      [
        item.id,
        esc(item.nome),
        esc(item.categoria),
        item.saldoEmEstoque,
        esc(item.entradaMaisAntiga),
        item.valorParadoEmEstoque,
      ].join(';')
    );
  }
  linhas.push('');

  linhas.push('"4. HISTORICO DE PERDAS E LOTES VENCIDOS"');
  linhas.push('"Status";"Lote";"Produto";"Quantidade";"Validade";"Prejuizo (R$)";"Observacao"');
  for (const p of dados.perdasPorVencimento.perdasBaixadas) {
    linhas.push(
      [
        '"Baixa Registrada"',
        esc(p.codigoLote),
        esc(p.produtoNome),
        p.quantidade,
        esc(p.dataValidade),
        p.prejuizoEstimado,
        esc(p.observacao),
      ].join(';')
    );
  }
  for (const v of dados.perdasPorVencimento.lotesVencidosPendentesBaixa) {
    linhas.push(
      [
        '"Vencido em Estoque"',
        esc(v.codigoLote),
        esc(v.produtoNome),
        v.quantidadeAtual,
        esc(v.dataValidade),
        v.prejuizoPotencial,
        '"Aguardando baixa pelo Administrador"',
      ].join(';')
    );
  }
  linhas.push('');

  linhas.push('"5. MOVIMENTACOES POR FUNCIONARIO"');
  linhas.push('"Funcionario";"Login";"Perfil";"Total Operacoes";"Qtd Entradas";"Qtd Saidas";"Qtd Perdas"');
  for (const f of dados.movimentacoesPorFuncionario) {
    linhas.push(
      [
        esc(f.nome),
        esc(f.login),
        esc(f.perfil),
        f.totalOperacoes,
        f.qtdTotalEntradas,
        f.qtdTotalSaidas,
        f.qtdTotalPerdas,
      ].join(';')
    );
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="relatorio_estoque_mercearia.csv"');
  return res.status(200).send('\uFEFF' + linhas.join('\r\n'));
}

function exportarPDF(req, res) {
  const dados = gerarDadosRelatorio();

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Relatório de Estoque - Mercearia</title>
  <style>
    body { font-family: Arial, Helvetica, sans-serif; color: #1e293b; margin: 28px; font-size: 13px; }
    h1 { font-size: 20px; margin-bottom: 4px; color: #0f172a; }
    h2 { font-size: 15px; margin-top: 22px; margin-bottom: 8px; border-bottom: 2px solid #cbd5e1; padding-bottom: 4px; color: #1d3c5c; }
    .meta { color: #475569; margin-bottom: 16px; font-size: 12px; }
    .resumo { display: flex; gap: 16px; margin-bottom: 18px; }
    .card { border: 1px solid #cbd5e1; border-radius: 4px; padding: 10px 14px; background: #f8fafc; flex: 1; }
    .card strong { display: block; font-size: 16px; color: #0f172a; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 14px; }
    th, td { border: 1px solid #cbd5e1; padding: 6px 8px; text-align: left; }
    th { background: #e2e8f0; font-weight: bold; }
    .no-print { margin-bottom: 16px; }
    .btn { background: #3c8dbc; color: #fff; border: none; padding: 8px 14px; border-radius: 4px; cursor: pointer; font-weight: bold; }
    @media print { .no-print { display: none; } body { margin: 10px; } }
  </style>
</head>
<body>
  <div class="no-print">
    <button class="btn" onclick="window.print()">Imprimir / Salvar em PDF</button>
  </div>
  <h1>Sistema de Controle de Estoque da Mercearia</h1>
  <div class="meta">
    <strong>Relatório Geral de Inventário, Saídas e Perdas</strong><br>
    Emitido em: ${dados.geradoEm} | Emitido por: ${req.usuario.nome} (${req.usuario.perfil})
  </div>

  <div class="resumo">
    <div class="card">Produtos Cadastrados<strong>${dados.resumoFinanceiroPatrimonial.totalProdutosCatalogados} itens</strong></div>
    <div class="card">Patrimônio em Estoque<strong>R$ ${dados.resumoFinanceiroPatrimonial.valorTotalPatrimonio.toFixed(2)}</strong></div>
    <div class="card">Perdas Acumuladas<strong>R$ ${dados.resumoFinanceiroPatrimonial.valorTotalPrejuizoPerdas.toFixed(2)}</strong></div>
  </div>

  <h2>1. Inventário e Declaração Patrimonial</h2>
  <table>
    <thead>
      <tr><th>ID</th><th>Produto</th><th>Categoria</th><th>Unid.</th><th>Preço (R$)</th><th>Saldo Físico</th><th>Valor Patrimonial (R$)</th></tr>
    </thead>
    <tbody>
      ${dados.inventarioPatrimonial
        .map(
          (i) =>
            `<tr><td>${i.id}</td><td>${i.nome}</td><td>${i.categoria}</td><td>${i.unidadeMedida}</td><td>R$ ${Number(i.precoVenda).toFixed(2)}</td><td>${i.quantidadeTotalFisica}</td><td>R$ ${Number(i.valorPatrimonialItem).toFixed(2)}</td></tr>`
        )
        .join('')}
    </tbody>
  </table>

  <h2>2. Produtos com Maior Saída</h2>
  <table>
    <thead>
      <tr><th>Produto</th><th>Categoria</th><th>Qtd. Total Saídas</th><th>Nº Operações</th><th>Volume Estimado (R$)</th></tr>
    </thead>
    <tbody>
      ${
        dados.produtosMaisVendidos.length === 0
          ? '<tr><td colspan="5">Nenhuma saída registrada.</td></tr>'
          : dados.produtosMaisVendidos
              .map(
                (p) =>
                  `<tr><td>${p.nome}</td><td>${p.categoria}</td><td>${p.totalSaidas} ${p.unidadeMedida}</td><td>${p.numeroOperacoesSaida}</td><td>R$ ${Number(p.valorEstimadoSaidas).toFixed(2)}</td></tr>`
              )
              .join('')
      }
    </tbody>
  </table>

  <h2>3. Produtos Parados no Estoque</h2>
  <table>
    <thead>
      <tr><th>Produto</th><th>Categoria</th><th>Saldo Parado</th><th>Entrada Mais Antiga</th><th>Valor Imobilizado (R$)</th></tr>
    </thead>
    <tbody>
      ${
        dados.produtosParados.length === 0
          ? '<tr><td colspan="5">Nenhum produto parado.</td></tr>'
          : dados.produtosParados
              .map(
                (p) =>
                  `<tr><td>${p.nome}</td><td>${p.categoria}</td><td>${p.saldoEmEstoque} ${p.unidadeMedida}</td><td>${p.entradaMaisAntiga}</td><td>R$ ${Number(p.valorParadoEmEstoque).toFixed(2)}</td></tr>`
              )
              .join('')
      }
    </tbody>
  </table>

  <h2>4. Histórico de Perdas e Lotes Vencidos</h2>
  <table>
    <thead>
      <tr><th>Situação</th><th>Lote</th><th>Produto</th><th>Quantidade</th><th>Validade</th><th>Prejuízo (R$)</th></tr>
    </thead>
    <tbody>
      ${dados.perdasPorVencimento.perdasBaixadas
        .map(
          (p) =>
            `<tr><td>Baixa Realizada</td><td>${p.codigoLote}</td><td>${p.produtoNome}</td><td>${p.quantidade} ${p.unidadeMedida}</td><td>${p.dataValidade || '-'}</td><td>R$ ${Number(p.prejuizoEstimado).toFixed(2)}</td></tr>`
        )
        .join('')}
      ${dados.perdasPorVencimento.lotesVencidosPendentesBaixa
        .map(
          (v) =>
            `<tr><td>Vencido Bloqueado</td><td>${v.codigoLote}</td><td>${v.produtoNome}</td><td>${v.quantidadeAtual} ${v.unidadeMedida}</td><td>${v.dataValidade || '-'}</td><td>R$ ${Number(v.prejuizoPotencial).toFixed(2)}</td></tr>`
        )
        .join('')}
    </tbody>
  </table>

  <h2>5. Movimentações por Funcionário</h2>
  <table>
    <thead>
      <tr><th>Funcionário</th><th>Login</th><th>Perfil</th><th>Total Operações</th><th>Qtd. Entradas</th><th>Qtd. Saídas</th><th>Qtd. Perdas</th></tr>
    </thead>
    <tbody>
      ${dados.movimentacoesPorFuncionario
        .map(
          (f) =>
            `<tr><td>${f.nome}</td><td>${f.login}</td><td>${f.perfil}</td><td>${f.totalOperacoes}</td><td>${f.qtdTotalEntradas}</td><td>${f.qtdTotalSaidas}</td><td>${f.qtdTotalPerdas}</td></tr>`
        )
        .join('')}
    </tbody>
  </table>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(html);
}

module.exports = {
  gerarDadosRelatorio,
  obterRelatorios,
  exportarCSV,
  exportarPDF,
};
