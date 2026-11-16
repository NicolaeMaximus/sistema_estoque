# Sistema de Controle de Estoque da Mercearia (MVP)

**UNIVERSIDADE FEDERAL DE ITAJUBÁ – UNIFEI**  
**Disciplina:** ECOT11A – Laboratório de Engenharia de Software I  
**Professor:** Edvard  
**Autor:** Nicolae Lopes — **Matrícula:** `2024014650`  
**Repositório Oficial:** [https://github.com/NicolaeMaximus/sistema_estoque](https://github.com/NicolaeMaximus/sistema_estoque)

---

## 1. Breve Descrição da Proposta do Software

O **Sistema de Controle de Estoque da Mercearia** é uma aplicação web desenvolvida para solucionar os dois principais problemas operacionais de uma mercearia de pequeno porte:
1. **Ruptura de gôndola (falta de mercadoria):** controlada através da definição de um **estoque mínimo por item (`RN-II`)**, emitindo avisos imediatos de reposição assim que o usuário faz login ou realiza uma baixa.
2. **Perda de produtos perecíveis por vencimento:** controlada por meio do gerenciamento de **validade por lote (`RE-I`)**, priorização automática de saída pelo critério **FEFO (*First Expired, First Out* — `RN-III`)**, alertas de lotes que vencem em até 7 dias e **bloqueio automático de saída comum de lotes vencidos (`T16`)**, permitindo apenas a baixa formal de perda pelo Administrador.

> **Escopo Negativo (O que o sistema não faz):** O sistema não atua como frente de caixa (PDV) em tempo real nem emite nota fiscal, mantendo o foco exclusivo na gestão de estoque, lotes, alertas e relatórios gerenciais/patrimoniais (`RE-II`).

---

## 2. Arquitetura e Tecnologias Utilizadas (Seções 7 e 9)

O projeto implementa uma arquitetura **Cliente-Servidor em 3 camadas (Padrão MVC)**:

* **Camada de Apresentação (`public/`):** HTML5, CSS3 e JavaScript puro (*Vanilla JS*), estruturada para exibir alertas separados de Estoque Baixo e Validade logo após o login e permitir o registro de saída em no máximo 3 passos (`RNF04`).
* **Camada de Aplicação / Negócio (`src/controllers/` e `src/middleware/`):** Servidor em **Node.js** com **Express**, implementando autenticação com hash criptográfico (`SHA-256` / `scrypt` via módulo nativo `crypto`), controle de acesso por perfil (`Administrador` vs `Funcionário` com bloqueio `HTTP 403` — `RNF02`), máquina de estados do ciclo de vida do lote (`T14`) e validação estrita das regras de negócio (`RN-I` a `RN-IV`, `RE-I` e `RE-II`).
* **Camada de Dados (`src/database/db.js`):** Banco de dados relacional **SQLite** (`estoque.db` via módulo nativo `node:sqlite`), garantindo persistência local imediata e transações atômicas **ACID (`RNF03`)**.

```text
sistema-estoque-mercearia/
├── public/
│   ├── index.html                  # Interface gráfica principal (Login, Alertas, Saída em 3 passos, CRUD e Relatórios)
│   ├── styles.css                  # Estilização responsiva e alto contraste visual (RNF04)
│   └── app.js                      # Lógica de integração Front-end e ordenação visual FEFO
├── src/
│   ├── controllers/
│   │   ├── authController.js       # Login, sessões, alertas no login e gestão de funcionários (RF01, RF02, T03, T04)
│   │   ├── produtoController.js    # CRUD de produtos nas 5 categorias e cálculo de saldos (RF03, T05, T06)
│   │   ├── estoqueController.js    # Entrada/Saída de lotes, FEFO, estados, bloqueio de vencidos e massa (RF04–RF07)
│   │   └── relatorioController.js  # Relatórios gerenciais e exportação CSV/PDF (RF08, RE-II, T19–T21)
│   ├── database/
│   │   └── db.js                   # Modelagem física SQLite, transações ACID, máquina de estados e seed inicial (T01, T02)
│   ├── middleware/
│   │   └── authMiddleware.js       # Controle de sessão e bloqueio HTTP 403 por perfil (RNF02, CT01)
│   └── server.js                   # Ponto de entrada do servidor Express e definição das rotas REST
├── tests/
│   └── ct_suite.test.js            # Suíte automatizada de testes validando os Casos CT01 a CT05 e RNFs
├── package.json
└── README.md
```

---

## 3. Passo a Passo para Compilar e Executar Localmente

### Pré-requisitos
* **Node.js** (versão 22.5+ ou 24.x recomendada, que já inclui o suporte nativo ao SQLite `node:sqlite`) e **npm**.

### 1º Passo: Clonar o repositório e instalar as dependências
No terminal, execute:
```bash
git clone https://github.com/NicolaeMaximus/sistema_estoque.git
cd sistema_estoque
npm install
```

### 2º Passo: Executar a suíte de testes automatizados (`CT01` a `CT05`)
Para comprovar no terminal que todos os requisitos e casos de teste da Seção 10 do Documento de Software funcionam perfeitamente, execute:
```bash
npm test
```

### 3º Passo: Iniciar o servidor da aplicação
```bash
npm start
```
O servidor será iniciado automaticamente e criará/populará o arquivo `estoque.db` com dados realistas de demonstração. Acesse no navegador:
👉 **[http://localhost:3000](http://localhost:3000)**

---

## 4. Credenciais de Acesso para Avaliação

Na tela de login, você pode clicar nos botões de preenchimento rápido ou utilizar as credenciais abaixo:

| Perfil | Login | Senha | Permissões no Sistema (`RF01` / `RNF02`) |
| :--- | :--- | :--- | :--- |
| **Administrador (Dono)** | `admin` | `admin123` | Acesso completo: CRUD de produtos e funcionários, entrada de lotes, saída de estoque, baixa de perdas de lotes vencidos e relatórios com exportação CSV/PDF. |
| **Funcionário (Caixa)** | `carlos` | `func123` | Acesso operacional: Visualização de alertas no painel inicial, consulta de produtos/lotes e registro de saída de estoque. Tentativas de cadastro retornam `HTTP 403` (`CT01`). |
| **Funcionário (Reposição)** | `mariana` | `func123` | Acesso operacional (mesmas permissões de Funcionário). |

---

## 5. Roteiro Rápido para Validação dos Casos de Teste (Seção 10)

1. **`CT01` (Controle de Perfil e Bloqueio `HTTP 403` — `RF01`, `RF02`, `RNF02`):**
   * Entre como Funcionário (`carlos` / `func123`). Na **Aba 1 (Tela Inicial)**, clique no botão *"Simular Tentativa de Cadastrar Produto como Funcionário (CT01)"* para visualizar o bloqueio `HTTP 403 Forbidden`.
2. **`CT02` (Verificação de Disponibilidade — `RF05`, `RN-I`, `RS001`):**
   * Na **Aba 2 (Registrar Saída em 3 Passos)**, selecione qualquer produto e informe uma quantidade maior que o saldo disponível no lote. O sistema impedirá a baixa e informará o saldo exato disponível.
3. **`CT03` (Priorização FEFO e Alerta de Validade — `RF05`, `RF07`, `RN-III`):**
   * Na **Aba 2**, selecione o produto **Leite Integral 1L** (perecível com 2 lotes cadastrados). Observe que o lote `LOTE-LEI-101` (que vence em 4 dias) aparece em **1º lugar na fila FEFO** e já vem pré-selecionado, emitindo alerta de vencimento próximo ($\le 7$ dias).
4. **`CT04` (Bloqueio de Lote Vencido e Baixa de Perda — `RE-I`, `T16`):**
   * Na **Aba 2**, selecione **Iogurte Natural 170g** e escolha o lote vencido `LOTE-IOG-090`. Ao tentar registrar uma saída normal, o sistema bloqueia a operação (`RE-I`). Em seguida, logado como **Administrador** (`admin` / `admin123`), clique em **"Baixar Perda (T16)"** no alerta do lote vencido para transferi-lo para o estado `Removido` e contabilizá-lo no relatório de perdas.
5. **`CT05` (Alerta de Estoque Baixo e Vínculo ao Funcionário — `RF07`, `RN-II`, `RN-IV`):**
   * Registre uma saída de **Suco de Laranja Integral 1L** (ex.: 10 litros) até que o saldo restante fique $\le 6$ litros (estoque mínimo). O sistema emitirá imediatamente o aviso de **Estoque Baixo** e registrará a operação em nome do usuário logado na **Aba 6 (Histórico)**.
