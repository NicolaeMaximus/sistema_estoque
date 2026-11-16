/**
 * ============================================================================
 * ECOT11A - LABORATÓRIO DE ENGENHARIA DE SOFTWARE (UNIFEI)
 * Projeto: Sistema de Controle de Estoque da Mercearia
 * Autor: Nicolae Lopes - Matrícula: 2024014650
 * ----------------------------------------------------------------------------
 * Módulo: Controlador de Estoque, Lotes, Movimentações e Alertas (src/controllers/estoqueController.js)
 * Tarefas Relacionadas:
 *   - T08: Registro de entrada com lote e validade
 *   - T09: Registro de saída com verificação de disponibilidade (RN-I / RS001)
 *   - T10: Exibição e priorização de lotes por validade mais próxima (FEFO - RN-III)
 *   - T11: Vínculo entre movimentação e funcionário, e histórico (RN-IV)
 *   - T12: Estoque mínimo por item e aviso de estoque baixo (RN-II)
 *   - T14: Ciclo de vida do lote (Disponivel, EstoqueBaixo, VencimentoProximo, Esgotado, Vencido, Removido)
 *   - T15: Aviso de vencimento próximo no login e na saída (RN-III)
 *   - T16: Bloqueio de saída de lote vencido e baixa pelo administrador (RE-I)
 *   - T17: Entrada e saída em massa de produtos (RF06)
 * ============================================================================
 */

const {
  db,
  calcularDiasParaVencimento,
  sincronizarEstadosEAlertas,
} = require('../database/db');

/**
 * Registra a entrada de um lote de produto no estoque (RF04, T08, RNF03, RN-IV).
 * Utiliza transação ACID (RNF03) para gravar o Lote e a Movimentacao simultaneamente.
 * Rota: POST /api/estoque/entrada
 */
function registrarEntrada(req, res) {
  const { produtoId, codigoLote, quantidade, dataValidade, observacao } = req.body || {};

  const idProd = Number(produtoId);
  const qtd = Number(quantidade);

  if (!idProd || !codigoLote || Number.isNaN(qtd) || qtd <= 0) {
    return res.status(400).json({
      erro: 'Informe produtoId válido, código do lote e uma quantidade maior que zero.',
    });
  }

  const produto = db.prepare('SELECT * FROM Produto WHERE id = ?').get(idProd);
  if (!produto) {
    return res.status(404).json({ erro: 'Produto não encontrado.' });
  }

  // Se o produto é perecível (RE-I), exige data de validade do lote
  if (Number(produto.perecivel) === 1 && (!dataValidade || String(dataValidade).trim() === '')) {
    return res.status(400).json({
      erro: `O produto "${produto.nome}" é perecível (RE-I). Informe obrigatoriamente a data de validade do lote.`,
    });
  }

  const dataEntrada = new Date().toISOString().slice(0, 10);
  const validadeFinal =
    dataValidade && String(dataValidade).trim() !== '' ? String(dataValidade).trim() : null;

  db.exec('BEGIN TRANSACTION;');
  try {
    // Verifica se já existe um lote com o mesmo código para este produto
    const loteExistente = db
      .prepare('SELECT * FROM Lote WHERE produtoId = ? AND codigoLote = ?')
      .get(idProd, String(codigoLote).trim());

    let loteId;
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
        .run(idProd, String(codigoLote).trim(), qtd, dataEntrada, validadeFinal);
      loteId = Number(infoLote.lastInsertRowid);
    }

    // Registra a movimentação associada ao usuário logado (RN-IV)
    db.prepare(`
      INSERT INTO Movimentacao (produtoId, loteId, tipo, quantidade, dataHora, usuarioId, observacao)
      VALUES (?, ?, 'Entrada', ?, datetime('now', 'localtime'), ?, ?)
    `).run(
      idProd,
      loteId,
      qtd,
      req.usuario.id,
      observacao ? String(observacao).trim() : 'Entrada de mercadoria'
    );

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    return res.status(500).json({
      erro: 'Falha na transação de entrada no banco de dados (RNF03).',
      detalhe: err.message,
    });
  }

  sincronizarEstadosEAlertas();

  const loteAtualizado = db.prepare('SELECT * FROM Lote WHERE id = ?').get(
    db
      .prepare('SELECT id FROM Lote WHERE produtoId = ? AND codigoLote = ?')
      .get(idProd, String(codigoLote).trim()).id
  );

  return res.status(201).json({
    mensagem: `Entrada de ${qtd} ${produto.unidadeMedida} de "${produto.nome}" (Lote ${codigoLote}) registrada com sucesso.`,
    lote: loteAtualizado,
  });
}

/**
 * Executa a validação e a lógica de negócio do Caso de Uso RS001 (Registro de Saída de Produto).
 * Pode ser chamada isoladamente ou dentro de uma operação em massa (RF06).
 *
 * Regras verificadas:
 *   - RE-I / T16 / CT04: Bloqueia saída comum de lote vencido
 *   - RN-I / RS001 / CT02: Bloqueia saída maior do que o saldo disponível
 *   - RN-III / CT03: Seleciona/prioriza lote por FEFO (validade mais próxima primeiro)
 *   - RN-IV / CT05: Associa a saída ao funcionário logado
 *   - RN-II / CT05: Verifica se o saldo restante atingiu o estoque mínimo e retorna avisos
 */
function processarSaidaUnitaria({ produtoId, loteId, quantidade, observacao, usuarioId }) {
  const idProd = Number(produtoId);
  const qtd = Number(quantidade);

  if (!idProd || Number.isNaN(qtd) || qtd <= 0) {
    const err = new Error('Informe um produto válido e uma quantidade de saída maior que zero.');
    err.status = 400;
    throw err;
  }

  const produto = db.prepare('SELECT * FROM Produto WHERE id = ?').get(idProd);
  if (!produto) {
    const err = new Error('Produto não encontrado no estoque.');
    err.status = 404;
    throw err;
  }

  let loteSelecionado = null;

  if (loteId) {
    loteSelecionado = db
      .prepare('SELECT * FROM Lote WHERE id = ? AND produtoId = ?')
      .get(Number(loteId), idProd);
    if (!loteSelecionado) {
      const err = new Error('Lote informado não pertence ao produto selecionado.');
      err.status = 404;
      throw err;
    }
  } else {
    // Seleção automática pelo critério FEFO (First Expired, First Out - RN-III)
    loteSelecionado = db
      .prepare(`
        SELECT *
        FROM Lote
        WHERE produtoId = ? AND quantidadeAtual > 0
        ORDER BY
          CASE WHEN dataValidade IS NULL OR dataValidade = '' THEN 1 ELSE 0 END ASC,
          dataValidade ASC,
          id ASC
        LIMIT 1
      `)
      .get(idProd);

    if (!loteSelecionado) {
      const err = new Error(
        `Quantidade indisponível em estoque (RN-I): O produto "${produto.nome}" possui saldo disponível 0 ${produto.unidadeMedida}.`
      );
      err.status = 400;
      err.saldoAtual = 0;
      throw err;
    }
  }

  // Verifica se o lote selecionado está VENCIDO (RE-I, T16, CT04)
  if (Number(produto.perecivel) === 1 && loteSelecionado.dataValidade) {
    const dias = calcularDiasParaVencimento(loteSelecionado.dataValidade);
    if (dias < 0 || loteSelecionado.estado === 'Vencido') {
      const err = new Error(
        `Saída bloqueada (RE-I / CT04): O lote [${loteSelecionado.codigoLote}] de "${produto.nome}" está VENCIDO (validade: ${loteSelecionado.dataValidade}). Apenas o Administrador pode realizar a baixa de perda.`
      );
      err.status = 400;
      err.codigoRegra = 'RE-I';
      throw err;
    }
  }

  // Verifica disponibilidade de saldo no lote (RN-I, RS001, CT02)
  const saldoNoLote = Number(loteSelecionado.quantidadeAtual);
  if (qtd > saldoNoLote) {
    const err = new Error(
      `Quantidade indisponível em estoque (RN-I / CT02): Solicitado ${qtd} ${produto.unidadeMedida}, mas o lote [${loteSelecionado.codigoLote}] possui saldo atual de apenas ${saldoNoLote} ${produto.unidadeMedida}.`
    );
    err.status = 400;
    err.codigoRegra = 'RN-I';
    err.saldoAtual = saldoNoLote;
    throw err;
  }

  // Debita a quantidade do lote (Método Lote.debitar(qtd) do Diagrama de Sequência - Seção 6.3)
  const novoSaldoLote = Number((saldoNoLote - qtd).toFixed(3));
  db.prepare('UPDATE Lote SET quantidadeAtual = ? WHERE id = ?').run(
    novoSaldoLote,
    loteSelecionado.id
  );

  // Grava a Movimentacao associada ao funcionário que a realizou (RN-IV)
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
      observacao ? String(observacao).trim() : 'Saída de estoque (venda/reposição)'
    );

  // Calcula saldo total disponível restante do produto para verificar RN-II (Estoque Baixo)
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

  // Passo 6 do Caso de Uso RS001: Aviso de Estoque Baixo (RN-II / CT05)
  if (saldoTotalDisponivel <= Number(produto.estoqueMinimo)) {
    avisosGerados.push({
      tipo: 'EstoqueBaixo',
      regra: 'RN-II',
      mensagem: `Aviso de Estoque Baixo: "${produto.nome}" ficou com saldo disponível de ${saldoTotalDisponivel} ${produto.unidadeMedida} (Mínimo configurado: ${produto.estoqueMinimo} ${produto.unidadeMedida}).`,
    });
  }

  // Alternativa 2 do Caso de Uso RS001: Aviso de Vencimento Próximo (RN-III / CT03)
  if (Number(produto.perecivel) === 1 && loteSelecionado.dataValidade) {
    const diasRestantes = calcularDiasParaVencimento(loteSelecionado.dataValidade);
    if (diasRestantes >= 0 && diasRestantes <= 7) {
      avisosGerados.push({
        tipo: 'VencimentoProximo',
        regra: 'RN-III',
        mensagem: `Aviso de Vencimento Próximo: O lote [${loteSelecionado.codigoLote}] de "${produto.nome}" vence em ${diasRestantes} dia(s) (${loteSelecionado.dataValidade}).`,
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

/**
 * Rota principal do Caso de Uso RS001: Registro de saída de produto do estoque (RF05).
 * Rota: POST /api/estoque/saida
 */
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
    db.exec('COMMIT;');
    sincronizarEstadosEAlertas();

    return res.status(200).json({
      mensagem: `Saída de ${resultado.lote.quantidadeRetirada} ${resultado.produto.unidadeMedida} de "${resultado.produto.nome}" (Lote ${resultado.lote.codigoLote}) registrada com sucesso por ${req.usuario.nome}.`,
      ...resultado,
    });
  } catch (err) {
    db.exec('ROLLBACK;');
    const status = err.status || 500;
    return res.status(status).json({
      erro: err.message,
      codigoRegra: err.codigoRegra || null,
      saldoAtual: err.saldoAtual !== undefined ? err.saldoAtual : undefined,
    });
  }
}

/**
 * Registra a baixa de perda de um lote vencido ou avariado (Exclusivo Administrador - RE-I, T16, CT04).
 * Atualiza o estado do lote para 'Removido' conforme o Diagrama de Estados (Seção 6.4) e grava Movimentacao de 'Perda'.
 * Rota: POST /api/estoque/perda
 */
function registrarBaixaPerda(req, res) {
  const { loteId, motivo } = req.body || {};
  const idLote = Number(loteId);

  if (!idLote) {
    return res.status(400).json({ erro: 'Informe o loteId para realizar a baixa de perda.' });
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
      erro: 'Este lote já possui quantidade zero e não pode sofrer nova baixa de perda.',
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
      motivo ? String(motivo).trim() : `Baixa de perda por vencimento (Validade: ${lote.dataValidade})`
    );

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    return res.status(500).json({ erro: 'Erro ao registrar baixa de perda.', detalhe: err.message });
  }

  sincronizarEstadosEAlertas();

  return res.status(200).json({
    mensagem: `Baixa de perda do lote [${lote.codigoLote}] (${qtdPerdida} ${lote.unidadeMedida} de "${lote.produtoNome}") registrada pelo Administrador.`,
    loteId: idLote,
    quantidadePerdida: qtdPerdida,
    novoEstado: 'Removido',
  });
}

/**
 * Permite lançar entradas ou saídas de múltiplos produtos/lotes em uma única operação transacional (RF06, T17, RNF03).
 * Rota: POST /api/estoque/massa
 */
function operacaoEmMassa(req, res) {
  const { operacao, itens, observacaoGeral } = req.body || {};

  if (!['Entrada', 'Saida'].includes(operacao) || !Array.isArray(itens) || itens.length === 0) {
    return res.status(400).json({
      erro: 'Informe o tipo de operacao ("Entrada" ou "Saida") e uma lista não vazia de itens.',
    });
  }

  // Somente Administrador pode lançar Entrada em massa; Funcionário e Administrador podem lançar Saída em massa
  if (operacao === 'Entrada' && req.usuario.perfil !== 'Administrador') {
    return res.status(403).json({
      erro: 'Acesso negado (HTTP 403): Apenas o Administrador pode registrar entrada em massa de lotes.',
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
          observacao: item.observacao || observacaoGeral || 'Saída em massa (RF06)',
          usuarioId: req.usuario.id,
        });
        resultados.push(resSaida);
      } else {
        // Entrada em massa
        const idProd = Number(item.produtoId);
        const qtd = Number(item.quantidade);
        const codLote = item.codigoLote ? String(item.codigoLote).trim() : '';

        if (!idProd || !codLote || Number.isNaN(qtd) || qtd <= 0) {
          const err = new Error(
            `Item #${i + 1} inválido: informe produtoId, codigoLote e quantidade > 0.`
          );
          err.status = 400;
          throw err;
        }

        const prod = db.prepare('SELECT * FROM Produto WHERE id = ?').get(idProd);
        if (!prod) {
          const err = new Error(`Item #${i + 1}: Produto ID ${idProd} não encontrado.`);
          err.status = 404;
          throw err;
        }
        if (Number(prod.perecivel) === 1 && !item.dataValidade) {
          const err = new Error(
            `Item #${i + 1} ("${prod.nome}"): Produto perecível exige data de validade.`
          );
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
          item.observacao || observacaoGeral || 'Entrada em massa (RF06)'
        );

        resultados.push({
          produto: { id: prod.id, nome: prod.nome },
          lote: { id: loteId, codigoLote: codLote, quantidadeEntrada: qtd },
        });
      }
    }

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    return res.status(err.status || 400).json({
      erro: err.message,
      codigoRegra: err.codigoRegra || null,
    });
  }

  sincronizarEstadosEAlertas();

  return res.status(200).json({
    mensagem: `Operação em massa de ${operacao} concluída com sucesso (${resultados.length} itens processados).`,
    totalProcessado: resultados.length,
    resultados,
  });
}

/**
 * Lista todos os lotes cadastrados ordenados por validade FEFO (RN-III, T10, T14).
 * Rota: GET /api/lotes
 */
function listarLotes(req, res) {
  sincronizarEstadosEAlertas();
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

  // Ordenação FEFO (First Expired, First Out - RN-III): lotes com validade mais próxima aparecem primeiro
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

/**
 * Retorna os alertas ativos separados em "estoqueBaixo" e "validadeProximaOuVencida" (RF07, RNF04).
 * Rota: GET /api/alertas
 */
function listarAlertas(req, res) {
  sincronizarEstadosEAlertas();

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

/**
 * Lista o histórico de movimentações com o nome e perfil do funcionário que a realizou (RN-IV, T11).
 * Rota: GET /api/movimentacoes
 */
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

  sql += ' ORDER BY m.id DESC';
  if (limite) {
    sql += ' LIMIT ?';
    params.push(Number(limite));
  } else {
    sql += ' LIMIT 200';
  }

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
