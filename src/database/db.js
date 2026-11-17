// Banco de dados SQLite e funções auxiliares de estoque e validade
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'estoque.db');
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA journal_mode = WAL;');

// Gera hash da senha usando scrypt + SHA-256 (módulo nativo crypto)
function gerarHashSenha(senha) {
  const salt = 'mercearia_ecot11a_salt';
  const derivado = crypto.scryptSync(String(senha), salt, 32);
  const hash = crypto.createHash('sha256').update(derivado).digest('hex');
  return `scrypt_sha256$${hash}`;
}

function verificarSenha(senha, senhaHash) {
  if (!senhaHash) return false;
  const calculado = Buffer.from(gerarHashSenha(senha));
  const armazenado = Buffer.from(String(senhaHash));
  if (calculado.length !== armazenado.length) return false;
  return crypto.timingSafeEqual(calculado, armazenado);
}

// Retorna quantos dias faltam para a data de validade (negativo se já venceu)
function calcularDiasParaVencimento(dataValidade) {
  if (!dataValidade) return Infinity;
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);

  const partes = String(dataValidade).split('-').map(Number);
  if (partes.length !== 3) return Infinity;

  const validade = new Date(partes[0], partes[1] - 1, partes[2]);
  validade.setHours(0, 0, 0, 0);

  return Math.round((validade.getTime() - hoje.getTime()) / 86400000);
}

// Define o estado do lote conforme o ciclo de vida (Disponivel, EstoqueBaixo, VencimentoProximo, Esgotado, Vencido)
function calcularEstadoLote(lote, produto) {
  const qtd = Number(lote.quantidadeAtual || 0);
  if (qtd <= 0) return 'Esgotado';

  if (produto && Number(produto.perecivel) === 1 && lote.dataValidade) {
    const dias = calcularDiasParaVencimento(lote.dataValidade);
    if (dias < 0) return 'Vencido';
    if (dias <= 7) return 'VencimentoProximo';
  }

  const min = produto ? Number(produto.estoqueMinimo || 0) : 0;
  if (qtd <= min) return 'EstoqueBaixo';

  return 'Disponivel';
}

// Atualiza estados dos lotes e recria os alertas ativos em uma única transação
function sincronizarEstadosEAlertas() {
  const produtos = db.prepare('SELECT * FROM Produto').all();
  const lotes = db.prepare('SELECT * FROM Lote').all();
  const mapaProdutos = new Map(produtos.map((p) => [p.id, p]));

  const lotesPorProduto = new Map();
  for (const l of lotes) {
    if (!lotesPorProduto.has(l.produtoId)) {
      lotesPorProduto.set(l.produtoId, []);
    }
    lotesPorProduto.get(l.produtoId).push(l);
  }

  const deveIniciarTransacao = !db.isTransaction;
  if (deveIniciarTransacao) db.exec('BEGIN TRANSACTION;');

  try {
    const stmtUpdateLote = db.prepare('UPDATE Lote SET estado = ? WHERE id = ?');

    for (const lote of lotes) {
      if (lote.estado === 'Removido' && Number(lote.quantidadeAtual) === 0) {
        continue;
      }
      const prod = mapaProdutos.get(lote.produtoId);
      const novoEstado = calcularEstadoLote(lote, prod);
      if (novoEstado !== lote.estado) {
        stmtUpdateLote.run(novoEstado, lote.id);
        lote.estado = novoEstado;
      }
    }

    db.exec('DELETE FROM Alerta WHERE resolvido = 0;');
    const stmtInsertAlerta = db.prepare(`
      INSERT INTO Alerta (produtoId, loteId, tipo, mensagem, dataGeracao, resolvido)
      VALUES (?, ?, ?, ?, datetime('now', 'localtime'), 0)
    `);

    // Alertas de estoque baixo por produto
    for (const prod of produtos) {
      const lista = lotesPorProduto.get(prod.id) || [];
      let saldoDisponivel = 0;

      for (const l of lista) {
        if (Number(l.quantidadeAtual) > 0 && l.estado !== 'Vencido') {
          saldoDisponivel += Number(l.quantidadeAtual);
        }
      }

      if (saldoDisponivel <= Number(prod.estoqueMinimo)) {
        const msg =
          saldoDisponivel === 0
            ? `Sem estoque disponível para "${prod.nome}" (mínimo: ${prod.estoqueMinimo} ${prod.unidadeMedida}).`
            : `Saldo baixo para "${prod.nome}": ${saldoDisponivel} ${prod.unidadeMedida} disponíveis (mínimo: ${prod.estoqueMinimo} ${prod.unidadeMedida}).`;
        stmtInsertAlerta.run(prod.id, null, 'Estoque', msg);
      }
    }

    // Alertas de validade próxima ou vencida (ordenados por FEFO)
    const lotesPereciveis = lotes
      .filter((l) => {
        const p = mapaProdutos.get(l.produtoId);
        return p && Number(p.perecivel) === 1 && Number(l.quantidadeAtual) > 0 && l.dataValidade;
      })
      .sort((a, b) => String(a.dataValidade).localeCompare(String(b.dataValidade)));

    for (const l of lotesPereciveis) {
      const prod = mapaProdutos.get(l.produtoId);
      const dias = calcularDiasParaVencimento(l.dataValidade);

      if (dias < 0) {
        stmtInsertAlerta.run(
          l.produtoId,
          l.id,
          'Validade',
          `Lote vencido [${l.codigoLote}] de "${prod.nome}" (${l.quantidadeAtual} ${prod.unidadeMedida}) — venceu em ${l.dataValidade}.`
        );
      } else if (dias <= 7) {
        stmtInsertAlerta.run(
          l.produtoId,
          l.id,
          'Validade',
          `Vence ${dias === 0 ? 'hoje' : `em ${dias} dia(s)`}: Lote [${l.codigoLote}] de "${prod.nome}" (${l.quantidadeAtual} ${prod.unidadeMedida}) — validade ${l.dataValidade}.`
        );
      }
    }

    if (deveIniciarTransacao) db.exec('COMMIT;');
  } catch (err) {
    if (deveIniciarTransacao && db.isTransaction) db.exec('ROLLBACK;');
    throw err;
  }
}

function inicializarBanco() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS Usuario (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      login TEXT NOT NULL UNIQUE,
      senhaHash TEXT NOT NULL,
      perfil TEXT NOT NULL CHECK (perfil IN ('Administrador', 'Funcionario'))
    );

    CREATE TABLE IF NOT EXISTS Produto (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      categoria TEXT NOT NULL CHECK (categoria IN (
        'Mercearia Seca',
        'Laticínios e Frios',
        'Hortifrúti',
        'Bebidas',
        'Limpeza e Higiene'
      )),
      unidadeMedida TEXT NOT NULL CHECK (unidadeMedida IN (
        'unidade',
        'quilo',
        'litro',
        'caixa'
      )),
      precoVenda REAL NOT NULL CHECK (precoVenda >= 0),
      perecivel INTEGER NOT NULL DEFAULT 0 CHECK (perecivel IN (0, 1)),
      estoqueMinimo REAL NOT NULL DEFAULT 0 CHECK (estoqueMinimo >= 0)
    );

    CREATE TABLE IF NOT EXISTS Lote (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produtoId INTEGER NOT NULL,
      codigoLote TEXT NOT NULL,
      quantidadeAtual REAL NOT NULL CHECK (quantidadeAtual >= 0),
      dataEntrada TEXT NOT NULL,
      dataValidade TEXT,
      estado TEXT NOT NULL DEFAULT 'Disponivel',
      FOREIGN KEY (produtoId) REFERENCES Produto(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS Movimentacao (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produtoId INTEGER NOT NULL,
      loteId INTEGER NOT NULL,
      tipo TEXT NOT NULL CHECK (tipo IN ('Entrada', 'Saida', 'Perda')),
      quantidade REAL NOT NULL CHECK (quantidade > 0),
      dataHora TEXT NOT NULL,
      usuarioId INTEGER NOT NULL,
      observacao TEXT,
      FOREIGN KEY (produtoId) REFERENCES Produto(id) ON DELETE CASCADE,
      FOREIGN KEY (loteId) REFERENCES Lote(id) ON DELETE CASCADE,
      FOREIGN KEY (usuarioId) REFERENCES Usuario(id)
    );

    CREATE TABLE IF NOT EXISTS Alerta (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produtoId INTEGER,
      loteId INTEGER,
      tipo TEXT NOT NULL CHECK (tipo IN ('Estoque', 'Validade')),
      mensagem TEXT NOT NULL,
      dataGeracao TEXT NOT NULL,
      resolvido INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (produtoId) REFERENCES Produto(id) ON DELETE CASCADE,
      FOREIGN KEY (loteId) REFERENCES Lote(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_lote_produto ON Lote(produtoId, dataValidade);
    CREATE INDEX IF NOT EXISTS idx_mov_produto ON Movimentacao(produtoId, tipo);
    CREATE INDEX IF NOT EXISTS idx_mov_usuario ON Movimentacao(usuarioId);
  `);

  const totalUsuarios = db.prepare('SELECT COUNT(*) AS total FROM Usuario').get().total;
  if (totalUsuarios === 0) {
    popularDadosIniciais();
  } else {
    // Garante que as contas padrão de demonstração estejam sempre com o hash atualizado
    const stmtSyncHash = db.prepare('UPDATE Usuario SET senhaHash = ? WHERE login = ?');
    stmtSyncHash.run(gerarHashSenha('admin123'), 'admin');
    stmtSyncHash.run(gerarHashSenha('func123'), 'carlos');
    stmtSyncHash.run(gerarHashSenha('func123'), 'mariana');
    sincronizarEstadosEAlertas();
  }
}

function popularDadosIniciais() {
  const hoje = new Date();
  const dataOffset = (dias) => {
    const d = new Date(hoje);
    d.setDate(d.getDate() + dias);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  };

  db.exec('BEGIN TRANSACTION;');
  try {
    const stmtUser = db.prepare(
      'INSERT INTO Usuario (nome, login, senhaHash, perfil) VALUES (?, ?, ?, ?)'
    );
    const adminId = Number(
      stmtUser.run('Nicolae Lopes', 'admin', gerarHashSenha('admin123'), 'Administrador')
        .lastInsertRowid
    );
    const func1Id = Number(
      stmtUser.run('Carlos Silva (Caixa)', 'carlos', gerarHashSenha('func123'), 'Funcionario')
        .lastInsertRowid
    );
    stmtUser.run('Mariana Souza (Reposição)', 'mariana', gerarHashSenha('func123'), 'Funcionario');

    const stmtProd = db.prepare(`
      INSERT INTO Produto (nome, categoria, unidadeMedida, precoVenda, perecivel, estoqueMinimo)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const pArroz = Number(
      stmtProd.run('Arroz Tipo 1 - 5kg', 'Mercearia Seca', 'unidade', 28.9, 0, 10).lastInsertRowid
    );
    const pLeite = Number(
      stmtProd.run('Leite Integral 1L', 'Laticínios e Frios', 'litro', 5.49, 1, 15).lastInsertRowid
    );
    const pIogurte = Number(
      stmtProd.run('Iogurte Natural 170g', 'Laticínios e Frios', 'unidade', 3.99, 1, 8)
        .lastInsertRowid
    );
    const pTomate = Number(
      stmtProd.run('Tomate Italiano', 'Hortifrúti', 'quilo', 8.9, 1, 12).lastInsertRowid
    );
    const pSuco = Number(
      stmtProd.run('Suco de Laranja Integral 1L', 'Bebidas', 'litro', 11.5, 1, 6).lastInsertRowid
    );
    const pDetergente = Number(
      stmtProd.run('Detergente Neutro 500ml', 'Limpeza e Higiene', 'unidade', 2.79, 0, 10)
        .lastInsertRowid
    );

    const stmtLote = db.prepare(`
      INSERT INTO Lote (produtoId, codigoLote, quantidadeAtual, dataEntrada, dataValidade, estado)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const stmtMov = db.prepare(`
      INSERT INTO Movimentacao (produtoId, loteId, tipo, quantidade, dataHora, usuarioId, observacao)
      VALUES (?, ?, ?, ?, datetime('now', 'localtime'), ?, ?)
    `);

    const lArroz = Number(
      stmtLote.run(pArroz, 'LOTE-ARR-001', 25, dataOffset(-15), dataOffset(180), 'Disponivel')
        .lastInsertRowid
    );
    stmtMov.run(pArroz, lArroz, 'Entrada', 30, adminId, 'Entrega fornecedor');
    stmtMov.run(pArroz, lArroz, 'Saida', 5, func1Id, 'Venda balcão');

    // Dois lotes de Leite para demonstrar ordenação FEFO
    const lLeite2 = Number(
      stmtLote.run(pLeite, 'LOTE-LEI-102', 20, dataOffset(-2), dataOffset(25), 'Disponivel')
        .lastInsertRowid
    );
    const lLeite1 = Number(
      stmtLote.run(pLeite, 'LOTE-LEI-101', 12, dataOffset(-10), dataOffset(4), 'VencimentoProximo')
        .lastInsertRowid
    );
    stmtMov.run(pLeite, lLeite2, 'Entrada', 20, adminId, 'Remessa nova laticínios');
    stmtMov.run(pLeite, lLeite1, 'Entrada', 18, adminId, 'Remessa anterior laticínios');
    stmtMov.run(pLeite, lLeite1, 'Saida', 6, func1Id, 'Reposição geladeira');

    // Iogurte com 1 lote vencido e 1 lote válido
    const lIogVenc = Number(
      stmtLote.run(pIogurte, 'LOTE-IOG-090', 5, dataOffset(-20), dataOffset(-2), 'Vencido')
        .lastInsertRowid
    );
    const lIogVal = Number(
      stmtLote.run(pIogurte, 'LOTE-IOG-095', 14, dataOffset(-1), dataOffset(18), 'Disponivel')
        .lastInsertRowid
    );
    stmtMov.run(pIogurte, lIogVenc, 'Entrada', 5, adminId, 'Lote antigo');
    stmtMov.run(pIogurte, lIogVal, 'Entrada', 14, adminId, 'Lote novo');

    // Tomate abaixo do estoque mínimo
    const lTomate = Number(
      stmtLote.run(pTomate, 'LOTE-TOM-010', 8, dataOffset(-3), dataOffset(5), 'EstoqueBaixo')
        .lastInsertRowid
    );
    stmtMov.run(pTomate, lTomate, 'Entrada', 15, adminId, 'Feira semanal');
    stmtMov.run(pTomate, lTomate, 'Saida', 7, func1Id, 'Vendas hortifrúti');

    // Suco disponível
    const lSuco = Number(
      stmtLote.run(pSuco, 'LOTE-SUC-050', 15, dataOffset(-5), dataOffset(40), 'Disponivel')
        .lastInsertRowid
    );
    stmtMov.run(pSuco, lSuco, 'Entrada', 15, adminId, 'Entrada bebidas');

    // Detergente sem saídas (produto parado)
    const lDetergente = Number(
      stmtLote.run(pDetergente, 'LOTE-DET-001', 30, dataOffset(-30), dataOffset(365), 'Disponivel')
        .lastInsertRowid
    );
    stmtMov.run(pDetergente, lDetergente, 'Entrada', 30, adminId, 'Estoque inicial limpeza');

    db.exec('COMMIT;');
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK;');
    throw err;
  }

  sincronizarEstadosEAlertas();
}

module.exports = {
  db,
  gerarHashSenha,
  verificarSenha,
  calcularDiasParaVencimento,
  calcularEstadoLote,
  sincronizarEstadosEAlertas,
  inicializarBanco,
  popularDadosIniciais,
};
