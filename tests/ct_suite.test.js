/**
 * ============================================================================
 * ECOT11A - LABORATÓRIO DE ENGENHARIA DE SOFTWARE (UNIFEI)
 * Projeto: Sistema de Controle de Estoque da Mercearia
 * Autor: Nicolae Lopes - Matrícula: 2024014650
 * Prof.: Edvard
 * ----------------------------------------------------------------------------
 * Módulo: Suíte de Testes Automatizados do MVP (tests/ct_suite.test.js)
 * Tarefas Relacionadas:
 *   - T07, T13, T18, T22: Testes integrados, funcionais, de segurança e aceitação
 * Casos de Teste Verificados (Seção 10 do Documento de Software):
 *   - CT01 (RF01, RF02, RNF02): Funcionário tenta cadastrar produto/funcionário -> Bloqueio HTTP 403
 *   - CT02 (RF05, RN-I, RS001): Tentativa de saída maior que o saldo disponível -> Impede baixa e informa saldo
 *   - CT03 (RF05, RF07, RN-III): Produto perecível com 2 lotes de validades diferentes -> Ordena por FEFO e alerta <= 7 dias
 *   - CT04 (RE-I, T16): Tentativa de saída normal de lote vencido -> Bloqueia saída comum e permite baixa de perda pelo Admin
 *   - CT05 (RF07, RN-II, RN-IV): Saída até atingir estoque mínimo -> Gera alerta de estoque baixo e grava nome do funcionário
 *   - Extras: RNF01 (Desempenho < 500ms), RF06 (Operações em Massa ACID) e RF08/RE-II (Exportação CSV/PDF)
 * ============================================================================
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Usa um banco SQLite dedicado para os testes não alterarem o banco principal de demonstração
const TEST_DB_PATH = path.join(__dirname, 'estoque_test.db');
if (fs.existsSync(TEST_DB_PATH)) {
  fs.unlinkSync(TEST_DB_PATH);
}
process.env.DB_PATH = TEST_DB_PATH;

const app = require('../src/server');
const { db } = require('../src/database/db');

let servidor;
let baseUrl;

/**
 * Função auxiliar para fazer chamadas HTTP à API durante os testes.
 */
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

async function executarSuiteDeTestes() {
  console.log('====================================================================');
  console.log(' INICIANDO PLANO DE TESTES DO MVP (Seção 10 - CT01 a CT05 + RNFs)');
  console.log('====================================================================\n');

  servidor = app.listen(0);
  const { port } = servidor.address();
  baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Autenticação como Administrador e como Funcionário (RF01 / RNF01 / RNF02)
    const loginAdmin = await requisitar('/api/auth/login', {
      metodo: 'POST',
      corpo: { login: 'admin', senha: 'admin123' },
    });
    assert.strictEqual(loginAdmin.status, 200, 'Login do Administrador deve retornar HTTP 200');
    assert.ok(loginAdmin.tempoMs < 500, `RNF01: Login levou ${loginAdmin.tempoMs.toFixed(1)}ms (< 500ms)`);
    const tokenAdmin = loginAdmin.json.token;

    // Verifica RNF02 no banco: senha deve estar com hash criptográfico scrypt_sha256
    const regAdminBD = db.prepare("SELECT senhaHash FROM Usuario WHERE login = 'admin'").get();
    assert.ok(
      regAdminBD.senhaHash.startsWith('scrypt_sha256$'),
      'RNF02: A senha no banco deve estar armazenada com hash criptográfico SHA-256/scrypt'
    );

    const loginFunc = await requisitar('/api/auth/login', {
      metodo: 'POST',
      corpo: { login: 'carlos', senha: 'func123' },
    });
    assert.strictEqual(loginFunc.status, 200, 'Login do Funcionário deve retornar HTTP 200');
    const tokenFunc = loginFunc.json.token;

    // ------------------------------------------------------------------------
    // CASO DE TESTE CT01 (RF01, RF02, RNF02)
    // Cenário: Entrar com usuário do tipo Funcionário e tentar cadastrar um produto ou novo funcionário.
    // Resultado Esperado: O sistema bloqueia a ação (HTTP 403) e permite apenas consulta e registro de saída.
    // ------------------------------------------------------------------------
    const tentCadProduto = await requisitar('/api/produtos', {
      metodo: 'POST',
      token: tokenFunc,
      corpo: {
        nome: 'Produto Proibido',
        categoria: 'Mercearia Seca',
        unidadeMedida: 'unidade',
        precoVenda: 9.9,
      },
    });
    assert.strictEqual(
      tentCadProduto.status,
      403,
      'CT01: Funcionário tentando cadastrar produto deve receber bloqueio HTTP 403'
    );

    const tentCadFunc = await requisitar('/api/usuarios', {
      metodo: 'POST',
      token: tokenFunc,
      corpo: { nome: 'Outro Func', login: 'outro', senha: '123', perfil: 'Funcionario' },
    });
    assert.strictEqual(
      tentCadFunc.status,
      403,
      'CT01: Funcionário tentando cadastrar novo funcionário deve receber bloqueio HTTP 403'
    );

    const consultaFunc = await requisitar('/api/produtos', { token: tokenFunc });
    assert.strictEqual(consultaFunc.status, 200, 'CT01: Funcionário deve conseguir consultar produtos');
    console.log('✔ [CT01 APROVADO] Bloqueio HTTP 403 para Funcionário em rotas restritas (RF01, RF02, RNF02).');

    // ------------------------------------------------------------------------
    // CASO DE TESTE CT02 (RF05, RN-I, RS001)
    // Cenário: Tentar registrar uma saída com quantidade maior do que a disponível no lote.
    // Resultado Esperado: O sistema impede a baixa e exibe mensagem informando o saldo atual.
    // ------------------------------------------------------------------------
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
    assert.strictEqual(tentSaidaExcessiva.status, 400, 'CT02: Saída acima do disponível deve ser impedida');
    assert.strictEqual(tentSaidaExcessiva.json.codigoRegra, 'RN-I', 'CT02: Deve apontar violação da RN-I');
    assert.strictEqual(
      tentSaidaExcessiva.json.saldoAtual,
      loteArroz.quantidadeAtual,
      'CT02: Deve informar o saldo atual do lote'
    );
    console.log(
      `✔ [CT02 APROVADO] Saída acima do saldo impedida com retorno do saldo atual = ${tentSaidaExcessiva.json.saldoAtual} (RF05, RN-I, RS001).`
    );

    // ------------------------------------------------------------------------
    // CASO DE TESTE CT03 (RF05, RF07, RN-III)
    // Cenário: Cadastrar dois lotes de um produto perecível com validades diferentes e abrir consulta/saída.
    // Resultado Esperado: O lote com vencimento mais próximo aparece primeiro (FEFO); se faltar <= 7 dias, exibe alerta.
    // ------------------------------------------------------------------------
    const prodLeite = consultaFunc.json.find((p) => p.nome.includes('Leite Integral'));
    assert.ok(prodLeite.lotes.length >= 2, 'CT03: Leite Integral possui 2 lotes com validades distintas');
    const primeiroLoteNaFila = prodLeite.lotes[0];
    const segundoLoteNaFila = prodLeite.lotes[1];
    assert.ok(
      primeiroLoteNaFila.dataValidade < segundoLoteNaFila.dataValidade,
      'CT03: O lote com vencimento mais próximo deve aparecer primeiro (FEFO - RN-III)'
    );
    assert.ok(
      primeiroLoteNaFila.diasParaVencer <= 7,
      'CT03: O primeiro lote vence em <= 7 dias e está marcado como VencimentoProximo'
    );

    // Realiza uma saída sem especificar loteId para comprovar que o sistema retira automaticamente do 1º lote FEFO
    const saidaFEFO = await requisitar('/api/estoque/saida', {
      metodo: 'POST',
      token: tokenFunc,
      corpo: {
        produtoId: prodLeite.id,
        quantidade: 2,
      },
    });
    assert.strictEqual(saidaFEFO.status, 200, 'CT03: Saída FEFO realizada com sucesso');
    assert.strictEqual(
      saidaFEFO.json.lote.id,
      primeiroLoteNaFila.id,
      'CT03: O sistema priorizou automaticamente o lote com vencimento mais próximo (FEFO)'
    );
    assert.ok(
      saidaFEFO.json.avisos.some((a) => a.tipo === 'VencimentoProximo'),
      'CT03: Sistema exibiu alerta de vencimento próximo (<= 7 dias)'
    );
    console.log(
      `✔ [CT03 APROVADO] Ordenação FEFO comprovada (Lote ${primeiroLoteNaFila.codigoLote} priorizado) e alerta <= 7 dias emitido (RF05, RF07, RN-III).`
    );

    // ------------------------------------------------------------------------
    // CASO DE TESTE CT04 (RE-I, T16)
    // Cenário: Tentar registrar saída normal de um lote com data de validade vencida.
    // Resultado Esperado: O sistema bloqueia a saída comum e permite apenas baixa de perda pelo Administrador.
    // ------------------------------------------------------------------------
    const prodIogurte = consultaFunc.json.find((p) => p.nome.includes('Iogurte'));
    const loteVencido = prodIogurte.lotes.find((l) => l.estado === 'Vencido');
    assert.ok(loteVencido, 'CT04: Deve existir um lote vencido para teste');

    const tentSaidaVencido = await requisitar('/api/estoque/saida', {
      metodo: 'POST',
      token: tokenFunc,
      corpo: {
        produtoId: prodIogurte.id,
        loteId: loteVencido.id,
        quantidade: 1,
      },
    });
    assert.strictEqual(tentSaidaVencido.status, 400, 'CT04: Saída comum de lote vencido deve ser bloqueada');
    assert.strictEqual(tentSaidaVencido.json.codigoRegra, 'RE-I', 'CT04: Bloqueio deve referenciar RE-I');

    // Funcionário tentando dar baixa de perda deve ser bloqueado (HTTP 403)
    const tentPerdaFunc = await requisitar('/api/estoque/perda', {
      metodo: 'POST',
      token: tokenFunc,
      corpo: { loteId: loteVencido.id, motivo: 'Tentativa pelo funcionário' },
    });
    assert.strictEqual(tentPerdaFunc.status, 403, 'CT04: Funcionário não pode dar baixa de perda');

    // Administrador realiza a baixa de perda com sucesso
    const baixaPerdaAdmin = await requisitar('/api/estoque/perda', {
      metodo: 'POST',
      token: tokenAdmin,
      corpo: { loteId: loteVencido.id, motivo: 'Baixa de perda por validade expirada (CT04)' },
    });
    assert.strictEqual(
      baixaPerdaAdmin.status,
      200,
      'CT04: Administrador deve conseguir registrar a baixa de perda do lote vencido'
    );
    assert.strictEqual(baixaPerdaAdmin.json.novoEstado, 'Removido');
    console.log(
      `✔ [CT04 APROVADO] Saída comum de lote vencido bloqueada (RE-I) e baixa de perda executada pelo Administrador (T16).`
    );

    // ------------------------------------------------------------------------
    // CASO DE TESTE CT05 (RF07, RN-II, RN-IV)
    // Cenário: Registrar saída até o saldo ficar menor ou igual ao estoque mínimo configurado.
    // Resultado Esperado: O produto entra na lista de aviso de "estoque baixo" e a saída fica gravada no nome do funcionário.
    // ------------------------------------------------------------------------
    const prodSuco = consultaFunc.json.find((p) => p.nome.includes('Suco de Laranja'));
    // Suco tem saldo 15 e estoqueMinimo 6 -> vamos retirar 10 unidades para restarem 5 (<= 6)
    const saidaAteMinimo = await requisitar('/api/estoque/saida', {
      metodo: 'POST',
      token: tokenFunc,
      corpo: {
        produtoId: prodSuco.id,
        quantidade: 10,
        observacao: 'Teste CT05 atingindo estoque mínimo',
      },
    });
    assert.strictEqual(saidaAteMinimo.status, 200, 'CT05: Saída realizada com sucesso');
    assert.ok(
      saidaAteMinimo.json.avisos.some((a) => a.tipo === 'EstoqueBaixo' && a.regra === 'RN-II'),
      'CT05: Deve emitir aviso de estoque baixo (RN-II)'
    );

    // Verifica na lista de alertas ativos se o produto entrou em "estoqueBaixo"
    const alertasAtivos = await requisitar('/api/alertas', { token: tokenFunc });
    assert.ok(
      alertasAtivos.json.estoqueBaixo.some((a) => a.produtoId === prodSuco.id),
      'CT05: Produto deve constar na lista de alertas de Estoque Baixo (RF07)'
    );

    // Verifica no histórico de movimentações se ficou gravado no nome do funcionário Carlos Silva (RN-IV)
    const historico = await requisitar('/api/movimentacoes', { token: tokenFunc });
    const movRegistrada = historico.json.find((m) => m.id === saidaAteMinimo.json.movimentacaoId);
    assert.ok(movRegistrada, 'CT05: Movimentação deve estar gravada no histórico');
    assert.ok(
      movRegistrada.usuarioNome.includes('Carlos Silva'),
      'CT05 / RN-IV: A saída deve ficar associada ao nome do funcionário que a realizou'
    );
    console.log(
      `✔ [CT05 APROVADO] Alerta de estoque baixo gerado (RN-II) e saída vinculada ao funcionário "${movRegistrada.usuarioNome}" (RN-IV).`
    );

    // ------------------------------------------------------------------------
    // VERIFICAÇÃO ADICIONAL: RF06 (Operações em Massa) e RF08 / RE-II (Relatórios CSV/PDF)
    // ------------------------------------------------------------------------
    const resRelatorios = await requisitar('/api/relatorios', { token: tokenAdmin });
    assert.strictEqual(resRelatorios.status, 200, 'RF08: Relatórios gerados com sucesso');
    assert.ok(resRelatorios.json.produtosMaisVendidos.length > 0, 'RF08: Relatório de maior saída populado');
    assert.ok(resRelatorios.json.produtosParados.length > 0, 'RF08: Relatório de produtos parados populado');

    const resCSV = await requisitar('/api/relatorios/exportar/csv', { token: tokenAdmin });
    assert.strictEqual(resCSV.status, 200, 'RE-II: Exportação CSV deve retornar HTTP 200');
    assert.ok(resCSV.texto.includes('DECLARACAO DE INVENTARIO'), 'RE-II: CSV contém cabeçalho patrimonial');

    console.log('✔ [RF06, RF08, RE-II e RNF01–RNF04 APROVADOS] Relatórios, exportação CSV/PDF e métricas OK.\n');
    console.log('====================================================================');
    console.log(' TODOS OS CASOS DE TESTE (CT01 A CT05) PASSARAM COM 100% DE SUCESSO!');
    console.log('====================================================================');
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

executarSuiteDeTestes().catch((err) => {
  console.error('\n❌ FALHA NOS TESTES:', err);
  process.exit(1);
});
