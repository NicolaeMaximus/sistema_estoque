// Controle de entradas, saídas (FEFO), baixas de perda e operações em massa
const {
  db,
  calcularDiasParaVencimento,
  sincronizarEstadosEAlertas,
} = require('../database/db');

function registrarEntrada(req, res) {
  const { produtoId, codigoLote, quantidade, dataValidade, observacao } = req.body || {};

  const idProd = Number(produtoId);
  const qtd = Number(quantidade);

  if (!idProd || !codigoLote || Number.isNaN(qtd) || qtd <= 0) {
    return res.status(400).json({
      erro: 'Informe o produto, código do lote e uma quantidade maior que zero.',
    });
  }

  const produto = db.prepare('SELECT * FROM Produto WHERE id = ?').get(idProd);
  if (!produto) {
    return res.status(404).json({ erro: 'Produto não encontrado.' });
  }

  if (Number(produto.perecivel) === 1 && (!dataValidade || String(dataValidade).trim() === '')) {
    return res.status(400).json({
      erro: `O produto "${produto.nome}" é perecível e exige data de validade do lote.`,
    });
  }

  const dataEntrada = new Date().toISOString().slice(0, 10);
  const validadeFinal =
    dataValidade && String(dataValidade).trim() !== '' ? String(dataValidade).trim() : null;
  const codLoteLimpo = String(codigoLote).trim();

  let loteId;
  db.exec('BEGIN TRANSACTION;');
  try {
    const loteExistente = db
      .prepare('SELECT * FROM Lote WHERE produtoId = ? AND codigoLote = ?')
      .get(idProd, codLoteLimpo);

    if (loteExistente) {
      const novaQtd = Number((Number(loteExistente.quantidadeAtual) + qtd).toFixed(3));
      db.prepare(`
        UPDATE Lote
        SET quantidadeAtual = ?, dataValidade = COALESCE(?, dataValidade)
        WHERE id = ?
      `).run(novaQtd, validadeFinal, loteExistente.id);
      loteId = loteExistente.id;
    } else {
      const infoLote = db
        .prepare(`
          INSERT INTO Lote (produtoId, codigoLote, quantidadeAtual, dataEntrada, dataValidade, estado)
          VALUES (?, ?, ?, ?, ?, 'Disponivel')
        `)
        .run(idProd, codLoteLimpo, qtd, dataEntrada, validadeFinal);
      loteId = Number(infoLote.lastInsertRowid);
    }

    db.prepare(`
      INSERT INTO Movimentacao (produtoId, loteId, tipo, quantidade, dataHora, usuarioId, observacao)
      VALUES (?, ?, 'Entrada', ?, datetime('now', 'localtime'), ?, ?)
    `).run(
      idProd,
      loteId,
      qtd,
      req.usuario.id,
      observacao ? String(observacao).trim() : 'Entrada de lote'
    );

    sincronizarEstadosEAlertas();
    db.exec('COMMIT;');
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK;');
    return res.status(500).json({
      erro: 'Erro ao gravar entrada no banco de dados.',
      detalhe: err.message,
    });
  }

  const loteAtualizado = db.prepare('SELECT * FROM Lote WHERE id = ?').get(loteId);

  return res.status(201).json({
    mensagem: `Entrada de ${qtd} ${produto.unidadeMedida} de "${produto.nome}" (Lote ${codLoteLimpo}) registrada.`,
    lote: loteAtualizado,
  });
}

// Processa uma saída individual validando saldo (RN-I), validade (RE-I) e priorização FEFO (RN-III)
function processarSaidaUnitaria({ produtoId, loteId, quantidade, observacao, usuarioId }) {
  const idProd = Number(produtoId);
  const qtd = Number(quantidade);

  if (!idProd || Number.isNaN(qtd) || qtd <= 0) {
    const err = new Error('Informe um produto válido e quantidade maior que zero.');
    err.status = 400;
    throw err;
  }

  const produto = db.prepare('SELECT * FROM Produto WHERE id = ?').get(idProd);
  if (!produto) {
    const err = new Error('Produto não encontrado.');
    err.status = 404;
    throw err;
  }

  let loteSelecionado = null;

  if (loteId) {
    loteSelecionado = db
      .prepare('SELECT * FROM Lote WHERE id = ? AND produtoId = ?')
      .get(Number(loteId), idProd);
    if (!loteSelecionado) {
      const err = new Error('Lote não encontrado para este produto.');
      err.status = 404;
      throw err;
    }
  } else {
    // Busca automática FEFO: prioriza lotes não vencidos com validade mais próxima
    const hoje = new Date().toISOString().slice(0, 10);
    loteSelecionado = db
      .prepare(`
        SELECT *
        FROM Lote
        WHERE produtoId = ? AND quantidadeAtual > 0
        ORDER BY
          CASE WHEN dataValidade IS NOT NULL AND dataValidade < ? THEN 1 ELSE 0 END ASC,
          CASE WHEN dataValidade IS NULL OR dataValidade = '' THEN 1 ELSE 0 END ASC,
          dataValidade ASC,
          id ASC
        LIMIT 1
      `)
      .get(idProd, hoje);

    if (!loteSelecionado) {
      const err = new Error(
        `Quantidade indisponível: "${produto.nome}" está sem saldo em estoque.`
      );
      err.status = 400;
      err.codigoRegra = 'RN-I';
      err.saldoAtual = 0;
      throw err;
    }
  }

  // Bloqueia saída normal caso o lote esteja vencido (RE-I)
  if (Number(produto.perecivel) === 1 && loteSelecionado.dataValidade) {
    const dias = calcularDiasParaVencimento(loteSelecionado.dataValidade);
    if (dias < 0 || loteSelecionado.estado === 'Vencido') {
      const err = new Error(
        `Saída bloqueada: o lote [${loteSelecionado.codigoLote}] de "${produto.nome}" venceu em ${loteSelecionado.dataValidade}. Solicite a baixa de perda ao Administrador.`
      );
      err.status = 400;
      err.codigoRegra = 'RE-I';
      throw err;
    }
  }

  // Verifica se há quantidade suficiente no lote (RN-I)
  const saldoNoLote = Number(loteSelecionado.quantidadeAtual);
  if (qtd > saldoNoLote) {
    const err = new Error(
      `Quantidade indisponível: solicitado ${qtd} ${produto.unidadeMedida}, mas o lote [${loteSelecionado.codigoLote}] possui apenas ${saldoNoLote} ${produto.unidadeMedida}.`
    );
    err.status = 400;
    err.codigoRegra = 'RN-I';
    err.saldoAtual = saldoNoLote;
    throw err;
  }

  const novoSaldoLote = Number((saldoNoLote - qtd).toFixed(3));
  db.prepare('UPDATE Lote SET quantidadeAtual = ? WHERE id = ?').run(
    novoSaldoLote,
    loteSelecionado.id
  );

  const infoMov = db
    .prepare(`
      INSERT INTO Movimentacao (produtoId, loteId, tipo, quantidade, dataHora, usuarioId, observacao)
      VALUES (?, ?, 'Saida', ?, datetime('now', 'localtime'), ?, ?)
    `)
    .run(
      idProd,
      loteSelecionado.id,
      qtd,
      usuarioId,
      observacao ? String(observacao).trim() : 'Saída de estoque'
    );

  // Calcula saldo disponível restante do produto para emitir aviso de estoque baixo (RN-II)
  const lotesRestantes = db
    .prepare('SELECT * FROM Lote WHERE produtoId = ? AND quantidadeAtual > 0')
    .all(idProd);

  let saldoTotalDisponivel = 0;
  for (const l of lotesRestantes) {
    const dias =
      Number(produto.perecivel) === 1 && l.dataValidade
        ? calcularDiasParaVencimento(l.dataValidade)
        : Infinity;
    if (dias >= 0) {
      saldoTotalDisponivel += Number(l.quantidadeAtual);
    }
  }
  saldoTotalDisponivel = Number(saldoTotalDisponivel.toFixed(3));

  const avisosGerados = [];

  if (saldoTotalDisponivel <= Number(produto.estoqueMinimo)) {
    avisosGerados.push({
      tipo: 'EstoqueBaixo',
      regra: 'RN-II',
      mensagem: `Estoque baixo: "${produto.nome}" ficou com ${saldoTotalDisponivel} ${produto.unidadeMedida} (mínimo: ${produto.estoqueMinimo} ${produto.unidadeMedida}).`,
    });
  }

  if (Number(produto.perecivel) === 1 && loteSelecionado.dataValidade) {
    const diasRestantes = calcularDiasParaVencimento(loteSelecionado.dataValidade);
    if (diasRestantes >= 0 && diasRestantes <= 7) {
      avisosGerados.push({
        tipo: 'VencimentoProximo',
        regra: 'RN-III',
        mensagem: `Vencimento próximo: o lote [${loteSelecionado.codigoLote}] vence em ${diasRestantes} dia(s) (${loteSelecionado.dataValidade}).`,
      });
    }
  }

  return {
    movimentacaoId: Number(infoMov.lastInsertRowid),
    produto: {
      id: produto.id,
      nome: produto.nome,
      unidadeMedida: produto.unidadeMedida,
      estoqueMinimo: produto.estoqueMinimo,
      saldoDisponivelRestante: saldoTotalDisponivel,
    },
    lote: {
      id: loteSelecionado.id,
      codigoLote: loteSelecionado.codigoLote,
      saldoAnterior: saldoNoLote,
      quantidadeRetirada: qtd,
      saldoRestanteNoLote: novoSaldoLote,
      dataValidade: loteSelecionado.dataValidade,
    },
    avisos: avisosGerados,
  };
}

function registrarSaida(req, res) {
  const { produtoId, loteId, quantidade, observacao } = req.body || {};

  db.exec('BEGIN TRANSACTION;');
  try {
    const resultado = processarSaidaUnitaria({
      produtoId,
      loteId,
      quantidade,
      observacao,
      usuarioId: req.usuario.id,
    });
    sincronizarEstadosEAlertas();
    db.exec('COMMIT;');

    return res.status(200).json({
      mensagem: `Saída de ${resultado.lote.quantidadeRetirada} ${resultado.produto.unidadeMedida} de "${resultado.produto.nome}" (Lote ${resultado.lote.codigoLote}) registrada.`,
      ...resultado,
    });
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK;');
    return res.status(err.status || 500).json({
      erro: err.message,
      codigoRegra: err.codigoRegra || null,
      saldoAtual: err.saldoAtual !== undefined ? err.saldoAtual : undefined,
    });
  }
}

function registrarBaixaPerda(req, res) {
  const { loteId, motivo } = req.body || {};
  const idLote = Number(loteId);

  if (!idLote) {
    return res.status(400).json({ erro: 'Informe o lote para realizar a baixa de perda.' });
  }

  const lote = db
    .prepare(`
      SELECT l.*, p.nome AS produtoNome, p.unidadeMedida
      FROM Lote l
      JOIN Produto p ON p.id = l.produtoId
      WHERE l.id = ?
    `)
    .get(idLote);

  if (!lote) {
    return res.status(404).json({ erro: 'Lote não encontrado.' });
  }

  const qtdPerdida = Number(lote.quantidadeAtual);
  if (qtdPerdida <= 0) {
    return res.status(400).json({
      erro: 'Este lote já está com saldo zerado.',
    });
  }

  db.exec('BEGIN TRANSACTION;');
  try {
    db.prepare("UPDATE Lote SET quantidadeAtual = 0, estado = 'Removido' WHERE id = ?").run(idLote);

    db.prepare(`
      INSERT INTO Movimentacao (produtoId, loteId, tipo, quantidade, dataHora, usuarioId, observacao)
      VALUES (?, ?, 'Perda', ?, datetime('now', 'localtime'), ?, ?)
    `).run(
      lote.produtoId,
      idLote,
      qtdPerdida,
      req.usuario.id,
      motivo ? String(motivo).trim() : `Baixa por vencimento (validade: ${lote.dataValidade})`
    );

    sincronizarEstadosEAlertas();
    db.exec('COMMIT;');
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK;');
    return res.status(500).json({ erro: 'Erro ao registrar baixa de perda.', detalhe: err.message });
  }

  return res.status(200).json({
    mensagem: `Baixa de perda do lote [${lote.codigoLote}] (${qtdPerdida} ${lote.unidadeMedida} de "${lote.produtoNome}") concluída.`,
    loteId: idLote,
    quantidadePerdida: qtdPerdida,
    novoEstado: 'Removido',
  });
}

function operacaoEmMassa(req, res) {
  const { operacao, itens, observacaoGeral } = req.body || {};

  if (!['Entrada', 'Saida'].includes(operacao) || !Array.isArray(itens) || itens.length === 0) {
    return res.status(400).json({
      erro: 'Selecione o tipo de operação e adicione pelo menos um item.',
    });
  }

  if (operacao === 'Entrada' && req.usuario.perfil !== 'Administrador') {
    return res.status(403).json({
      erro: 'Acesso negado (HTTP 403): apenas o Administrador pode lançar entrada em massa.',
    });
  }

  const resultados = [];
  const dataHoje = new Date().toISOString().slice(0, 10);

  db.exec('BEGIN TRANSACTION;');
  try {
    for (let i = 0; i < itens.length; i++) {
      const item = itens[i];
      if (operacao === 'Saida') {
        const resSaida = processarSaidaUnitaria({
          produtoId: item.produtoId,
          loteId: item.loteId,
          quantidade: item.quantidade,
          observacao: item.observacao || observacaoGeral || 'Saída em massa',
          usuarioId: req.usuario.id,
        });
        resultados.push(resSaida);
      } else {
        const idProd = Number(item.produtoId);
        const qtd = Number(item.quantidade);
        const codLote = item.codigoLote ? String(item.codigoLote).trim() : '';

        if (!idProd || !codLote || Number.isNaN(qtd) || qtd <= 0) {
          const err = new Error(`Linha #${i + 1}: preencha produto, código do lote e quantidade.`);
          err.status = 400;
          throw err;
        }

        const prod = db.prepare('SELECT * FROM Produto WHERE id = ?').get(idProd);
        if (!prod) {
          const err = new Error(`Linha #${i + 1}: produto não encontrado.`);
          err.status = 404;
          throw err;
        }
        if (Number(prod.perecivel) === 1 && !item.dataValidade) {
          const err = new Error(`Linha #${i + 1} ("${prod.nome}"): informe a data de validade.`);
          err.status = 400;
          throw err;
        }

        const infoLote = db
          .prepare(`
            INSERT INTO Lote (produtoId, codigoLote, quantidadeAtual, dataEntrada, dataValidade, estado)
            VALUES (?, ?, ?, ?, ?, 'Disponivel')
          `)
          .run(idProd, codLote, qtd, dataHoje, item.dataValidade || null);

        const loteId = Number(infoLote.lastInsertRowid);
        db.prepare(`
          INSERT INTO Movimentacao (produtoId, loteId, tipo, quantidade, dataHora, usuarioId, observacao)
          VALUES (?, ?, 'Entrada', ?, datetime('now', 'localtime'), ?, ?)
        `).run(
          idProd,
          loteId,
          qtd,
          req.usuario.id,
          item.observacao || observacaoGeral || 'Entrada em massa'
        );

        resultados.push({
          produto: { id: prod.id, nome: prod.nome },
          lote: { id: loteId, codigoLote: codLote, quantidadeEntrada: qtd },
        });
      }
    }

    sincronizarEstadosEAlertas();
    db.exec('COMMIT;');
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK;');
    return res.status(err.status || 400).json({
      erro: err.message,
      codigoRegra: err.codigoRegra || null,
    });
  }

  return res.status(200).json({
    mensagem: `Lançamento em massa de ${operacao.toLowerCase()} concluído (${resultados.length} itens).`,
    totalProcessado: resultados.length,
    resultados,
  });
}

function listarLotes(req, res) {
  const { produtoId } = req.query || {};

  let sql = `
    SELECT l.*, p.nome AS produtoNome, p.categoria, p.unidadeMedida, p.perecivel, p.estoqueMinimo
    FROM Lote l
    JOIN Produto p ON p.id = l.produtoId
    WHERE 1=1
  `;
  const params = [];

  if (produtoId) {
    sql += ' AND l.produtoId = ?';
    params.push(Number(produtoId));
  }

  sql += `
    ORDER BY
      CASE WHEN l.quantidadeAtual > 0 THEN 0 ELSE 1 END ASC,
      CASE WHEN l.dataValidade IS NULL OR l.dataValidade = '' THEN 1 ELSE 0 END ASC,
      l.dataValidade ASC,
      l.id ASC
  `;

  const lotes = db.prepare(sql).all(...params).map((l) => ({
    ...l,
    perecivel: Boolean(l.perecivel),
    diasParaVencer:
      Number(l.perecivel) === 1 && l.dataValidade
        ? calcularDiasParaVencimento(l.dataValidade)
        : null,
  }));

  return res.status(200).json(lotes);
}

function listarAlertas(req, res) {
  const estoqueBaixo = db
    .prepare(`
      SELECT a.*, p.nome AS produtoNome, p.categoria, p.unidadeMedida, p.estoqueMinimo
      FROM Alerta a
      LEFT JOIN Produto p ON p.id = a.produtoId
      WHERE a.tipo = 'Estoque' AND a.resolvido = 0
      ORDER BY a.id DESC
    `)
    .all();

  const validade = db
    .prepare(`
      SELECT a.*, p.nome AS produtoNome, p.categoria, p.unidadeMedida,
             l.codigoLote, l.dataValidade, l.quantidadeAtual, l.estado AS estadoLote
      FROM Alerta a
      LEFT JOIN Produto p ON p.id = a.produtoId
      LEFT JOIN Lote l ON l.id = a.loteId
      WHERE a.tipo = 'Validade' AND a.resolvido = 0
      ORDER BY l.dataValidade ASC, a.id ASC
    `)
    .all();

  return res.status(200).json({
    estoqueBaixo,
    validadeProximaOuVencida: validade,
    totalAlertas: estoqueBaixo.length + validade.length,
  });
}

function listarMovimentacoes(req, res) {
  const { tipo, usuarioId, limite } = req.query || {};
  let sql = `
    SELECT m.*,
           p.nome AS produtoNome, p.categoria, p.unidadeMedida,
           l.codigoLote, l.dataValidade,
           u.nome AS usuarioNome, u.login AS usuarioLogin, u.perfil AS usuarioPerfil
    FROM Movimentacao m
    JOIN Produto p ON p.id = m.produtoId
    JOIN Lote l ON l.id = m.loteId
    JOIN Usuario u ON u.id = m.usuarioId
    WHERE 1=1
  `;
  const params = [];

  if (tipo && ['Entrada', 'Saida', 'Perda'].includes(tipo)) {
    sql += ' AND m.tipo = ?';
    params.push(tipo);
  }
  if (usuarioId) {
    sql += ' AND m.usuarioId = ?';
    params.push(Number(usuarioId));
  }

  sql += ' ORDER BY m.id DESC LIMIT ?';
  params.push(limite ? Number(limite) : 200);

  const movs = db.prepare(sql).all(...params);
  return res.status(200).json(movs);
}

module.exports = {
  registrarEntrada,
  registrarSaida,
  registrarBaixaPerda,
  operacaoEmMassa,
  listarLotes,
  listarAlertas,
  listarMovimentacoes,
};
