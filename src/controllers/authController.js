// Autenticação de usuários e gerenciamento de funcionários
const {
  db,
  gerarHashSenha,
  verificarSenha,
  sincronizarEstadosEAlertas,
} = require('../database/db');
const { criarSessao, encerrarSessao } = require('../middleware/authMiddleware');

function login(req, res) {
  const { login: userLogin, senha } = req.body || {};

  if (!userLogin || !senha) {
    return res.status(400).json({
      erro: 'Informe o usuário e a senha.',
    });
  }

  const usuario = db
    .prepare('SELECT * FROM Usuario WHERE login = ?')
    .get(String(userLogin).trim());

  if (!usuario || !verificarSenha(senha, usuario.senhaHash)) {
    return res.status(401).json({
      erro: 'Usuário ou senha incorretos.',
    });
  }

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

function logout(req, res) {
  encerrarSessao(req.token);
  return res.status(200).json({ mensagem: 'Sessão encerrada.' });
}

function obterPerfilAtual(req, res) {
  return res.status(200).json({ usuario: req.usuario });
}

function listarUsuarios(req, res) {
  const usuarios = db
    .prepare(`
      SELECT u.id, u.nome, u.login, u.perfil,
             COUNT(m.id) AS totalMovimentacoes
      FROM Usuario u
      LEFT JOIN Movimentacao m ON m.usuarioId = u.id
      GROUP BY u.id
      ORDER BY u.perfil ASC, u.nome ASC
    `)
    .all();
  return res.status(200).json(usuarios);
}

function cadastrarUsuario(req, res) {
  const { nome, login: novoLogin, senha, perfil } = req.body || {};

  if (!nome || !novoLogin || !senha) {
    return res.status(400).json({
      erro: 'Preencha nome, login e senha.',
    });
  }

  const perfilFinal = perfil === 'Administrador' ? 'Administrador' : 'Funcionario';
  const loginLimpo = String(novoLogin).trim();

  const existente = db.prepare('SELECT id FROM Usuario WHERE login = ?').get(loginLimpo);
  if (existente) {
    return res.status(409).json({
      erro: `O login "${loginLimpo}" já está cadastrado.`,
    });
  }

  const info = db
    .prepare('INSERT INTO Usuario (nome, login, senhaHash, perfil) VALUES (?, ?, ?, ?)')
    .run(String(nome).trim(), loginLimpo, gerarHashSenha(senha), perfilFinal);

  return res.status(201).json({
    mensagem: 'Funcionário cadastrado com sucesso.',
    usuario: {
      id: Number(info.lastInsertRowid),
      nome: String(nome).trim(),
      login: loginLimpo,
      perfil: perfilFinal,
    },
  });
}

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
    mensagem: 'Usuário atualizado com sucesso.',
    usuario: { id, nome: novoNome, login: usuario.login, perfil: novoPerfil },
  });
}

function removerUsuario(req, res) {
  const id = Number(req.params.id);
  if (id === req.usuario.id) {
    return res.status(400).json({
      erro: 'Não é permitido excluir o próprio usuário logado.',
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
      erro: 'Não é possível excluir um funcionário que já possui movimentações registradas.',
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
