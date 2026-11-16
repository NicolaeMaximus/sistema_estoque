/**
 * ============================================================================
 * ECOT11A - LABORATÓRIO DE ENGENHARIA DE SOFTWARE (UNIFEI)
 * Projeto: Sistema de Controle de Estoque da Mercearia
 * Autor: Nicolae Lopes - Matrícula: 2024014650
 * Prof.: Edvard
 * ----------------------------------------------------------------------------
 * Módulo Principal do Servidor (src/server.js)
 * Arquitetura: Cliente-Servidor em 3 camadas (Padrão MVC - Seção 7)
 *   1. Apresentação (Front-end): HTML5, CSS3 e Vanilla JS em /public
 *   2. Aplicação / Negócio (Back-end): Node.js + Express em /src/controllers
 *   3. Dados (Banco de Dados): SQLite (estoque.db) em /src/database/db.js
 * ============================================================================
 */

const express = require('express');
const path = require('path');
const { inicializarBanco } = require('./database/db');
const { exigirAutenticacao, exigirAdministrador } = require('./middleware/authMiddleware');
const authController = require('./controllers/authController');
const produtoController = require('./controllers/produtoController');
const estoqueController = require('./controllers/estoqueController');
const relatorioController = require('./controllers/relatorioController');

// Inicializa o banco de dados SQLite e executa o seed inicial se necessário
inicializarBanco();

const app = express();
app.use(express.json());

// Middleware de medição de desempenho para comprovar o RNF01 (tempo de resposta < 500ms)
app.use((req, res, next) => {
  const inicio = process.hrtime.bigint();
  res.on('finish', () => {
    const duracaoMs = Number(process.hrtime.bigint() - inicio) / 1e6;
    if (process.env.LOG_PERF === '1') {
      console.log(`[RNF01] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${duracaoMs.toFixed(2)} ms)`);
    }
  });
  next();
});

// ============================================================================
// ROTAS DA API REST (Camada de Aplicação / Negócio)
// ============================================================================

// --- Autenticação e Perfis (RF01, RNF02, T03) ---
app.post('/api/auth/login', authController.login);
app.post('/api/auth/logout', exigirAutenticacao, authController.logout);
app.get('/api/auth/me', exigirAutenticacao, authController.obterPerfilAtual);

// --- Gestão de Funcionários (RF02, RNF02, T04, CT01 - Exclusivo Administrador) ---
app.get('/api/usuarios', exigirAutenticacao, exigirAdministrador, authController.listarUsuarios);
app.post('/api/usuarios', exigirAutenticacao, exigirAdministrador, authController.cadastrarUsuario);
app.put('/api/usuarios/:id', exigirAutenticacao, exigirAdministrador, authController.atualizarUsuario);
app.delete('/api/usuarios/:id', exigirAutenticacao, exigirAdministrador, authController.removerUsuario);

// --- Catálogo de Produtos (RF03, T05, T06, CT01) ---
// Consulta liberada para Funcionário e Administrador; criação/edição/exclusão restritas ao Administrador
app.get('/api/produtos', exigirAutenticacao, produtoController.listarProdutos);
app.get('/api/produtos/:id', exigirAutenticacao, produtoController.obterProdutoPorId);
app.post('/api/produtos', exigirAutenticacao, exigirAdministrador, produtoController.cadastrarProduto);
app.put('/api/produtos/:id', exigirAutenticacao, exigirAdministrador, produtoController.editarProduto);
app.delete('/api/produtos/:id', exigirAutenticacao, exigirAdministrador, produtoController.removerProduto);

// --- Controle de Estoque, Lotes, Saída FEFO e Alertas (RF04 a RF07, RN-I a RN-IV, RE-I) ---
app.get('/api/lotes', exigirAutenticacao, estoqueController.listarLotes);
app.get('/api/alertas', exigirAutenticacao, estoqueController.listarAlertas);
app.get('/api/movimentacoes', exigirAutenticacao, estoqueController.listarMovimentacoes);

// Entrada de Lote (RF04, T08 - Restrito ao Administrador conforme Seção 4 e Diagrama de Casos de Uso Seção 6.1)
app.post('/api/estoque/entrada', exigirAutenticacao, exigirAdministrador, estoqueController.registrarEntrada);

// Saída de Estoque (RF05, RS001, T09, CT02, CT03, CT04, CT05 - Funcionário e Administrador)
app.post('/api/estoque/saida', exigirAutenticacao, estoqueController.registrarSaida);

// Baixa de Perda de Lote Vencido (RE-I, T16, CT04 - Exclusivo Administrador)
app.post('/api/estoque/perda', exigirAutenticacao, exigirAdministrador, estoqueController.registrarBaixaPerda);

// Adição e Remoção em Massa (RF06, T17)
app.post('/api/estoque/massa', exigirAutenticacao, estoqueController.operacaoEmMassa);

// --- Relatórios e Exportação CSV/PDF (RF08, RE-II, T19, T20, T21 - Exclusivo Administrador) ---
app.get('/api/relatorios', exigirAutenticacao, exigirAdministrador, relatorioController.obterRelatorios);
app.get('/api/relatorios/exportar/csv', exigirAutenticacao, exigirAdministrador, relatorioController.exportarCSV);
app.get('/api/relatorios/exportar/pdf', exigirAutenticacao, exigirAdministrador, relatorioController.exportarPDF);

// ============================================================================
// CAMADA DE APRESENTAÇÃO (Arquivos Estáticos Front-end HTML5/CSS3/Vanilla JS)
// ============================================================================
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Inicialização do servidor apenas se executado diretamente (permite importar 'app' nos testes CT01-CT05)
const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log('====================================================================');
    console.log(' SISTEMA DE CONTROLE DE ESTOQUE DA MERCEARIA (MVP - ECOT11A UNIFEI)');
    console.log(' Autor: Nicolae Lopes (2024014650)');
    console.log(` Servidor rodando em: http://localhost:${PORT}`);
    console.log(' Credenciais de demonstração:');
    console.log('   - Administrador: login "admin"   | senha "admin123"');
    console.log('   - Funcionário:   login "carlos"  | senha "func123"');
    console.log('====================================================================');
  });
}

module.exports = app;
