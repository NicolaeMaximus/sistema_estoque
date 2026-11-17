// Controle de sessão e permissões de acesso (Administrador e Funcionário)
const crypto = require('crypto');

const sessoesAtivas = new Map();

function criarSessao(usuario) {
  const token = crypto.randomBytes(24).toString('hex');
  sessoesAtivas.set(token, {
    id: usuario.id,
    nome: usuario.nome,
    login: usuario.login,
    perfil: usuario.perfil,
    criadoEm: Date.now(),
  });
  return token;
}

function encerrarSessao(token) {
  if (token) sessoesAtivas.delete(token);
}

function extrairToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  if (req.headers['x-auth-token']) {
    return String(req.headers['x-auth-token']).trim();
  }
  if (req.query && req.query.token) {
    return String(req.query.token).trim();
  }
  return null;
}

function exigirAutenticacao(req, res, next) {
  const token = extrairToken(req);
  if (!token || !sessoesAtivas.has(token)) {
    return res.status(401).json({
      erro: 'Sessão inválida ou expirada. Faça login novamente.',
    });
  }
  req.usuario = sessoesAtivas.get(token);
  req.token = token;
  next();
}

// Bloqueia acesso de Funcionários a rotas exclusivas do Administrador (HTTP 403)
function exigirAdministrador(req, res, next) {
  if (!req.usuario) {
    return res.status(401).json({ erro: 'Não autenticado.' });
  }
  if (req.usuario.perfil !== 'Administrador') {
    return res.status(403).json({
      erro: 'Acesso negado (HTTP 403): operação permitida apenas para Administrador.',
      perfilAtual: req.usuario.perfil,
    });
  }
  next();
}

module.exports = {
  sessoesAtivas,
  criarSessao,
  encerrarSessao,
  extrairToken,
  exigirAutenticacao,
  exigirAdministrador,
};
