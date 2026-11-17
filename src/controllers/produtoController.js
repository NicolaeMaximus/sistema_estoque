// Cadastro, consulta e atualização de produtos e seus lotes
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

// Monta o objeto do produto com saldos calculados e lotes ordenados por validade (FEFO)
function montarProdutoComLotes(produto, lotesDoProduto) {
  let saldoDisponivel = 0;
  let saldoVencido = 0;
  let proximoVencimento = null;

  const lotesEnriquecidos = lotesDoProduto.map((l) => {
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

  return {
    ...produto,
    perecivel: Boolean(produto.perecivel),
    saldoDisponivel: Number(saldoDisponivel.toFixed(3)),
    saldoVencido: Number(saldoVencido.toFixed(3)),
    saldoTotalFisico: Number((saldoDisponivel + saldoVencido).toFixed(3)),
    estoqueBaixo: saldoDisponivel <= Number(produto.estoqueMinimo),
    proximoVencimento,
    lotes: lotesEnriquecidos,
  };
}

// Busca todos os lotes de uma só vez (evita N+1 queries) e agrupa por produtoId ordenando por FEFO
function buscarLotesAgrupados() {
  const todosLotes = db
    .prepare(`
      SELECT *
      FROM Lote
      ORDER BY
        CASE WHEN quantidadeAtual > 0 THEN 0 ELSE 1 END ASC,
        CASE WHEN dataValidade IS NULL OR dataValidade = '' THEN 1 ELSE 0 END ASC,
        dataValidade ASC,
        id ASC
    `)
    .all();

  const mapa = new Map();
  for (const lote of todosLotes) {
    if (!mapa.has(lote.produtoId)) {
      mapa.set(lote.produtoId, []);
    }
    mapa.get(lote.produtoId).push(lote);
  }
  return mapa;
}

function listarProdutos(req, res) {
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
  const lotesPorProduto = buscarLotesAgrupados();

  const resultado = produtos.map((p) =>
    montarProdutoComLotes(p, lotesPorProduto.get(p.id) || [])
  );

  return res.status(200).json(resultado);
}

function obterProdutoPorId(req, res) {
  const id = Number(req.params.id);
  const produto = db.prepare('SELECT * FROM Produto WHERE id = ?').get(id);
  if (!produto) {
    return res.status(404).json({ erro: 'Produto não encontrado.' });
  }
  const lotes = db
    .prepare(`
      SELECT * FROM Lote
      WHERE produtoId = ?
      ORDER BY
        CASE WHEN quantidadeAtual > 0 THEN 0 ELSE 1 END ASC,
        CASE WHEN dataValidade IS NULL OR dataValidade = '' THEN 1 ELSE 0 END ASC,
        dataValidade ASC,
        id ASC
    `)
    .all(id);

  return res.status(200).json(montarProdutoComLotes(produto, lotes));
}

function cadastrarProduto(req, res) {
  const { nome, categoria, unidadeMedida, precoVenda, perecivel, estoqueMinimo } = req.body || {};

  if (!nome || !categoria || !unidadeMedida || precoVenda === undefined) {
    return res.status(400).json({
      erro: 'Preencha nome, categoria, unidade de medida e preço de venda.',
    });
  }

  if (!CATEGORIAS_VALIDAS.includes(categoria)) {
    return res.status(400).json({
      erro: `Categoria inválida. Use: ${CATEGORIAS_VALIDAS.join(', ')}.`,
    });
  }

  if (!UNIDADES_VALIDAS.includes(unidadeMedida)) {
    return res.status(400).json({
      erro: `Unidade inválida. Use: ${UNIDADES_VALIDAS.join(', ')}.`,
    });
  }

  const preco = Number(precoVenda);
  const minimo = estoqueMinimo !== undefined ? Number(estoqueMinimo) : 0;
  if (Number.isNaN(preco) || preco < 0 || Number.isNaN(minimo) || minimo < 0) {
    return res.status(400).json({
      erro: 'Preço e estoque mínimo devem ser valores maiores ou iguais a zero.',
    });
  }

  const info = db
    .prepare(`
      INSERT INTO Produto (nome, categoria, unidadeMedida, precoVenda, perecivel, estoqueMinimo)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(String(nome).trim(), categoria, unidadeMedida, preco, perecivel ? 1 : 0, minimo);

  sincronizarEstadosEAlertas();

  const novoId = Number(info.lastInsertRowid);
  const novoProduto = db.prepare('SELECT * FROM Produto WHERE id = ?').get(novoId);

  return res.status(201).json({
    mensagem: 'Produto cadastrado com sucesso.',
    produto: montarProdutoComLotes(novoProduto, []),
  });
}

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

  if (!CATEGORIAS_VALIDAS.includes(novaCategoria) || !UNIDADES_VALIDAS.includes(novaUnidade)) {
    return res.status(400).json({ erro: 'Categoria ou unidade de medida inválida.' });
  }
  if (Number.isNaN(novoPreco) || novoPreco < 0 || Number.isNaN(novoMinimo) || novoMinimo < 0) {
    return res.status(400).json({ erro: 'Valores numéricos inválidos.' });
  }

  db.prepare(`
    UPDATE Produto
    SET nome = ?, categoria = ?, unidadeMedida = ?, precoVenda = ?, perecivel = ?, estoqueMinimo = ?
    WHERE id = ?
  `).run(novoNome, novaCategoria, novaUnidade, novoPreco, novoPerecivel, novoMinimo, id);

  sincronizarEstadosEAlertas();

  const atualizado = db.prepare('SELECT * FROM Produto WHERE id = ?').get(id);
  const lotes = db.prepare('SELECT * FROM Lote WHERE produtoId = ? ORDER BY dataValidade ASC').all(id);

  return res.status(200).json({
    mensagem: 'Produto atualizado com sucesso.',
    produto: montarProdutoComLotes(atualizado, lotes),
  });
}

function removerProduto(req, res) {
  const id = Number(req.params.id);
  const produto = db.prepare('SELECT * FROM Produto WHERE id = ?').get(id);

  if (!produto) {
    return res.status(404).json({ erro: 'Produto não encontrado.' });
  }

  db.prepare('DELETE FROM Produto WHERE id = ?').run(id);
  sincronizarEstadosEAlertas();

  return res.status(200).json({
    mensagem: `Produto "${produto.nome}" removido.`,
  });
}

module.exports = {
  CATEGORIAS_VALIDAS,
  UNIDADES_VALIDAS,
  listarProdutos,
  obterProdutoPorId,
  cadastrarProduto,
  editarProduto,
  removerProduto,
};
