/**
 * ============================================================================
 * ECOT11A - LABORATÓRIO DE ENGENHARIA DE SOFTWARE (UNIFEI)
 * Projeto: Sistema de Controle de Estoque da Mercearia
 * Autor: Nicolae Lopes - Matrícula: 2024014650
 * ----------------------------------------------------------------------------
 * Módulo: Controlador de Autenticação e Usuários (src/controllers/authController.js)
 * Tarefas Relacionadas:
 *   - T03: Autenticação e perfis (Administrador/Funcionário)
 *   - T04: Cadastro de funcionários (somente administrador)
 *   - T15: Aviso de vencimento próximo e estoque baixo no login
 * Requisitos Atendidos:
 *   - RF01: Login e controle de perfil
 *   - RF02: Cadastro e gerenciamento de contas de funcionários
 *   - RNF02: Hash de senha com SHA-256/scrypt e bloqueio HTTP 403
 *   - RNF04: Exibição separada dos alertas logo após o login
 * ============================================================================
 */

const {
  db,
  gerarHashSenha,
  verificarSenha,
  sincronizarEstadosEAlertas,
} = require('../database/db');
const { criarSessao, encerrarSessao } = require('../middleware/authMiddleware');

/**
 * Realiza o login do usuário (Método Usuario.autenticar() do Diagrama de Classes - Seção 6.2).
 * Rota: POST /api/auth/login
 */
function login(req, res) {
  const { login: userLogin, senha } = req.body || {};

  if (!userLogin || !senha) {
    return res.status(400).json({
      erro: 'Informe o login e a senha para entrar no sistema.',
    });
  }

  const usuario = db
    .prepare('SELECT * FROM Usuario WHERE login = ?')
    .get(String(userLogin).trim());

  if (!usuario || !verificarSenha(senha, usuario.senhaHash)) {
    return res.status(401).json({
      erro: 'Credenciais inválidas. Verifique seu usuário e senha.',
    });
  }

  // Sincroniza os estados dos lotes e gera os alertas atualizados no momento do login (T15 / RNF04)
  sincronizarEstadosEAlertas();

  const alertasEstoque = db
    .prepare("SELECT * FROM Alerta WHERE tipo = 'Estoque' AND resolvido = 0 ORDER BY id DESC")
    .all();
  const alertasValidade = db
    .prepare("SELECT * FROM Alerta WHERE tipo = 'Validade' AND resolvido = 0 ORDER BY id ASC")
    .all();

  const token = criarSessao(usuario);

  return res.status(200).json({
    mensagem: 'Login realizado com sucesso.',
    token,
    usuario: {
      id: usuario.id,
      nome: usuario.nome,
      login: usuario.login,
      perfil: usuario.perfil,
    },
    alertasNoLogin: {
      estoqueBaixo: alertasEstoque,
      validadeProximaOuVencida: alertasValidade,
    },
  });
}

/**
 * Realiza o logout da sessão atual.
 * Rota: POST /api/auth/logout
 */
function logout(req, res) {
  encerrarSessao(req.token);
  return res.status(200).json({ mensagem: 'Sessão encerrada com sucesso.' });
}

/**
 * Retorna os dados do usuário autenticado.
 * Rota: GET /api/auth/me
 */
function obterPerfilAtual(req, res) {
  return res.status(200).json({ usuario: req.usuario });
}

/**
 * Lista todos os usuários/funcionários cadastrados (Restrito ao Administrador - RF02).
 * Rota: GET /api/usuarios
 */
function listarUsuarios(req, res) {
  const usuarios = db
    .prepare(`
      SELECT u.id, u.nome, u.login, u.perfil,
             (SELECT COUNT(*) FROM Movimentacao m WHERE m.usuarioId = u.id) AS totalMovimentacoes
      FROM Usuario u
      ORDER BY u.perfil ASC, u.nome ASC
    `)
    .all();
  return res.status(200).json(usuarios);
}

/**
 * Cadastra um novo funcionário ou administrador (Método Usuario.cadastrarFuncionario() - RF02, T04, CT01).
 * Rota: POST /api/usuarios
 */
function cadastrarUsuario(req, res) {
  const { nome, login: novoLogin, senha, perfil } = req.body || {};

  if (!nome || !novoLogin || !senha) {
    return res.status(400).json({
      erro: 'Nome, login e senha são obrigatórios para cadastrar um funcionário.',
    });
  }

  const perfilFinal = perfil === 'Administrador' ? 'Administrador' : 'Funcionario';

  const existente = db
    .prepare('SELECT id FROM Usuario WHERE login = ?')
    .get(String(novoLogin).trim());
  if (existente) {
    return res.status(409).json({
      erro: `O login "${novoLogin}" já está em uso por outro usuário.`,
    });
  }

  const senhaHash = gerarHashSenha(senha);
  const info = db
    .prepare('INSERT INTO Usuario (nome, login, senhaHash, perfil) VALUES (?, ?, ?, ?)')
    .run(String(nome).trim(), String(novoLogin).trim(), senhaHash, perfilFinal);

  return res.status(201).json({
    mensagem: 'Usuário cadastrado com sucesso.',
    usuario: {
      id: Number(info.lastInsertRowid),
      nome: String(nome).trim(),
      login: String(novoLogin).trim(),
      perfil: perfilFinal,
    },
  });
}

/**
 * Atualiza dados ou senha de um usuário/funcionário (RF02).
 * Rota: PUT /api/usuarios/:id
 */
function atualizarUsuario(req, res) {
  const id = Number(req.params.id);
  const { nome, perfil, novaSenha } = req.body || {};

  const usuario = db.prepare('SELECT * FROM Usuario WHERE id = ?').get(id);
  if (!usuario) {
    return res.status(404).json({ erro: 'Usuário não encontrado.' });
  }

  const novoNome = nome ? String(nome).trim() : usuario.nome;
  const novoPerfil =
    perfil && ['Administrador', 'Funcionario'].includes(perfil) ? perfil : usuario.perfil;
  const novoHash = novaSenha ? gerarHashSenha(novaSenha) : usuario.senhaHash;

  db.prepare('UPDATE Usuario SET nome = ?, perfil = ?, senhaHash = ? WHERE id = ?').run(
    novoNome,
    novoPerfil,
    novoHash,
    id
  );

  return res.status(200).json({
    mensagem: 'Dados do usuário atualizados com sucesso.',
    usuario: { id, nome: novoNome, login: usuario.login, perfil: novoPerfil },
  });
}

/**
 * Remove uma conta de funcionário caso não seja o próprio administrador logado (RF02).
 * Rota: DELETE /api/usuarios/:id
 */
function removerUsuario(req, res) {
  const id = Number(req.params.id);
  if (id === req.usuario.id) {
    return res.status(400).json({
      erro: 'Você não pode excluir a sua própria conta de Administrador em uso.',
    });
  }

  const usuario = db.prepare('SELECT * FROM Usuario WHERE id = ?').get(id);
  if (!usuario) {
    return res.status(404).json({ erro: 'Usuário não encontrado.' });
  }

  const movs = db
    .prepare('SELECT COUNT(*) AS total FROM Movimentacao WHERE usuarioId = ?')
    .get(id).total;
  if (movs > 0) {
    return res.status(400).json({
      erro: 'Não é possível excluir um funcionário que já possui movimentações registradas no histórico (RN-IV).',
    });
  }

  db.prepare('DELETE FROM Usuario WHERE id = ?').run(id);
  return res.status(200).json({ mensagem: 'Funcionário removido com sucesso.' });
}

module.exports = {
  login,
  logout,
  obterPerfilAtual,
  listarUsuarios,
  cadastrarUsuario,
  atualizarUsuario,
  removerUsuario,
};
