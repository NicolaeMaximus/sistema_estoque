// Testes automatizados dos casos CT01 a CT05 do plano de testes
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'estoque_test.db');
if (fs.existsSync(TEST_DB_PATH)) {
  fs.unlinkSync(TEST_DB_PATH);
}
process.env.DB_PATH = TEST_DB_PATH;

const app = require('../src/server');
const { db } = require('../src/database/db');

let servidor;
let baseUrl;

async function requisitar(rota, { metodo = 'GET', token = null, corpo = null } = {}) {
  const inicio = performance.now();
  const headers = { 'Content-Type': 'application/json' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const resposta = await fetch(`${baseUrl}${rota}`, {
    method: metodo,
    headers,
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const tempoMs = performance.now() - inicio;
  const texto = await resposta.text();
  let json = null;
  try {
    json = JSON.parse(texto);
  } catch (_) {}

  return { status: resposta.status, json, texto, tempoMs };
}

async function executarTestes() {
  console.log('Executando testes do sistema (CT01 a CT05)...\n');

  servidor = app.listen(0);
  const { port } = servidor.address();
  baseUrl = `http://127.0.0.1:${port}`;

  try {
    const loginAdmin = await requisitar('/api/auth/login', {
      metodo: 'POST',
      corpo: { login: 'admin', senha: 'admin123' },
    });
    assert.strictEqual(loginAdmin.status, 200);
    assert.ok(loginAdmin.tempoMs < 500);
    const tokenAdmin = loginAdmin.json.token;

    const regAdminBD = db.prepare("SELECT senhaHash FROM Usuario WHERE login = 'admin'").get();
    assert.ok(regAdminBD.senhaHash.startsWith('scrypt_sha256$'));

    const loginFunc = await requisitar('/api/auth/login', {
      metodo: 'POST',
      corpo: { login: 'carlos', senha: 'func123' },
    });
    assert.strictEqual(loginFunc.status, 200);
    const tokenFunc = loginFunc.json.token;

    // CT01: Funcionário tentando cadastrar produto ou funcionário -> HTTP 403
    const tentCadProduto = await requisitar('/api/produtos', {
      metodo: 'POST',
      token: tokenFunc,
      corpo: {
        nome: 'Produto Teste',
        categoria: 'Mercearia Seca',
        unidadeMedida: 'unidade',
        precoVenda: 9.9,
      },
    });
    assert.strictEqual(tentCadProduto.status, 403);

    const tentCadFunc = await requisitar('/api/usuarios', {
      metodo: 'POST',
      token: tokenFunc,
      corpo: { nome: 'Outro', login: 'outro', senha: '123', perfil: 'Funcionario' },
    });
    assert.strictEqual(tentCadFunc.status, 403);

    const consultaFunc = await requisitar('/api/produtos', { token: tokenFunc });
    assert.strictEqual(consultaFunc.status, 200);
    console.log('[OK] CT01 - Controle de acesso por perfil (HTTP 403 para Funcionário)');

    // CT02: Saída com quantidade maior que o saldo disponível
    const produtoArroz = consultaFunc.json.find((p) => p.nome.includes('Arroz'));
    const loteArroz = produtoArroz.lotes[0];

    const tentSaidaExcessiva = await requisitar('/api/estoque/saida', {
      metodo: 'POST',
      token: tokenFunc,
      corpo: {
        produtoId: produtoArroz.id,
        loteId: loteArroz.id,
        quantidade: loteArroz.quantidadeAtual + 50,
      },
    });
    assert.strictEqual(tentSaidaExcessiva.status, 400);
    assert.strictEqual(tentSaidaExcessiva.json.codigoRegra, 'RN-I');
    assert.strictEqual(tentSaidaExcessiva.json.saldoAtual, loteArroz.quantidadeAtual);
    console.log('[OK] CT02 - Bloqueio de saída acima do saldo disponível');

    // CT03: Ordenação FEFO e alerta de vencimento próximo (<= 7 dias)
    const prodLeite = consultaFunc.json.find((p) => p.nome.includes('Leite Integral'));
    const primeiroLoteNaFila = prodLeite.lotes[0];
    const segundoLoteNaFila = prodLeite.lotes[1];
    assert.ok(primeiroLoteNaFila.dataValidade < segundoLoteNaFila.dataValidade);

    const saidaFEFO = await requisitar('/api/estoque/saida', {
      metodo: 'POST',
      token: tokenFunc,
      corpo: {
        produtoId: prodLeite.id,
        quantidade: 2,
      },
    });
    assert.strictEqual(saidaFEFO.status, 200);
    assert.strictEqual(saidaFEFO.json.lote.id, primeiroLoteNaFila.id);
    assert.ok(saidaFEFO.json.avisos.some((a) => a.tipo === 'VencimentoProximo'));
    console.log('[OK] CT03 - Priorização de saída por FEFO e aviso de vencimento próximo');

    // CT04: Bloqueio de saída normal de lote vencido e baixa de perda pelo Administrador
    const prodIogurte = consultaFunc.json.find((p) => p.nome.includes('Iogurte'));
    const loteVencido = prodIogurte.lotes.find((l) => l.estado === 'Vencido');

    const tentSaidaVencido = await requisitar('/api/estoque/saida', {
      metodo: 'POST',
      token: tokenFunc,
      corpo: {
        produtoId: prodIogurte.id,
        loteId: loteVencido.id,
        quantidade: 1,
      },
    });
    assert.strictEqual(tentSaidaVencido.status, 400);
    assert.strictEqual(tentSaidaVencido.json.codigoRegra, 'RE-I');

    const baixaPerdaAdmin = await requisitar('/api/estoque/perda', {
      metodo: 'POST',
      token: tokenAdmin,
      corpo: { loteId: loteVencido.id, motivo: 'Baixa por vencimento' },
    });
    assert.strictEqual(baixaPerdaAdmin.status, 200);
    assert.strictEqual(baixaPerdaAdmin.json.novoEstado, 'Removido');
    console.log('[OK] CT04 - Bloqueio de lote vencido e baixa de perda pelo Administrador');

    // CT05: Saída até atingir estoque mínimo e vínculo ao funcionário
    const prodSuco = consultaFunc.json.find((p) => p.nome.includes('Suco de Laranja'));
    const saidaAteMinimo = await requisitar('/api/estoque/saida', {
      metodo: 'POST',
      token: tokenFunc,
      corpo: {
        produtoId: prodSuco.id,
        quantidade: 10,
      },
    });
    assert.strictEqual(saidaAteMinimo.status, 200);
    assert.ok(saidaAteMinimo.json.avisos.some((a) => a.tipo === 'EstoqueBaixo'));

    const alertasAtivos = await requisitar('/api/alertas', { token: tokenFunc });
    assert.ok(alertasAtivos.json.estoqueBaixo.some((a) => a.produtoId === prodSuco.id));

    const historico = await requisitar('/api/movimentacoes', { token: tokenFunc });
    const movRegistrada = historico.json.find((m) => m.id === saidaAteMinimo.json.movimentacaoId);
    assert.ok(movRegistrada.usuarioNome.includes('Carlos Silva'));
    console.log('[OK] CT05 - Alerta de estoque baixo e vínculo da saída ao funcionário');

    // Relatórios e CSV
    const resRelatorios = await requisitar('/api/relatorios', { token: tokenAdmin });
    assert.strictEqual(resRelatorios.status, 200);
    const resCSV = await requisitar('/api/relatorios/exportar/csv', { token: tokenAdmin });
    assert.strictEqual(resCSV.status, 200);

    console.log('\nTodos os testes passaram com sucesso!');
  } finally {
    servidor.close();
    try {
      db.close();
      if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
      if (fs.existsSync(`${TEST_DB_PATH}-wal`)) fs.unlinkSync(`${TEST_DB_PATH}-wal`);
      if (fs.existsSync(`${TEST_DB_PATH}-shm`)) fs.unlinkSync(`${TEST_DB_PATH}-shm`);
    } catch (_) {}
  }
}

executarTestes().catch((err) => {
  console.error('\nErro nos testes:', err);
  process.exit(1);
});
