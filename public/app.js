/**
 * ============================================================================
 * ECOT11A - LABORATÓRIO DE ENGENHARIA DE SOFTWARE (UNIFEI)
 * Projeto: Sistema de Controle de Estoque da Mercearia
 * Autor: Nicolae Lopes - Matrícula: 2024014650
 * ----------------------------------------------------------------------------
 * Módulo: Camada de Apresentação Front-end (public/app.js - Vanilla JS)
 * Padrão de Design: "Gestão Online" (vendas_1.jpg)
 * ============================================================================
 */

let estadoApp = {
  token: localStorage.getItem('estoque_token') || null,
  usuario: JSON.parse(localStorage.getItem('estoque_usuario') || 'null'),
  produtos: [],
  alertas: { estoqueBaixo: [], validadeProximaOuVencida: [] },
  movimentacoes: [],
};

/**
 * Requisição HTTP autenticada à API Express.
 */
async function apiFetch(url, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  if (estadoApp.token) {
    headers.Authorization = `Bearer ${estadoApp.token}`;
  }

  const resposta = await fetch(url, { ...options, headers });
  const dados = await resposta.json().catch(() => ({}));

  if (!resposta.ok) {
    const erro = new Error(dados.erro || `Erro HTTP ${resposta.status}`);
    erro.status = resposta.status;
    erro.dados = dados;
    throw erro;
  }
  return dados;
}

/**
 * Exibe notificação (toast) de feedback no topo.
 */
function exibirToast(mensagem, tipo = 'success') {
  const toast = document.getElementById('global-toast');
  toast.textContent = mensagem;
  toast.className = `toast toast-${tipo}`;
  toast.classList.remove('hidden');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => {
    toast.classList.add('hidden');
  }, 7000);
}

function preencherLogin(login, senha) {
  document.getElementById('login-input').value = login;
  document.getElementById('senha-input').value = senha;
}

/**
 * Recolhe/expande a barra lateral azul ao clicar no botão ☰.
 */
function alternarSidebar() {
  document.getElementById('erp-sidebar').classList.toggle('collapsed');
}

/**
 * Filtra os itens do menu lateral ("Procurar opção do menu..." igual ao vendas_1.jpg).
 */
function filtrarMenuSidebar(termo) {
  const busca = String(termo || '').trim().toLowerCase();
  const isAdmin = estadoApp.usuario?.perfil === 'Administrador';

  document.querySelectorAll('.sidebar-link').forEach((btn) => {
    if (btn.classList.contains('admin-only') && !isAdmin) {
      btn.classList.add('hidden');
      return;
    }
    const texto = btn.innerText.toLowerCase();
    btn.classList.toggle('hidden', busca !== '' && !texto.includes(busca));
  });
}

/**
 * Alterna entre as seções do menu lateral.
 */
function irParaAba(tabId) {
  let tituloPagina = 'Painel';
  document.querySelectorAll('.sidebar-link').forEach((btn) => {
    const ativo = btn.dataset.tab === tabId;
    btn.classList.toggle('active', ativo);
    if (ativo && btn.dataset.title) {
      tituloPagina = btn.dataset.title;
    }
  });

  document.getElementById('topbar-page-title').textContent = tituloPagina;

  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === tabId);
  });

  if (tabId === 'tab-relatorios' && estadoApp.usuario?.perfil === 'Administrador') {
    carregarRelatorios();
  }
  if (tabId === 'tab-usuarios' && estadoApp.usuario?.perfil === 'Administrador') {
    carregarUsuarios();
  }
}

/**
 * Configura permissões visuais conforme o perfil logado (Administrador vs Funcionario).
 */
function aplicarPermissoesDePerfil() {
  const isAdmin = estadoApp.usuario && estadoApp.usuario.perfil === 'Administrador';
  document.querySelectorAll('.admin-only').forEach((el) => {
    el.classList.toggle('hidden', !isAdmin);
  });

  const boxCt01 = document.getElementById('box-teste-ct01');
  if (boxCt01) {
    boxCt01.classList.toggle('hidden', isAdmin);
  }

  document.getElementById('user-nome').textContent = estadoApp.usuario.nome;
  const badge = document.getElementById('user-perfil-badge');
  badge.textContent = estadoApp.usuario.perfil;
  badge.className = `badge ${isAdmin ? 'badge-admin' : 'badge-func'}`;
}

/**
 * Carrega todos os dados do painel.
 */
async function carregarTudo() {
  try {
    const [produtos, alertas, movs] = await Promise.all([
      apiFetch('/api/produtos'),
      apiFetch('/api/alertas'),
      apiFetch('/api/movimentacoes?limite=100'),
    ]);

    estadoApp.produtos = produtos;
    estadoApp.alertas = alertas;
    estadoApp.movimentacoes = movs;

    renderizarDashboardGestaoOnline();
    renderizarTabelaProdutos();
    popularSelectsDeProdutos();
    renderizarTabelaMovimentacoes();
  } catch (err) {
    if (err.status === 401) {
      fazerLogout();
    } else {
      exibirToast(err.message, 'error');
    }
  }
}

/**
 * Renderiza o Painel Principal seguindo exatamente o design de vendas_1.jpg:
 *   1. Os 4 cards coloridos (Ciano, Laranja, Verde, Vermelho)
 *   2. A mini tabela de últimas movimentações à esquerda (com badges VENDA/SAÍDA, ENTRADA, PERDA)
 *   3. O gráfico de barras 3D azul-claro no centro (Estoque Disponível por Categoria)
 *   4. Os 2 painéis inferiores com abas flutuantes para os Alertas Separados (RF07 / RNF04)
 */
function renderizarDashboardGestaoOnline() {
  const { estoqueBaixo, validadeProximaOuVencida } = estadoApp.alertas;
  const totalAlertas = estoqueBaixo.length + validadeProximaOuVencida.length;

  // 1. Valores dos 4 Cards Coloridos e Sino de Notificações
  document.getElementById('kpi-total-produtos').textContent = estadoApp.produtos.length;
  document.getElementById('kpi-estoque-baixo').textContent = estoqueBaixo.length;
  document.getElementById('kpi-validade').textContent = validadeProximaOuVencida.length;
  document.getElementById('kpi-movimentacoes').textContent = estadoApp.movimentacoes.length;
  document.getElementById('bell-count').textContent = totalAlertas;

  document.getElementById('badge-count-estoque').textContent = estoqueBaixo.length;
  document.getElementById('badge-count-validade').textContent = validadeProximaOuVencida.length;

  // 2. Mini Tabela Esquerda (Últimas Movimentações estilo Cliente | Total | Badge)
  const miniBody = document.getElementById('mini-movimentacoes-body');
  const ultimas5 = estadoApp.movimentacoes.slice(0, 5);
  if (ultimas5.length === 0) {
    miniBody.innerHTML = '<tr><td colspan="3" class="muted">Sem movimentações recentes.</td></tr>';
  } else {
    miniBody.innerHTML = ultimas5
      .map((m) => {
        const pillClass =
          m.tipo === 'Saida'
            ? 'pill-venda'
            : m.tipo === 'Entrada'
            ? 'pill-orcamento'
            : 'pill-perda';
        const pillText = m.tipo === 'Saida' ? 'SAÍDA' : m.tipo === 'Entrada' ? 'ENTRADA' : 'PERDA';
        return `
          <tr>
            <td>
              <strong>${m.produtoNome}</strong><br/>
              <small class="muted">${m.usuarioNome.split(' ')[0]}</small>
            </td>
            <td><strong>${Number(m.quantidade).toFixed(2).replace('.', ',')}</strong></td>
            <td><span class="${pillClass}">${pillText}</span></td>
          </tr>
        `;
      })
      .join('');
  }

  // 3. Gráfico de Barras 3D Central (Saldo Disponível por Categoria)
  const categorias = [
    { nome: 'Mercearia Seca', curto: 'Mercearia' },
    { nome: 'Laticínios e Frios', curto: 'Laticínios' },
    { nome: 'Hortifrúti', curto: 'Hortifrúti' },
    { nome: 'Bebidas', curto: 'Bebidas' },
    { nome: 'Limpeza e Higiene', curto: 'Limpeza' },
  ];

  const totaisCat = categorias.map((c) => {
    const soma = estadoApp.produtos
      .filter((p) => p.categoria === c.nome)
      .reduce((acc, p) => acc + Number(p.saldoDisponivel || 0), 0);
    return { ...c, total: Number(soma.toFixed(1)) };
  });

  const maiorValor = Math.max(...totaisCat.map((c) => c.total), 10);
  const chartArea = document.getElementById('grafico-categorias-bars');
  chartArea.innerHTML = totaisCat
    .map((c) => {
      const alturaPx = Math.max(Math.round((c.total / maiorValor) * 145), 10);
      return `
        <div class="chart-col" title="${c.nome}: ${c.total} disponíveis">
          <span class="chart-bar-val">${c.total.toFixed(2).replace('.', ',')}</span>
          <div class="chart-bar-3d" style="height: ${alturaPx}px;"></div>
          <span class="chart-bar-label">${c.curto}</span>
        </div>
      `;
    })
    .join('');

  // 4. Painéis Inferiores de Alertas Separados (RF07 / RNF04)
  const containerEstoque = document.getElementById('lista-alertas-estoque');
  if (estoqueBaixo.length === 0) {
    containerEstoque.innerHTML = '<p class="muted">Nenhum produto com estoque baixo no momento.</p>';
  } else {
    containerEstoque.innerHTML = estoqueBaixo
      .map(
        (a) => `
        <div class="alert-item alert-item-warning">
          <div>
            <strong>${a.produtoNome || 'Produto'}</strong> <span class="badge badge-warning">Estoque Baixo (RN-II)</span>
            <div>${a.mensagem}</div>
          </div>
          ${
            estadoApp.usuario.perfil === 'Administrador'
              ? `<button class="btn btn-outline btn-sm" onclick="preencherEntradaRapida(${a.produtoId})">Repor Lote</button>`
              : ''
          }
        </div>
      `
      )
      .join('');
  }

  const containerValidade = document.getElementById('lista-alertas-validade');
  if (validadeProximaOuVencida.length === 0) {
    containerValidade.innerHTML = '<p class="muted">Nenhum lote próximo do vencimento ou vencido.</p>';
  } else {
    containerValidade.innerHTML = validadeProximaOuVencida
      .map((a) => {
        const isVencido = a.estadoLote === 'Vencido';
        return `
        <div class="alert-item ${isVencido ? 'alert-item-danger' : 'alert-item-warning'}">
          <div>
            <strong>${a.produtoNome || 'Produto'} — Lote [${a.codigoLote || '-'}]</strong>
            <span class="badge ${isVencido ? 'badge-danger' : 'badge-warning'}">
              ${isVencido ? 'VENCIDO - Bloqueado (RE-I)' : 'Vencimento Próximo (RN-III)'}
            </span>
            <div>${a.mensagem}</div>
          </div>
          <div>
            ${
              isVencido && estadoApp.usuario.perfil === 'Administrador'
                ? `<button class="btn btn-danger btn-sm" onclick="confirmarBaixaPerda(${a.loteId}, '${a.codigoLote}')">Baixar Perda (T16)</button>`
                : ''
            }
          </div>
        </div>
      `;
      })
      .join('');
  }
}

function renderizarBadgeEstadoLote(estado) {
  const mapa = {
    Disponivel: { classe: 'badge-success', texto: 'Disponível' },
    EstoqueBaixo: { classe: 'badge-warning', texto: 'EstoqueBaixo' },
    VencimentoProximo: { classe: 'badge-warning', texto: 'VencimentoPróximo' },
    Vencido: { classe: 'badge-danger', texto: 'Vencido (Bloqueado)' },
    Esgotado: { classe: 'badge-neutral', texto: 'Esgotado' },
    Removido: { classe: 'badge-neutral', texto: 'Removido (Baixa Perda)' },
  };
  const info = mapa[estado] || { classe: 'badge-neutral', texto: estado };
  return `<span class="badge ${info.classe}">${info.texto}</span>`;
}

/**
 * Renderiza a tabela de produtos e lotes FEFO.
 */
function renderizarTabelaProdutos() {
  const categoriaFiltro = document.getElementById('filtro-categoria').value;
  const buscaFiltro = document.getElementById('filtro-busca').value.trim().toLowerCase();
  const isAdmin = estadoApp.usuario?.perfil === 'Administrador';

  const filtrados = estadoApp.produtos.filter((p) => {
    if (categoriaFiltro && p.categoria !== categoriaFiltro) return false;
    if (buscaFiltro && !p.nome.toLowerCase().includes(buscaFiltro)) return false;
    return true;
  });

  const tbody = document.getElementById('tabela-produtos-body');
  if (filtrados.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="muted">Nenhum produto encontrado para o filtro selecionado.</td></tr>';
    return;
  }

  tbody.innerHTML = filtrados
    .map((p) => {
      const lotesHTML =
        p.lotes.length === 0
          ? '<span class="muted">Sem lotes cadastrados</span>'
          : `<div class="lotes-Sublist">
              ${p.lotes
                .map(
                  (l) => `
                <div class="lote-pill">
                  <span>
                    <strong>[${l.codigoLote}]</strong> Qtd: ${l.quantidadeAtual} ${p.unidadeMedida}
                    ${l.dataValidade ? ` | Val: ${l.dataValidade}` : ''}
                  </span>
                  <span>
                    ${renderizarBadgeEstadoLote(l.estado)}
                    ${
                      isAdmin && l.estado === 'Vencido' && l.quantidadeAtual > 0
                        ? `<button class="btn btn-danger btn-sm" onclick="confirmarBaixaPerda(${l.id}, '${l.codigoLote}')">Baixar Perda</button>`
                        : ''
                    }
                  </span>
                </div>`
                )
                .join('')}
            </div>`;

      return `
        <tr>
          <td>#${p.id}</td>
          <td><strong>${p.nome}</strong></td>
          <td>${p.categoria}</td>
          <td>${p.perecivel ? '<span class="badge badge-warning">Sim (FEFO)</span>' : '<span class="badge badge-neutral">Não</span>'}</td>
          <td>R$ ${Number(p.precoVenda).toFixed(2)}</td>
          <td>
            <strong>${p.saldoDisponivel} ${p.unidadeMedida}</strong>
            ${p.estoqueBaixo ? '<div><span class="badge badge-warning">Abaixo do Mínimo (RN-II)</span></div>' : ''}
            ${p.saldoVencido > 0 ? `<div><span class="badge badge-danger">+${p.saldoVencido} vencido(s)</span></div>` : ''}
          </td>
          <td>${p.estoqueMinimo} ${p.unidadeMedida}</td>
          <td>${lotesHTML}</td>
          <td class="${isAdmin ? '' : 'hidden'}">
            <div class="btn-row">
              <button class="btn btn-outline btn-sm" onclick="prepararEdicaoProduto(${p.id})">Editar</button>
              <button class="btn btn-danger btn-sm" onclick="excluirProduto(${p.id})">Excluir</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');
}

function popularSelectsDeProdutos() {
  const selectSaida = document.getElementById('saida-produto');
  const selectEntrada = document.getElementById('entrada-produto');
  const valorAtualSaida = selectSaida.value;

  const opcoesHTML = estadoApp.produtos
    .map(
      (p) =>
        `<option value="${p.id}">${p.nome} (${p.categoria}) — Disponível: ${p.saldoDisponivel} ${p.unidadeMedida}</option>`
    )
    .join('');

  selectSaida.innerHTML = opcoesHTML;
  selectEntrada.innerHTML = opcoesHTML;

  if (valorAtualSaida && estadoApp.produtos.some((p) => String(p.id) === String(valorAtualSaida))) {
    selectSaida.value = valorAtualSaida;
  }

  atualizarLotesDaSaida();
  inicializarLinhasMassaSeVazio();
}

function atualizarLotesDaSaida() {
  const idProd = Number(document.getElementById('saida-produto').value);
  const produto = estadoApp.produtos.find((p) => p.id === idProd);
  const selectLote = document.getElementById('saida-lote');
  const containerPreview = document.getElementById('saida-resumo-lotes');

  if (!produto) {
    selectLote.innerHTML = '<option value="">Nenhum lote disponível</option>';
    containerPreview.innerHTML = '<p class="muted">Selecione um produto válido.</p>';
    return;
  }

  const lotesComSaldo = produto.lotes.filter((l) => Number(l.quantidadeAtual) > 0);

  if (lotesComSaldo.length === 0) {
    selectLote.innerHTML = '<option value="">Sem lotes com saldo (Estoque Esgotado)</option>';
    containerPreview.innerHTML = `<div class="alert-box alert-error">O produto "${produto.nome}" está com estoque esgotado (0 ${produto.unidadeMedida}).</div>`;
    return;
  }

  const primeiroLoteValido = lotesComSaldo.find((l) => !l.vencido) || lotesComSaldo[0];

  selectLote.innerHTML =
    `<option value="">Automático por FEFO (Vencimento mais próximo primeiro — RN-III)</option>` +
    lotesComSaldo
      .map(
        (l, idx) =>
          `<option value="${l.id}" ${l.id === primeiroLoteValido.id ? 'selected' : ''}>
            ${idx === 0 && !l.vencido ? '[1º FEFO] ' : ''}Lote ${l.codigoLote} | Saldo: ${l.quantidadeAtual} ${produto.unidadeMedida} | Validade: ${l.dataValidade || 'N/A'} (${l.estado})
          </option>`
      )
      .join('');

  containerPreview.innerHTML = `
    <div style="margin-bottom: 10px;">
      <strong>${produto.nome}</strong> — Saldo Disponível Total: <strong>${produto.saldoDisponivel} ${produto.unidadeMedida}</strong>
      (Mínimo: ${produto.estoqueMinimo} ${produto.unidadeMedida})
    </div>
    <div class="lotes-Sublist">
      ${lotesComSaldo
        .map(
          (l, idx) => `
          <div class="lote-pill">
            <div>
              <strong>${idx + 1}º na Fila FEFO: [${l.codigoLote}]</strong><br/>
              Saldo no Lote: <strong>${l.quantidadeAtual} ${produto.unidadeMedida}</strong> |
              Validade: <strong>${l.dataValidade || 'Não perecível'}</strong>
              ${l.diasParaVencer !== null ? ` (${l.diasParaVencer < 0 ? `Venceu há ${Math.abs(l.diasParaVencer)} dia(s)` : `Faltam ${l.diasParaVencer} dia(s)`})` : ''}
            </div>
            <div>${renderizarBadgeEstadoLote(l.estado)}</div>
          </div>
        `
        )
        .join('')}
    </div>
  `;
}

document.getElementById('saida-produto').addEventListener('change', atualizarLotesDaSaida);

/**
 * Login (RF01).
 */
document.getElementById('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const erroBox = document.getElementById('login-erro');
  erroBox.classList.add('hidden');

  const login = document.getElementById('login-input').value.trim();
  const senha = document.getElementById('senha-input').value;

  try {
    const dados = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ login, senha }),
    });

    estadoApp.token = dados.token;
    estadoApp.usuario = dados.usuario;
    localStorage.setItem('estoque_token', dados.token);
    localStorage.setItem('estoque_usuario', JSON.stringify(dados.usuario));

    document.getElementById('login-view').classList.add('hidden');
    document.getElementById('app-view').classList.remove('hidden');

    aplicarPermissoesDePerfil();
    irParaAba('tab-dashboard');
    await carregarTudo();

    const totalAlertas =
      (dados.alertasNoLogin?.estoqueBaixo?.length || 0) +
      (dados.alertasNoLogin?.validadeProximaOuVencida?.length || 0);
    exibirToast(
      `Bem-vindo(a), ${dados.usuario.nome} (${dados.usuario.perfil})! Há ${totalAlertas} alerta(s) ativo(s) no painel inicial.`,
      totalAlertas > 0 ? 'warning' : 'success'
    );
  } catch (err) {
    erroBox.textContent = err.message;
    erroBox.classList.remove('hidden');
  }
});

async function fazerLogout() {
  try {
    if (estadoApp.token) {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    }
  } catch (_) {}
  estadoApp.token = null;
  estadoApp.usuario = null;
  localStorage.removeItem('estoque_token');
  localStorage.removeItem('estoque_usuario');
  document.getElementById('app-view').classList.add('hidden');
  document.getElementById('login-view').classList.remove('hidden');
}

document.getElementById('btn-logout').addEventListener('click', fazerLogout);

/**
 * Caso de Uso RS001: Saída de Estoque.
 */
document.getElementById('form-saida').addEventListener('submit', async (e) => {
  e.preventDefault();
  const produtoId = Number(document.getElementById('saida-produto').value);
  const loteIdVal = document.getElementById('saida-lote').value;
  const loteId = loteIdVal ? Number(loteIdVal) : undefined;
  const quantidade = Number(document.getElementById('saida-quantidade').value);
  const observacao = document.getElementById('saida-obs').value.trim();

  const containerAvisos = document.getElementById('saida-avisos-resultado');
  containerAvisos.innerHTML = '';

  try {
    const res = await apiFetch('/api/estoque/saida', {
      method: 'POST',
      body: JSON.stringify({ produtoId, loteId, quantidade, observacao }),
    });

    exibirToast(res.mensagem, res.avisos && res.avisos.length > 0 ? 'warning' : 'success');

    if (res.avisos && res.avisos.length > 0) {
      containerAvisos.innerHTML = res.avisos
        .map(
          (av) =>
            `<div class="alert-item alert-item-warning" style="margin-bottom:8px;">
              <div><strong>[${av.regra}]</strong> ${av.mensagem}</div>
            </div>`
        )
        .join('');
    } else {
      containerAvisos.innerHTML = `<div class="toast toast-success" style="margin:0;">${res.mensagem}</div>`;
    }

    document.getElementById('saida-quantidade').value = '';
    document.getElementById('saida-obs').value = '';
    await carregarTudo();
  } catch (err) {
    exibirToast(err.message, 'error');
    containerAvisos.innerHTML = `<div class="alert-box alert-error">${err.message}</div>`;
  }
});

/**
 * CRUD de Produtos (RF03).
 */
document.getElementById('form-produto').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('prod-id').value;
  const payload = {
    nome: document.getElementById('prod-nome').value.trim(),
    categoria: document.getElementById('prod-categoria').value,
    unidadeMedida: document.getElementById('prod-unidade').value,
    precoVenda: Number(document.getElementById('prod-preco').value),
    estoqueMinimo: Number(document.getElementById('prod-minimo').value),
    perecivel: document.getElementById('prod-perecivel').checked,
  };

  try {
    if (id) {
      const res = await apiFetch(`/api/produtos/${id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      exibirToast(res.mensagem, 'success');
    } else {
      const res = await apiFetch('/api/produtos', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      exibirToast(res.mensagem, 'success');
    }
    limparFormProduto();
    await carregarTudo();
  } catch (err) {
    exibirToast(err.message, 'error');
  }
});

function prepararEdicaoProduto(id) {
  const p = estadoApp.produtos.find((item) => item.id === id);
  if (!p) return;
  document.getElementById('prod-id').value = p.id;
  document.getElementById('prod-nome').value = p.nome;
  document.getElementById('prod-categoria').value = p.categoria;
  document.getElementById('prod-unidade').value = p.unidadeMedida;
  document.getElementById('prod-preco').value = p.precoVenda;
  document.getElementById('prod-minimo').value = p.estoqueMinimo;
  document.getElementById('prod-perecivel').checked = Boolean(p.perecivel);
  document.getElementById('titulo-form-produto').textContent = `Editando Produto #${p.id}: ${p.nome}`;
  document.getElementById('btn-cancelar-edicao').classList.remove('hidden');
}

function limparFormProduto() {
  document.getElementById('form-produto').reset();
  document.getElementById('prod-id').value = '';
  document.getElementById('titulo-form-produto').textContent =
    'Cadastrar Novo Produto no Catálogo (Exclusivo Administrador — RF03)';
  document.getElementById('btn-cancelar-edicao').classList.add('hidden');
}

async function excluirProduto(id) {
  const p = estadoApp.produtos.find((item) => item.id === id);
  if (!p || !confirm(`Deseja realmente excluir o produto "${p.nome}" e todos os seus lotes?`)) {
    return;
  }
  try {
    const res = await apiFetch(`/api/produtos/${id}`, { method: 'DELETE' });
    exibirToast(res.mensagem, 'success');
    await carregarTudo();
  } catch (err) {
    exibirToast(err.message, 'error');
  }
}

/**
 * Entrada de Lote (RF04).
 */
document.getElementById('form-entrada').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    produtoId: Number(document.getElementById('entrada-produto').value),
    codigoLote: document.getElementById('entrada-lote').value.trim(),
    quantidade: Number(document.getElementById('entrada-quantidade').value),
    dataValidade: document.getElementById('entrada-validade').value || null,
    observacao: document.getElementById('entrada-obs').value.trim(),
  };

  try {
    const res = await apiFetch('/api/estoque/entrada', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    exibirToast(res.mensagem, 'success');
    document.getElementById('form-entrada').reset();
    await carregarTudo();
  } catch (err) {
    exibirToast(err.message, 'error');
  }
});

function preencherEntradaRapida(produtoId) {
  irParaAba('tab-entrada');
  document.getElementById('entrada-produto').value = produtoId;
  document.getElementById('entrada-lote').focus();
}

/**
 * Baixa de Perda de Lote Vencido pelo Administrador (RE-I / T16 / CT04).
 */
async function confirmarBaixaPerda(loteId, codigoLote) {
  const motivo = prompt(
    `Confirmar baixa de perda do lote vencido [${codigoLote}] (RE-I / T16)?\nInforme o motivo da baixa:`,
    'Descarte por validade expirada (RE-I)'
  );
  if (motivo === null) return;

  try {
    const res = await apiFetch('/api/estoque/perda', {
      method: 'POST',
      body: JSON.stringify({ loteId, motivo }),
    });
    exibirToast(res.mensagem, 'success');
    await carregarTudo();
  } catch (err) {
    exibirToast(err.message, 'error');
  }
}

/**
 * Operações em Massa (RF06 / T17).
 */
function inicializarLinhasMassaSeVazio() {
  const container = document.getElementById('massa-linhas-container');
  if (container.children.length === 0 && estadoApp.produtos.length > 0) {
    adicionarLinhaMassa();
    adicionarLinhaMassa();
  }
}

function adicionarLinhaMassa() {
  const container = document.getElementById('massa-linhas-container');
  const modo = document.getElementById('massa-tipo').value;
  const div = document.createElement('div');
  div.className = 'form-row massa-item-row step-box';

  const opcoesProd = estadoApp.produtos
    .map((p) => `<option value="${p.id}">${p.nome} (Saldo: ${p.saldoDisponivel} ${p.unidadeMedida})</option>`)
    .join('');

  div.innerHTML = `
    <div class="form-group">
      <label>Produto</label>
      <select class="massa-prod" required>${opcoesProd}</select>
    </div>
    <div class="form-group">
      <label>Quantidade</label>
      <input type="number" class="massa-qtd" step="0.01" min="0.01" placeholder="Ex: 3" required />
    </div>
    <div class="form-group massa-campo-entrada ${modo === 'Entrada' ? '' : 'hidden'}">
      <label>Código do Lote (Entrada)</label>
      <input type="text" class="massa-lote" placeholder="Ex: LOTE-M1" />
    </div>
    <div class="form-group massa-campo-entrada ${modo === 'Entrada' ? '' : 'hidden'}">
      <label>Validade (Se Perecível)</label>
      <input type="date" class="massa-val" />
    </div>
    <div class="form-group" style="flex: 0 0 auto; align-self: end;">
      <button type="button" class="btn btn-danger btn-sm" onclick="this.closest('.massa-item-row').remove()">Remover</button>
    </div>
  `;
  container.appendChild(div);
}

function atualizarModoMassa() {
  const modo = document.getElementById('massa-tipo').value;
  document.querySelectorAll('.massa-campo-entrada').forEach((el) => {
    el.classList.toggle('hidden', modo !== 'Entrada');
  });
}

document.getElementById('form-massa').addEventListener('submit', async (e) => {
  e.preventDefault();
  const operacao = document.getElementById('massa-tipo').value;
  const observacaoGeral = document.getElementById('massa-obs').value.trim();
  const linhas = Array.from(document.querySelectorAll('.massa-item-row'));

  const itens = linhas.map((row) => ({
    produtoId: Number(row.querySelector('.massa-prod').value),
    quantidade: Number(row.querySelector('.massa-qtd').value),
    codigoLote: row.querySelector('.massa-lote')?.value?.trim(),
    dataValidade: row.querySelector('.massa-val')?.value || null,
  }));

  try {
    const res = await apiFetch('/api/estoque/massa', {
      method: 'POST',
      body: JSON.stringify({ operacao, observacaoGeral, itens }),
    });
    exibirToast(res.mensagem, 'success');
    document.getElementById('massa-linhas-container').innerHTML = '';
    adicionarLinhaMassa();
    await carregarTudo();
  } catch (err) {
    exibirToast(err.message, 'error');
  }
});

/**
 * Histórico de Movimentações (RN-IV / T11).
 */
async function carregarMovimentacoes() {
  const tipo = document.getElementById('filtro-mov-tipo').value;
  const url = tipo ? `/api/movimentacoes?tipo=${tipo}` : '/api/movimentacoes';
  try {
    estadoApp.movimentacoes = await apiFetch(url);
    renderizarTabelaMovimentacoes();
  } catch (err) {
    exibirToast(err.message, 'error');
  }
}

function renderizarTabelaMovimentacoes() {
  const tbody = document.getElementById('tabela-movimentacoes-body');
  if (estadoApp.movimentacoes.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="muted">Nenhuma movimentação encontrada.</td></tr>';
    return;
  }

  tbody.innerHTML = estadoApp.movimentacoes
    .map((m) => {
      const badgeTipo =
        m.tipo === 'Entrada'
          ? '<span class="pill-orcamento">ENTRADA</span>'
          : m.tipo === 'Saida'
          ? '<span class="pill-venda">SAÍDA</span>'
          : '<span class="pill-perda">PERDA</span>';

      return `
        <tr>
          <td>#${m.id}</td>
          <td>${m.dataHora}</td>
          <td>${badgeTipo}</td>
          <td><strong>${m.produtoNome}</strong></td>
          <td>[${m.codigoLote}] ${m.dataValidade ? `<small>(Val: ${m.dataValidade})</small>` : ''}</td>
          <td><strong>${m.quantidade} ${m.unidadeMedida}</strong></td>
          <td>${m.usuarioNome} <span class="badge badge-neutral">${m.usuarioPerfil}</span></td>
          <td>${m.observacao || '-'}</td>
        </tr>
      `;
    })
    .join('');
}

/**
 * Relatórios Gerenciais e Exportação CSV/PDF (RF08 / RE-II).
 */
async function carregarRelatorios() {
  const container = document.getElementById('relatorios-conteudo');
  try {
    const r = await apiFetch('/api/relatorios');
    container.innerHTML = `
      <div class="colored-tiles-grid">
        <div class="color-tile tile-cyan">
          <div class="tile-body">
            <div class="tile-value">R$ ${Number(r.resumoFinanceiroPatrimonial.valorTotalPatrimonio).toFixed(2)}</div>
            <div class="tile-label">Patrimônio Total em Estoque (RE-II)</div>
          </div>
          <div class="tile-watermark">💲</div>
          <div class="tile-footer">Declaração Fiscal de Inventário</div>
        </div>
        <div class="color-tile tile-red">
          <div class="tile-body">
            <div class="tile-value">R$ ${Number(r.resumoFinanceiroPatrimonial.valorTotalPrejuizoPerdas).toFixed(2)}</div>
            <div class="tile-label">Perdas Baixadas Acumuladas</div>
          </div>
          <div class="tile-watermark">👎</div>
          <div class="tile-footer">Histórico de Vencimento (RE-I)</div>
        </div>
        <div class="color-tile tile-orange">
          <div class="tile-body">
            <div class="tile-value">${r.resumoFinanceiroPatrimonial.totalLotesVencidosPendentes}</div>
            <div class="tile-label">Lotes Vencidos Pendentes</div>
          </div>
          <div class="tile-watermark">📊</div>
          <div class="tile-footer">Aguardando Baixa pelo Admin (T16)</div>
        </div>
      </div>

      <div class="floating-tabs-grid mb-16">
        <div class="floating-tab-wrapper">
          <div class="floating-tab-header tab-header-blue">
            1. Produtos com Maior Saída — Mais Vendidos / Repostos (T19)
          </div>
          <div class="erp-card floating-tab-card">
            <table class="data-table">
              <thead>
                <tr><th>Produto</th><th>Categoria</th><th>Total Saídas</th><th>Valor Estimado</th></tr>
              </thead>
              <tbody>
                ${
                  r.produtosMaisVendidos.length === 0
                    ? '<tr><td colspan="4" class="muted">Nenhuma saída registrada.</td></tr>'
                    : r.produtosMaisVendidos
                        .map(
                          (p) =>
                            `<tr><td><strong>${p.nome}</strong></td><td>${p.categoria}</td><td>${p.totalSaidas} ${p.unidadeMedida}</td><td>R$ ${Number(p.valorEstimadoSaidas).toFixed(2)}</td></tr>`
                        )
                        .join('')
                }
              </tbody>
            </table>
          </div>
        </div>

        <div class="floating-tab-wrapper">
          <div class="floating-tab-header tab-header-red">
            2. Produtos Parados no Estoque — Sem Saídas (T19)
          </div>
          <div class="erp-card floating-tab-card">
            <table class="data-table">
              <thead>
                <tr><th>Produto</th><th>Saldo Parado</th><th>Desde</th><th>Valor Imobilizado</th></tr>
              </thead>
              <tbody>
                ${
                  r.produtosParados.length === 0
                    ? '<tr><td colspan="4" class="muted">Nenhum produto parado.</td></tr>'
                    : r.produtosParados
                        .map(
                          (p) =>
                            `<tr><td><strong>${p.nome}</strong></td><td>${p.saldoEmEstoque} ${p.unidadeMedida}</td><td>${p.entradaMaisAntiga}</td><td>R$ ${Number(p.valorParadoEmEstoque).toFixed(2)}</td></tr>`
                        )
                        .join('')
                }
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="floating-tabs-grid">
        <div class="floating-tab-wrapper">
          <div class="floating-tab-header tab-header-red">
            3. Histórico de Perdas por Vencimento e Lotes Vencidos (T19 / RE-I)
          </div>
          <div class="erp-card floating-tab-card">
            <table class="data-table">
              <thead>
                <tr><th>Status</th><th>Lote</th><th>Produto</th><th>Qtd</th><th>Prejuízo</th></tr>
              </thead>
              <tbody>
                ${r.perdasPorVencimento.perdasBaixadas
                  .map(
                    (p) =>
                      `<tr><td><span class="badge badge-neutral">Baixa Realizada</span></td><td>${p.codigoLote}</td><td>${p.produtoNome}</td><td>${p.quantidade} ${p.unidadeMedida}</td><td>R$ ${Number(p.prejuizoEstimado).toFixed(2)}</td></tr>`
                  )
                  .join('')}
                ${r.perdasPorVencimento.lotesVencidosPendentesBaixa
                  .map(
                    (v) =>
                      `<tr><td><span class="badge badge-danger">Vencido em Estoque</span></td><td>${v.codigoLote}</td><td>${v.produtoNome}</td><td>${v.quantidadeAtual} ${v.unidadeMedida}</td><td>R$ ${Number(v.prejuizoPotencial).toFixed(2)}</td></tr>`
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>

        <div class="floating-tab-wrapper">
          <div class="floating-tab-header tab-header-blue">
            4. Movimentações por Funcionário (T20 / RN-IV)
          </div>
          <div class="erp-card floating-tab-card">
            <table class="data-table">
              <thead>
                <tr><th>Funcionário</th><th>Perfil</th><th>Operações</th><th>Saídas</th><th>Entradas</th></tr>
              </thead>
              <tbody>
                ${r.movimentacoesPorFuncionario
                  .map(
                    (f) =>
                      `<tr><td><strong>${f.nome}</strong></td><td>${f.perfil}</td><td>${f.totalOperacoes}</td><td>${f.qtdTotalSaidas}</td><td>${f.qtdTotalEntradas}</td></tr>`
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  } catch (err) {
    exibirToast(err.message, 'error');
  }
}

function exportarRelatorio(formato) {
  const url =
    formato === 'csv'
      ? `/api/relatorios/exportar/csv?token=${encodeURIComponent(estadoApp.token)}`
      : `/api/relatorios/exportar/pdf?token=${encodeURIComponent(estadoApp.token)}`;
  window.open(url, '_blank');
}

/**
 * Gestão de Funcionários (RF02 / T04).
 */
async function carregarUsuarios() {
  try {
    const usuarios = await apiFetch('/api/usuarios');
    const tbody = document.getElementById('tabela-usuarios-body');
    tbody.innerHTML = usuarios
      .map(
        (u) => `
        <tr>
          <td>#${u.id}</td>
          <td><strong>${u.nome}</strong></td>
          <td><code>${u.login}</code></td>
          <td><span class="badge ${u.perfil === 'Administrador' ? 'badge-admin' : 'badge-func'}">${u.perfil}</span></td>
          <td>${u.totalMovimentacoes} reg.</td>
          <td>
            ${
              u.id !== estadoApp.usuario.id && u.totalMovimentacoes === 0
                ? `<button class="btn btn-danger btn-sm" onclick="removerUsuario(${u.id})">Excluir</button>`
                : '<small class="muted">Ativo</small>'
            }
          </td>
        </tr>
      `
      )
      .join('');
  } catch (err) {
    exibirToast(err.message, 'error');
  }
}

document.getElementById('form-usuario').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    nome: document.getElementById('usr-nome').value.trim(),
    login: document.getElementById('usr-login').value.trim(),
    senha: document.getElementById('usr-senha').value,
    perfil: document.getElementById('usr-perfil').value,
  };
  try {
    const res = await apiFetch('/api/usuarios', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    exibirToast(res.mensagem, 'success');
    document.getElementById('form-usuario').reset();
    carregarUsuarios();
  } catch (err) {
    exibirToast(err.message, 'error');
  }
});

async function removerUsuario(id) {
  if (!confirm('Deseja remover este funcionário?')) return;
  try {
    const res = await apiFetch(`/api/usuarios/${id}`, { method: 'DELETE' });
    exibirToast(res.mensagem, 'success');
    carregarUsuarios();
  } catch (err) {
    exibirToast(err.message, 'error');
  }
}

async function testarBloqueioCT01() {
  try {
    await apiFetch('/api/produtos', {
      method: 'POST',
      body: JSON.stringify({
        nome: 'Produto Teste Não Autorizado',
        categoria: 'Mercearia Seca',
        unidadeMedida: 'unidade',
        precoVenda: 10,
      }),
    });
  } catch (err) {
    exibirToast(`[CT01 Comprovado - HTTP ${err.status}] ${err.message}`, 'error');
  }
}

// Configura cliques nos links do menu lateral
document.querySelectorAll('.sidebar-link').forEach((btn) => {
  btn.addEventListener('click', () => irParaAba(btn.dataset.tab));
});

// Verifica sessão existente
window.addEventListener('DOMContentLoaded', async () => {
  if (estadoApp.token && estadoApp.usuario) {
    document.getElementById('login-view').classList.add('hidden');
    document.getElementById('app-view').classList.remove('hidden');
    aplicarPermissoesDePerfil();
    await carregarTudo();
  }
});
