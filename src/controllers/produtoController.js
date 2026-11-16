/**
 * ============================================================================
 * ECOT11A - LABORATÓRIO DE ENGENHARIA DE SOFTWARE (UNIFEI)
 * Projeto: Sistema de Controle de Estoque da Mercearia
 * Autor: Nicolae Lopes - Matrícula: 2024014650
 * ----------------------------------------------------------------------------
 * Módulo: Controlador de Produtos (src/controllers/produtoController.js)
 * Tarefas Relacionadas:
 *   - T05: CRUD de produtos (categoria, unidade, perecível, estoque mínimo)
 *   - T06: Tela de consulta da lista de produtos
 *   - T10: Exibição de lotes por validade mais próxima (perecíveis - FEFO)
 * Requisitos Atendidos:
 *   - RF03: Cadastro, edição, listagem e remoção de produtos
 *   - RN-II: Estoque mínimo configurado por item pelo Administrador
 *   - RN-III: Ordenação de lotes pela validade mais próxima (FEFO)
 * ============================================================================
 */

const {
  db,
  calcularDiasParaVencimento,
  sincronizarEstadosEAlertas,
} = require('../database/db');

const CATEGORIAS_VALIDAS = [
  'Mercearia Seca',
  'Laticínios e Frios',
  'Hortifrúti',
  'Bebidas',
  'Limpeza e Higiene',
];

const UNIDADES_VALIDAS = ['unidade', 'quilo', 'litro', 'caixa'];

/**
 * Monta os dados detalhados de um produto aplicando os métodos da classe Produto (Seção 6.2):
 *   - calcularSaldo(): soma a quantidade disponível nos lotes válidos (não vencidos)
 *   - verificarEstoqueBaixo(): verifica se saldoDisponivel <= estoqueMinimo (RN-II)
 *   - listarLotesPorValidade(): retorna os lotes ordenados pela validade mais próxima (FEFO - RN-III)
 */
function enriquecerProduto(produto) {
  const lotes = db
    .prepare(`
      SELECT *
      FROM Lote
      WHERE produtoId = ?
      ORDER BY
        CASE WHEN quantidadeAtual > 0 THEN 0 ELSE 1 END ASC,
        CASE WHEN dataValidade IS NULL OR dataValidade = '' THEN 1 ELSE 0 END ASC,
        dataValidade ASC,
        id ASC
    `)
    .all(produto.id);

  let saldoDisponivel = 0;
  let saldoVencido = 0;
  let proximoVencimento = null;

  const lotesEnriquecidos = lotes.map((l) => {
    const diasParaVencer =
      Number(produto.perecivel) === 1 && l.dataValidade
        ? calcularDiasParaVencimento(l.dataValidade)
        : null;

    const vencido = diasParaVencer !== null && diasParaVencer < 0;
    const vencimentoProximo = diasParaVencer !== null && diasParaVencer >= 0 && diasParaVencer <= 7;

    if (Number(l.quantidadeAtual) > 0) {
      if (vencido) {
        saldoVencido += Number(l.quantidadeAtual);
      } else {
        saldoDisponivel += Number(l.quantidadeAtual);
        if (l.dataValidade && (!proximoVencimento || l.dataValidade < proximoVencimento)) {
          proximoVencimento = l.dataValidade;
        }
      }
    }

    return {
      ...l,
      diasParaVencer,
      vencido,
      vencimentoProximo,
    };
  });

  const estoqueBaixo = saldoDisponivel <= Number(produto.estoqueMinimo);

  return {
    ...produto,
    perecivel: Boolean(produto.perecivel),
    saldoDisponivel: Number(saldoDisponivel.toFixed(3)),
    saldoVencido: Number(saldoVencido.toFixed(3)),
    saldoTotalFisico: Number((saldoDisponivel + saldoVencido).toFixed(3)),
    estoqueBaixo,
    proximoVencimento,
    lotes: lotesEnriquecidos,
  };
}

/**
 * Lista todos os produtos cadastrados com seus lotes ordenados por FEFO (RF03, T06, T10).
 * Rota: GET /api/produtos
 */
function listarProdutos(req, res) {
  sincronizarEstadosEAlertas();

  const { categoria, busca } = req.query || {};
  let sql = 'SELECT * FROM Produto WHERE 1=1';
  const params = [];

  if (categoria && CATEGORIAS_VALIDAS.includes(categoria)) {
    sql += ' AND categoria = ?';
    params.push(categoria);
  }
  if (busca && String(busca).trim() !== '') {
    sql += ' AND LOWER(nome) LIKE ?';
    params.push(`%${String(busca).trim().toLowerCase()}%`);
  }

  sql += ' ORDER BY categoria ASC, nome ASC';
  const produtos = db.prepare(sql).all(...params);
  const resultado = produtos.map(enriquecerProduto);

  return res.status(200).json(resultado);
}

/**
 * Obtém os detalhes de um produto específico e seus lotes ordenados por validade (FEFO - RN-III).
 * Rota: GET /api/produtos/:id
 */
function obterProdutoPorId(req, res) {
  const id = Number(req.params.id);
  const produto = db.prepare('SELECT * FROM Produto WHERE id = ?').get(id);
  if (!produto) {
    return res.status(404).json({ erro: 'Produto não encontrado.' });
  }
  return res.status(200).json(enriquecerProduto(produto));
}

/**
 * Cadastra um novo produto no catálogo (Exclusivo Administrador - RF03, T05, CT01).
 * Rota: POST /api/produtos
 */
function cadastrarProduto(req, res) {
  const { nome, categoria, unidadeMedida, precoVenda, perecivel, estoqueMinimo } = req.body || {};

  if (!nome || !categoria || !unidadeMedida || precoVenda === undefined) {
    return res.status(400).json({
      erro: 'Campos obrigatórios: nome, categoria, unidadeMedida e precoVenda.',
    });
  }

  if (!CATEGORIAS_VALIDAS.includes(categoria)) {
    return res.status(400).json({
      erro: `Categoria inválida. Escolha entre: ${CATEGORIAS_VALIDAS.join(', ')}.`,
    });
  }

  if (!UNIDADES_VALIDAS.includes(unidadeMedida)) {
    return res.status(400).json({
      erro: `Unidade de medida inválida. Escolha entre: ${UNIDADES_VALIDAS.join(', ')}.`,
    });
  }

  const preco = Number(precoVenda);
  const minimo = estoqueMinimo !== undefined ? Number(estoqueMinimo) : 0;
  if (Number.isNaN(preco) || preco < 0 || Number.isNaN(minimo) || minimo < 0) {
    return res.status(400).json({
      erro: 'Preço de venda e estoque mínimo devem ser valores numéricos não negativos.',
    });
  }

  const flagPerecivel = perecivel ? 1 : 0;

  const info = db
    .prepare(`
      INSERT INTO Produto (nome, categoria, unidadeMedida, precoVenda, perecivel, estoqueMinimo)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(String(nome).trim(), categoria, unidadeMedida, preco, flagPerecivel, minimo);

  sincronizarEstadosEAlertas();

  const novoProduto = db
    .prepare('SELECT * FROM Produto WHERE id = ?')
    .get(Number(info.lastInsertRowid));

  return res.status(201).json({
    mensagem: 'Produto cadastrado com sucesso.',
    produto: enriquecerProduto(novoProduto),
  });
}

/**
 * Edita os dados de um produto existente, incluindo preço e estoque mínimo (RF03, RN-II, T05).
 * Rota: PUT /api/produtos/:id
 */
function editarProduto(req, res) {
  const id = Number(req.params.id);
  const produto = db.prepare('SELECT * FROM Produto WHERE id = ?').get(id);

  if (!produto) {
    return res.status(404).json({ erro: 'Produto não encontrado.' });
  }

  const { nome, categoria, unidadeMedida, precoVenda, perecivel, estoqueMinimo } = req.body || {};

  const novoNome = nome !== undefined ? String(nome).trim() : produto.nome;
  const novaCategoria = categoria !== undefined ? categoria : produto.categoria;
  const novaUnidade = unidadeMedida !== undefined ? unidadeMedida : produto.unidadeMedida;
  const novoPreco = precoVenda !== undefined ? Number(precoVenda) : Number(produto.precoVenda);
  const novoPerecivel =
    perecivel !== undefined ? (perecivel ? 1 : 0) : Number(produto.perecivel);
  const novoMinimo =
    estoqueMinimo !== undefined ? Number(estoqueMinimo) : Number(produto.estoqueMinimo);

  if (!CATEGORIAS_VALIDAS.includes(novaCategoria)) {
    return res.status(400).json({ erro: 'Categoria inválida.' });
  }
  if (!UNIDADES_VALIDAS.includes(novaUnidade)) {
    return res.status(400).json({ erro: 'Unidade de medida inválida.' });
  }
  if (Number.isNaN(novoPreco) || novoPreco < 0 || Number.isNaN(novoMinimo) || novoMinimo < 0) {
    return res.status(400).json({ erro: 'Preço e estoque mínimo devem ser valores válidos >= 0.' });
  }

  db.prepare(`
    UPDATE Produto
    SET nome = ?, categoria = ?, unidadeMedida = ?, precoVenda = ?, perecivel = ?, estoqueMinimo = ?
    WHERE id = ?
  `).run(novoNome, novaCategoria, novaUnidade, novoPreco, novoPerecivel, novoMinimo, id);

  sincronizarEstadosEAlertas();

  const atualizado = db.prepare('SELECT * FROM Produto WHERE id = ?').get(id);
  return res.status(200).json({
    mensagem: 'Produto atualizado com sucesso.',
    produto: enriquecerProduto(atualizado),
  });
}

/**
 * Exclui um produto do cadastro (Exclusivo Administrador - RF03, T05).
 * Rota: DELETE /api/produtos/:id
 */
function removerProduto(req, res) {
  const id = Number(req.params.id);
  const produto = db.prepare('SELECT * FROM Produto WHERE id = ?').get(id);

  if (!produto) {
    return res.status(404).json({ erro: 'Produto não encontrado.' });
  }

  db.prepare('DELETE FROM Produto WHERE id = ?').run(id);
  sincronizarEstadosEAlertas();

  return res.status(200).json({
    mensagem: `Produto "${produto.nome}" removido com sucesso.`,
  });
}

module.exports = {
  CATEGORIAS_VALIDAS,
  UNIDADES_VALIDAS,
  enriquecerProduto,
  listarProdutos,
  obterProdutoPorId,
  cadastrarProduto,
  editarProduto,
  removerProduto,
};
