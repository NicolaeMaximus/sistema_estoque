// Servidor Express - Sistema de Controle de Estoque da Mercearia
const express = require('express');
const path = require('path');
const { inicializarBanco } = require('./database/db');
const { exigirAutenticacao, exigirAdministrador } = require('./middleware/authMiddleware');
const authController = require('./controllers/authController');
const produtoController = require('./controllers/produtoController');
const estoqueController = require('./controllers/estoqueController');
const relatorioController = require('./controllers/relatorioController');

inicializarBanco();

const app = express();
app.use(express.json());

// Autenticação e usuários
app.post('/api/auth/login', authController.login);
app.post('/api/auth/logout', exigirAutenticacao, authController.logout);
app.get('/api/auth/me', exigirAutenticacao, authController.obterPerfilAtual);

app.get('/api/usuarios', exigirAutenticacao, exigirAdministrador, authController.listarUsuarios);
app.post('/api/usuarios', exigirAutenticacao, exigirAdministrador, authController.cadastrarUsuario);
app.put('/api/usuarios/:id', exigirAutenticacao, exigirAdministrador, authController.atualizarUsuario);
app.delete('/api/usuarios/:id', exigirAutenticacao, exigirAdministrador, authController.removerUsuario);

// Produtos
app.get('/api/produtos', exigirAutenticacao, produtoController.listarProdutos);
app.get('/api/produtos/:id', exigirAutenticacao, produtoController.obterProdutoPorId);
app.post('/api/produtos', exigirAutenticacao, exigirAdministrador, produtoController.cadastrarProduto);
app.put('/api/produtos/:id', exigirAutenticacao, exigirAdministrador, produtoController.editarProduto);
app.delete('/api/produtos/:id', exigirAutenticacao, exigirAdministrador, produtoController.removerProduto);

// Estoque, lotes, alertas e movimentações
app.get('/api/lotes', exigirAutenticacao, estoqueController.listarLotes);
app.get('/api/alertas', exigirAutenticacao, estoqueController.listarAlertas);
app.get('/api/movimentacoes', exigirAutenticacao, estoqueController.listarMovimentacoes);

app.post('/api/estoque/entrada', exigirAutenticacao, exigirAdministrador, estoqueController.registrarEntrada);
app.post('/api/estoque/saida', exigirAutenticacao, estoqueController.registrarSaida);
app.post('/api/estoque/perda', exigirAutenticacao, exigirAdministrador, estoqueController.registrarBaixaPerda);
app.post('/api/estoque/massa', exigirAutenticacao, estoqueController.operacaoEmMassa);

// Relatórios e exportação
app.get('/api/relatorios', exigirAutenticacao, exigirAdministrador, relatorioController.obterRelatorios);
app.get('/api/relatorios/exportar/csv', exigirAutenticacao, exigirAdministrador, relatorioController.exportarCSV);
app.get('/api/relatorios/exportar/pdf', exigirAutenticacao, exigirAdministrador, relatorioController.exportarPDF);

// Arquivos estáticos do front-end
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Servidor iniciado em http://localhost:${PORT}`);
  });
}

module.exports = app;
