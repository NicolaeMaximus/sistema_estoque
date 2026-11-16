/**
 * ============================================================================
 * ECOT11A - LABORATÓRIO DE ENGENHARIA DE SOFTWARE (UNIFEI)
 * Projeto: Sistema de Controle de Estoque da Mercearia
 * Autor: Nicolae Lopes - Matrícula: 2024014650
 * Prof.: Edvard
 * ----------------------------------------------------------------------------
 * Módulo: Camada de Dados (src/database/db.js)
 * Tarefas Relacionadas:
 *   - T01: Ambiente, repositório Git e banco de dados
 *   - T02: Modelagem física do BD (Usuario, Produto, Lote, Movimentacao, Alerta)
 *   - T14: Ciclo de vida do lote (Disponivel, EstoqueBaixo, VencimentoProximo, Esgotado, Vencido)
 * Requisitos Atendidos:
 *   - RNF02: Senhas salvas com hash criptográfico (SHA-256 / scrypt via módulo crypto)
 *   - RNF03: Transações ACID no banco relacional SQLite (arquivo local estoque.db)
 * ============================================================================
 */

const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

// Caminho do arquivo de banco de dados local conforme especificado na Seção 9 do Documento
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'estoque.db');

// Instância única de conexão com o banco SQLite
const db = new DatabaseSync(DB_PATH);

// Habilita chaves estrangeiras e modo WAL para melhor desempenho (< 500ms - RNF01) e integridade ACID (RNF03)
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA journal_mode = WAL;');

/**
 * Gera um hash criptográfico seguro para a senha utilizando PBKDF2/scrypt + SHA-256 (RNF02).
 * @param {string} senha - Senha em texto plano
 * @returns {string} Hash formatado no padrão "salt:hash"
 */
function gerarHashSenha(senha) {
  const salt = 'mercearia_ecot11a_salt_2026';
  const hash = crypto.scryptSync(String(senha), salt, 32).toString('hex');
  const sha256 = crypto.createHash('sha256').update(hash).digest('hex');
  return `scrypt_sha256$${sha256}`;
}

/**
 * Verifica se a senha fornecida corresponde ao hash salvo no banco (RNF02).
 * @param {string} senha - Senha informada no login
 * @param {string} senhaHash - Hash armazenado no banco de dados
 * @returns {boolean}
 */
function verificarSenha(senha, senhaHash) {
  return gerarHashSenha(senha) === senhaHash;
}

/**
 * Calcula a diferença em dias entre a data de validade do lote e a data de hoje.
 * @param {string} dataValidade - Data no formato YYYY-MM-DD
 * @returns {number} Dias restantes (negativo se já estiver vencido)
 */
function calcularDiasParaVencimento(dataValidade) {
  if (!dataValidade) return Infinity;
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const [ano, mes, dia] = dataValidade.split('-').map(Number);
  const validade = new Date(ano, mes - 1, dia);
  validade.setHours(0, 0, 0, 0);
  const diffMs = validade.getTime() - hoje.getTime();
  return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Determina o estado atual de um lote segundo o Diagrama de Estados (Seção 6.4 - T14):
 * Estados possíveis:
 *   - 'Esgotado'          (quantidadeAtual == 0)
 *   - 'Vencido'           (perecível e diasParaVencer < 0 e quantidadeAtual > 0)
 *   - 'VencimentoProximo' (perecível e 0 <= diasParaVencer <= 7 e quantidadeAtual > 0)
 *   - 'EstoqueBaixo'      (0 < quantidadeAtual <= estoqueMinimo)
 *   - 'Disponivel'        (quantidadeAtual > estoqueMinimo e longe do vencimento)
 *
 * @param {object} lote - Dados do lote ({ quantidadeAtual, dataValidade })
 * @param {object} produto - Dados do produto ({ perecivel, estoqueMinimo })
 * @returns {string} Estado calculado do lote
 */
function calcularEstadoLote(lote, produto) {
  const qtd = Number(lote.quantidadeAtual || 0);
  if (qtd <= 0) {
    return 'Esgotado';
  }

  if (produto && Number(produto.perecivel) === 1 && lote.dataValidade) {
    const dias = calcularDiasParaVencimento(lote.dataValidade);
    if (dias < 0) {
      return 'Vencido';
    }
    if (dias <= 7) {
      return 'VencimentoProximo';
    }
  }

  const min = produto ? Number(produto.estoqueMinimo || 0) : 0;
  if (qtd <= min) {
    return 'EstoqueBaixo';
  }

  return 'Disponivel';
}

/**
 * Atualiza o estado de todos os lotes e sincroniza a tabela de Alertas (RF07, RN-II, RN-III, T14, T15).
 * Garante que os alertas exibidos no login e após movimentações reflitam fielmente o estoque atual.
 */
function sincronizarEstadosEAlertas() {
  const produtos = db.prepare('SELECT * FROM Produto').all();
  const lotes = db.prepare('SELECT * FROM Lote').all();

  const mapaProdutos = new Map(produtos.map((p) => [p.id, p]));

  // 1. Atualiza o estado de cada lote individualmente conforme a máquina de estados (T14)
  const stmtUpdateLote = db.prepare('UPDATE Lote SET estado = ? WHERE id = ?');
  for (const lote of lotes) {
    // Se o lote já foi baixado como 'Removido' pelo Administrador após vencimento, preserva se qtd == 0
    if (lote.estado === 'Removido' && Number(lote.quantidadeAtual) === 0) {
      continue;
    }
    const prod = mapaProdutos.get(lote.produtoId);
    const novoEstado = calcularEstadoLote(lote, prod);
    if (novoEstado !== lote.estado) {
      stmtUpdateLote.run(novoEstado, lote.id);
    }
  }

  // 2. Recalcula os alertas ativos (RF07 - separando Estoque Baixo e Validade)
  db.exec('DELETE FROM Alerta WHERE resolvido = 0;');
  const stmtInsertAlerta = db.prepare(`
    INSERT INTO Alerta (produtoId, loteId, tipo, mensagem, dataGeracao, resolvido)
    VALUES (?, ?, ?, ?, datetime('now', 'localtime'), 0)
  `);

  // 2a. Alertas de Estoque Baixo por Produto (RN-II: saldo disponível <= estoqueMinimo)
  for (const prod of produtos) {
    const lotesDoProd = db
      .prepare('SELECT * FROM Lote WHERE produtoId = ? AND quantidadeAtual > 0')
      .all(prod.id);

    // Somamos apenas lotes não vencidos como saldo disponível para venda/reposição normal
    let saldoDisponivel = 0;
    for (const l of lotesDoProd) {
      const estado = calcularEstadoLote(l, prod);
      if (estado !== 'Vencido') {
        saldoDisponivel += Number(l.quantidadeAtual);
      }
    }

    if (saldoDisponivel <= Number(prod.estoqueMinimo)) {
      const msg =
        saldoDisponivel === 0
          ? `Estoque ESGOTADO para "${prod.nome}" (Mínimo exigido: ${prod.estoqueMinimo} ${prod.unidadeMedida}).`
          : `Estoque baixo para "${prod.nome}": restam ${saldoDisponivel} ${prod.unidadeMedida} (Mínimo: ${prod.estoqueMinimo} ${prod.unidadeMedida}).`;
      stmtInsertAlerta.run(prod.id, null, 'Estoque', msg);
    }
  }

  // 2b. Alertas de Validade Próxima ou Lote Vencido ordenados por FEFO (RN-III, RE-I)
  const lotesPereciveis = db
    .prepare(`
      SELECT l.*, p.nome AS produtoNome, p.unidadeMedida, p.perecivel, p.estoqueMinimo
      FROM Lote l
      JOIN Produto p ON p.id = l.produtoId
      WHERE p.perecivel = 1 AND l.quantidadeAtual > 0
      ORDER BY l.dataValidade ASC
    `)
    .all();

  for (const l of lotesPereciveis) {
    const dias = calcularDiasParaVencimento(l.dataValidade);
    if (dias < 0) {
      stmtInsertAlerta.run(
        l.produtoId,
        l.id,
        'Validade',
        `LOTE VENCIDO [${l.codigoLote}] de "${l.produtoNome}" (${l.quantidadeAtual} ${l.unidadeMedida}) - venceu em ${l.dataValidade}. Saída bloqueada (RE-I).`
      );
    } else if (dias <= 7) {
      stmtInsertAlerta.run(
        l.produtoId,
        l.id,
        'Validade',
        `Vencimento próximo (${dias === 0 ? 'VENCE HOJE' : `em ${dias} dia(s)`}): Lote [${l.codigoLote}] de "${l.produtoNome}" (${l.quantidadeAtual} ${l.unidadeMedida}) vence em ${l.dataValidade}.`
      );
    }
  }
}

/**
 * Inicializa as tabelas do banco de dados seguindo estritamente o Diagrama de Classes (Seção 6.2)
 * e insere dados iniciais (seed) caso o banco esteja vazio.
 */
function inicializarBanco() {
  db.exec(`
    -- Tabela Usuario (Seção 6.2 - Diagrama de Classes)
    CREATE TABLE IF NOT EXISTS Usuario (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      login TEXT NOT NULL UNIQUE,
      senhaHash TEXT NOT NULL,
      perfil TEXT NOT NULL CHECK (perfil IN ('Administrador', 'Funcionario'))
    );

    -- Tabela Produto (Seção 6.2 - Diagrama de Classes)
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

    -- Tabela Lote (Seção 6.2 e 6.4 - Diagrama de Classes e Estados)
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

    -- Tabela Movimentacao (Seção 6.2 - Entrada, Saida, Perda vinculada ao Usuario - RN-IV)
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

    -- Tabela Alerta (Seção 6.2 - Alertas de Estoque Baixo e Validade)
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
  `);

  // Verifica se já existem usuários cadastrados; se não, popula o seed inicial para demonstração
  const totalUsuarios = db.prepare('SELECT COUNT(*) AS total FROM Usuario').get().total;
  if (totalUsuarios === 0) {
    popularDadosIniciais();
  } else {
    sincronizarEstadosEAlertas();
  }
}

/**
 * Insere dados iniciais realistas da Mercearia para permitir teste imediato de todos os requisitos
 * (RF01 a RF08, RN-I a RN-IV, RE-I, RE-II e casos de teste CT01 a CT05).
 */
function popularDadosIniciais() {
  const hoje = new Date();
  const formatarData = (offsetDias) => {
    const d = new Date(hoje);
    d.setDate(d.getDate() + offsetDias);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  };

  db.exec('BEGIN TRANSACTION;');
  try {
    // 1. Perfis de Usuário (Lab 1: O dono Administrador e os 2 funcionários do caixa e da reposição)
    const stmtUser = db.prepare(
      'INSERT INTO Usuario (nome, login, senhaHash, perfil) VALUES (?, ?, ?, ?)'
    );
    const adminInfo = stmtUser.run(
      'Nicolae Lopes (Proprietário)',
      'admin',
      gerarHashSenha('admin123'),
      'Administrador'
    );
    const func1Info = stmtUser.run(
      'Carlos Silva (Caixa)',
      'carlos',
      gerarHashSenha('func123'),
      'Funcionario'
    );
    stmtUser.run(
      'Mariana Souza (Reposição)',
      'mariana',
      gerarHashSenha('func123'),
      'Funcionario'
    );

    const adminId = Number(adminInfo.lastInsertRowid);
    const func1Id = Number(func1Info.lastInsertRowid);

    // 2. Produtos nas 5 categorias especificadas no Documento de Requisitos (Seção 4)
    const stmtProd = db.prepare(`
      INSERT INTO Produto (nome, categoria, unidadeMedida, precoVenda, perecivel, estoqueMinimo)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    // P1: Mercearia Seca
    const pArroz = Number(
      stmtProd.run('Arroz Tipo 1 - Pacote 5kg', 'Mercearia Seca', 'unidade', 28.9, 0, 10)
        .lastInsertRowid
    );
    // P2: Laticínios e Frios (Perecível - com 2 lotes para demonstrar FEFO RN-III e CT03)
    const pLeite = Number(
      stmtProd.run('Leite Integral 1L', 'Laticínios e Frios', 'litro', 5.49, 1, 15).lastInsertRowid
    );
    // P3: Laticínios e Frios (Perecível - com lote vencido para demonstrar RE-I e CT04)
    const pIogurte = Number(
      stmtProd.run('Iogurte Natural 170g', 'Laticínios e Frios', 'unidade', 3.99, 1, 8)
        .lastInsertRowid
    );
    // P4: Hortifrúti (Perecível - com estoque baixo para demonstrar RN-II e CT05)
    const pTomate = Number(
      stmtProd.run('Tomate Italiano', 'Hortifrúti', 'quilo', 8.9, 1, 12).lastInsertRowid
    );
    // P5: Bebidas (Perecível)
    const pSuco = Number(
      stmtProd.run('Suco de Laranja Integral 1L', 'Bebidas', 'litro', 11.5, 1, 6).lastInsertRowid
    );
    // P6: Limpeza e Higiene (Não perecível - Produto parado para relatório RF08/T19)
    const pDetergente = Number(
      stmtProd.run('Detergente Neutro 500ml', 'Limpeza e Higiene', 'unidade', 2.79, 0, 10)
        .lastInsertRowid
    );

    // 3. Lotes e Movimentações Iniciais
    const stmtLote = db.prepare(`
      INSERT INTO Lote (produtoId, codigoLote, quantidadeAtual, dataEntrada, dataValidade, estado)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const stmtMov = db.prepare(`
      INSERT INTO Movimentacao (produtoId, loteId, tipo, quantidade, dataHora, usuarioId, observacao)
      VALUES (?, ?, ?, ?, datetime('now', 'localtime'), ?, ?)
    `);

    // Lote de Arroz (Disponível)
    const lArroz = Number(
      stmtLote.run(pArroz, 'LOTE-ARR-001', 25, formatarData(-15), formatarData(180), 'Disponivel')
        .lastInsertRowid
    );
    stmtMov.run(pArroz, lArroz, 'Entrada', 30, adminId, 'Entrega inicial do fornecedor');
    stmtMov.run(pArroz, lArroz, 'Saida', 5, func1Id, 'Venda no balcão');

    // Dois lotes de Leite Integral com validades diferentes (para demonstrar FEFO - RN-III / CT03)
    const lLeiteMaisDistante = Number(
      stmtLote.run(pLeite, 'LOTE-LEI-102', 20, formatarData(-2), formatarData(25), 'Disponivel')
        .lastInsertRowid
    );
    const lLeiteMaisProximo = Number(
      stmtLote.run(
        pLeite,
        'LOTE-LEI-101',
        12,
        formatarData(-10),
        formatarData(4),
        'VencimentoProximo'
      ).lastInsertRowid
    );
    stmtMov.run(pLeite, lLeiteMaisDistante, 'Entrada', 20, adminId, 'Remessa nova Laticínios');
    stmtMov.run(pLeite, lLeiteMaisProximo, 'Entrada', 18, adminId, 'Remessa anterior Laticínios');
    stmtMov.run(pLeite, lLeiteMaisProximo, 'Saida', 6, func1Id, 'Reposição de geladeira (FEFO)');

    // Lote de Iogurte VENCIDO (para demonstrar bloqueio RE-I / T16 / CT04) + 1 lote válido
    const lIogVencido = Number(
      stmtLote.run(pIogurte, 'LOTE-IOG-090', 5, formatarData(-20), formatarData(-2), 'Vencido')
        .lastInsertRowid
    );
    const lIogValido = Number(
      stmtLote.run(pIogurte, 'LOTE-IOG-095', 14, formatarData(-1), formatarData(18), 'Disponivel')
        .lastInsertRowid
    );
    stmtMov.run(pIogurte, lIogVencido, 'Entrada', 5, adminId, 'Lote antigo para teste de bloqueio');
    stmtMov.run(pIogurte, lIogValido, 'Entrada', 14, adminId, 'Lote novo de iogurte');

    // Lote de Tomate com Estoque Baixo (qtd 8 <= min 12 - RN-II)
    const lTomate = Number(
      stmtLote.run(pTomate, 'LOTE-TOM-010', 8, formatarData(-3), formatarData(5), 'EstoqueBaixo')
        .lastInsertRowid
    );
    stmtMov.run(pTomate, lTomate, 'Entrada', 15, adminId, 'Feira semanal');
    stmtMov.run(pTomate, lTomate, 'Saida', 7, func1Id, 'Vendas hortifrúti');

    // Lote de Suco (Disponível)
    const lSuco = Number(
      stmtLote.run(pSuco, 'LOTE-SUC-050', 15, formatarData(-5), formatarData(40), 'Disponivel')
        .lastInsertRowid
    );
    stmtMov.run(pSuco, lSuco, 'Entrada', 15, adminId, 'Entrada bebidas');

    // Lote de Detergente (Sem saídas -> aparece como "Produto Parado" no relatório RF08/T19)
    const lDetergente = Number(
      stmtLote.run(
        pDetergente,
        'LOTE-DET-001',
        30,
        formatarData(-30),
        formatarData(365),
        'Disponivel'
      ).lastInsertRowid
    );
    stmtMov.run(pDetergente, lDetergente, 'Entrada', 30, adminId, 'Estoque inicial limpeza');

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
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
