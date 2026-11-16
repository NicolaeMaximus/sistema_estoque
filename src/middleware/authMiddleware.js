/**
 * ============================================================================
 * ECOT11A - LABORATÓRIO DE ENGENHARIA DE SOFTWARE (UNIFEI)
 * Projeto: Sistema de Controle de Estoque da Mercearia
 * Autor: Nicolae Lopes - Matrícula: 2024014650
 * ----------------------------------------------------------------------------
 * Módulo: Middleware de Autenticação e Controle de Acesso (src/middleware/authMiddleware.js)
 * Tarefas Relacionadas:
 *   - T03: Autenticação e perfis (Administrador/Funcionário)
 *   - T22: Segurança (hash de senhas e controle de sessão por perfil)
 * Requisitos Atendidos:
 *   - RF01: Login e controle de perfil (Administrador vs Funcionário)
 *   - RNF02: Rotas restritas ao Administrador devem bloquear acessos de Funcionários com código HTTP 403
 *   - CT01: Bloqueio de tentativa de cadastro por usuário do tipo Funcionário
 * ============================================================================
 */

const crypto = require('crypto');

// Armazenamento em memória das sessões ativas (token -> dados do usuário logado)
const sessoesAtivas = new Map();

/**
 * Cria um novo token de sessão criptograficamente seguro usando o módulo nativo crypto (Seção 9).
 * @param {object} usuario - Objeto do usuário autenticado ({ id, nome, login, perfil })
 * @returns {string} Token hexadecimal gerado
 */
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

/**
 * Remove uma sessão ativa no momento do logout.
 * @param {string} token - Token da sessão
 */
function encerrarSessao(token) {
  if (token) {
    sessoesAtivas.delete(token);
  }
}

/**
 * Extrai o token de autenticação do cabeçalho HTTP Authorization ou x-auth-token.
 * @param {object} req - Objeto Request do Express
 * @returns {string|null}
 */
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

/**
 * Middleware que verifica se o usuário está devidamente autenticado (RF01).
 */
function exigirAutenticacao(req, res, next) {
  const token = extrairToken(req);
  if (!token || !sessoesAtivas.has(token)) {
    return res.status(401).json({
      erro: 'Não autenticado. Faça login no sistema para acessar este recurso.',
    });
  }
  req.usuario = sessoesAtivas.get(token);
  req.token = token;
  next();
}

/**
 * Middleware que restringe a rota exclusivamente ao perfil 'Administrador' (RF01, RF02, RF03, RNF02, CT01).
 * Caso um 'Funcionario' tente acessar, bloqueia com código HTTP 403 conforme especificado no RNF02.
 */
function exigirAdministrador(req, res, next) {
  if (!req.usuario) {
    return res.status(401).json({
      erro: 'Não autenticado.',
    });
  }
  if (req.usuario.perfil !== 'Administrador') {
    return res.status(403).json({
      erro: 'Acesso negado (HTTP 403): Esta operação é exclusiva para o perfil Administrador.',
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
