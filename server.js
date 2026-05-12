const express = require('express');
const { Pool } = require('pg');
const app = express();

app.use(express.json());

const SENHA_ADMIN = process.env.SENHA_ADMIN || 'MINHA_SENHA_123';

// =============================================
// CONEXÃO COM O BANCO POSTGRESQL
// =============================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Testar conexão
pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Erro ao conectar ao PostgreSQL:', err.message);
    } else {
        console.log('✅ Conectado ao PostgreSQL no Render');
        release();
    }
});

// =============================================
// FUNÇÕES AUXILIARES
// =============================================
function limparCnpj(cnpj) {
    if (!cnpj) return '';
    return cnpj.replace(/[^0-9]/g, '');
}

function formatarCnpj(cnpj) {
    const numeros = limparCnpj(cnpj);
    if (numeros.length !== 14) return cnpj;
    return numeros.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

// =============================================
// ROTA: REGISTRAR EMPRESA (PRIMEIRO LOGIN)
// =============================================
app.post('/registrar', async (req, res) => {
    const { cnpj, razao_social, nome_fantasia, email, telefone, plano, valor_mensal } = req.body;

    const cnpjLimpo = limparCnpj(cnpj);
    const cnpjFormatado = formatarCnpj(cnpjLimpo);

    if (!cnpjLimpo || (!razao_social && !nome_fantasia)) {
        return res.status(400).json({
            erro: 'CNPJ e RAZAO_SOCIAL ou NOME_FANTASIA são obrigatórios'
        });
    }

    try {
        // Verificar se empresa já existe
        const result = await pool.query(
            'SELECT COD_EMP, CNPJ, NOME_FANTASIA, BLOQUEADO FROM EMPRESAS WHERE CNPJ = $1',
            [cnpjFormatado]
        );

        if (result.rows.length > 0) {
            const empresa = result.rows[0];

            // Verificar parcelas pendentes
            const parcelasResult = await pool.query(
                `SELECT COUNT(*) as total FROM PARCELAS 
                 WHERE COD_EMP = $1 AND PAGO = FALSE AND DATA_VENCIMENTO < CURRENT_DATE`,
                [empresa.cod_emp]
            );

            const temPendencia = parcelasResult.rows[0].total > 0;
            const liberado = !empresa.bloqueado && !temPendencia;

            return res.json({
                sucesso: true,
                mensagem: 'Empresa já cadastrada',
                cod_emp: empresa.cod_emp,
                liberado: liberado,
                pendente: temPendencia
            });
        }

        // Empresa nova - cadastrar
        const nomeRazaosocial = razao_social || nome_fantasia;
        const nomeFantasiaFinal = nome_fantasia || razao_social;

        const insertResult = await pool.query(
            `INSERT INTO EMPRESAS 
             (CNPJ, RAZAO_SOCIAL, NOME_FANTASIA, EMAIL, TELEFONE, PLANO, VALOR_MENSAL, DATA_CADASTRO, ATIVO, BLOQUEADO) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), TRUE, TRUE) 
             RETURNING COD_EMP`,
            [cnpjFormatado, nomeRazaosocial, nomeFantasiaFinal, email || null, telefone || null, plano || 'MENSAL', valor_mensal || 299.90]
        );

        const codEmp = insertResult.rows[0].cod_emp;

        // Gerar 12 parcelas para o primeiro ano
        const hoje = new Date();
        for (let i = 1; i <= 12; i++) {
            const vencimento = new Date(hoje);
            vencimento.setMonth(hoje.getMonth() + i);
            const dataVencimento = vencimento.toISOString().split('T')[0];

            await pool.query(
                `INSERT INTO PARCELAS (COD_EMP, NUMERO_PARCELA, VALOR, DATA_VENCIMENTO, PAGO) 
                 VALUES ($1, $2, $3, $4, FALSE)`,
                [codEmp, i, valor_mensal || 299.90, dataVencimento]
            );
        }

        console.log(`✅ Nova empresa cadastrada: ${cnpjLimpo} - ${nomeFantasiaFinal}`);

        res.json({
            sucesso: true,
            mensagem: 'Empresa cadastrada com sucesso',
            cod_emp: codEmp,
            liberado: false,
            pendente: true
        });

    } catch (error) {
        console.error('Erro ao registrar empresa:', error);
        res.status(500).json({ erro: 'Erro interno ao cadastrar empresa' });
    }
});

// =============================================
// ROTA: VERIFICAR SE ESTÁ LIBERADO
// =============================================
app.get('/verificar/:cnpj', async (req, res) => {
    const cnpj = limparCnpj(req.params.cnpj);
    const cnpjFormatado = formatarCnpj(cnpj);

    try {
        const result = await pool.query(
            'SELECT COD_EMP, BLOQUEADO FROM EMPRESAS WHERE CNPJ = $1',
            [cnpjFormatado]
        );

        if (result.rows.length === 0) {
            return res.json({
                liberado: false,
                cadastrado: false,
                mensagem: 'Empresa não cadastrada'
            });
        }

        const empresa = result.rows[0];

        const parcelasResult = await pool.query(
            `SELECT COUNT(*) as total FROM PARCELAS 
             WHERE COD_EMP = $1 AND PAGO = FALSE AND DATA_VENCIMENTO < CURRENT_DATE`,
            [empresa.cod_emp]
        );

        const temPendencia = parcelasResult.rows[0].total > 0;
        const liberado = !empresa.bloqueado && !temPendencia;

        console.log(`Verificação: ${cnpj} - Liberado: ${liberado}`);

        res.json({
            liberado: liberado,
            cadastrado: true,
            pendente: temPendencia,
            parcelas_vencidas: parcelasResult.rows[0].total
        });

    } catch (error) {
        console.error('Erro ao verificar:', error);
        res.status(500).json({ erro: 'Erro ao verificar status' });
    }
});

// =============================================
// ROTA: MARCAR COMO LIBERADO (ADMIN)
// =============================================
app.post('/liberar/:cnpj', async (req, res) => {
    const senha = req.headers['x-senha'];
    const cnpj = limparCnpj(req.params.cnpj);
    const cnpjFormatado = formatarCnpj(cnpj);

    if (senha !== SENHA_ADMIN) {
        return res.status(401).json({ erro: 'Senha inválida' });
    }

    try {
        const result = await pool.query(
            'SELECT COD_EMP FROM EMPRESAS WHERE CNPJ = $1',
            [cnpjFormatado]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ erro: 'Empresa não encontrada' });
        }

        const codEmp = result.rows[0].cod_emp;

        // Desbloquear empresa
        await pool.query(
            'UPDATE EMPRESAS SET BLOQUEADO = FALSE, MOTIVO_BLOQUEIO = NULL WHERE COD_EMP = $1',
            [codEmp]
        );

        // Marcar primeira parcela pendente como paga
        const parcelaResult = await pool.query(
            `SELECT COD_PAR FROM PARCELAS 
             WHERE COD_EMP = $1 AND PAGO = FALSE 
             ORDER BY NUMERO_PARCELA ASC LIMIT 1`,
            [codEmp]
        );

        if (parcelaResult.rows.length > 0) {
            await pool.query(
                'UPDATE PARCELAS SET PAGO = TRUE, DATA_PAGAMENTO = NOW() WHERE COD_PAR = $1',
                [parcelaResult.rows[0].cod_par]
            );
        }

        // Registrar no histórico de bloqueios
        await pool.query(
            `INSERT INTO BLOQUEIOS (COD_EMP, DATA_DESBLOQUEIO, MOTIVO, RESPONSAVEL_DESBLOQUEIO) 
             VALUES ($1, NOW(), 'DESBLOQUEIO_PAGAMENTO', 'ADMIN')`,
            [codEmp]
        );

        console.log(`✅ Cliente liberado: ${cnpj}`);

        res.json({ liberado: true, cnpj: cnpj });

    } catch (error) {
        console.error('Erro ao liberar:', error);
        res.status(500).json({ erro: 'Erro ao liberar empresa' });
    }
});

// =============================================
// ROTA: LISTAR TODAS EMPRESAS (ADMIN)
// =============================================
app.get('/empresas', async (req, res) => {
    const senha = req.headers['x-senha'];

    if (senha !== SENHA_ADMIN) {
        return res.status(401).json({ erro: 'Senha inválida' });
    }

    try {
        const result = await pool.query(`
            SELECT E.COD_EMP, E.CNPJ, E.NOME_FANTASIA, E.RAZAO_SOCIAL, E.EMAIL, 
                   E.BLOQUEADO, E.PLANO, E.VALOR_MENSAL,
                   COUNT(P.COD_PAR) AS TOTAL_PARCELAS,
                   SUM(CASE WHEN P.PAGO = FALSE AND P.DATA_VENCIMENTO < CURRENT_DATE THEN 1 ELSE 0 END) AS PARCELAS_PENDENTES
            FROM EMPRESAS E
            LEFT JOIN PARCELAS P ON E.COD_EMP = P.COD_EMP
            GROUP BY E.COD_EMP, E.CNPJ, E.NOME_FANTASIA, E.RAZAO_SOCIAL, E.EMAIL, E.BLOQUEADO, E.PLANO, E.VALOR_MENSAL
        `);

        res.json({ empresas: result.rows });

    } catch (error) {
        console.error('Erro ao listar empresas:', error);
        res.status(500).json({ erro: 'Erro ao listar empresas' });
    }
});

// =============================================
// ROTA: LISTAR PARCELAS DE UMA EMPRESA (ADMIN)
// =============================================
app.get('/parcelas/:cnpj', async (req, res) => {
    const senha = req.headers['x-senha'];
    const cnpj = limparCnpj(req.params.cnpj);
    const cnpjFormatado = formatarCnpj(cnpj);

    if (senha !== SENHA_ADMIN) {
        return res.status(401).json({ erro: 'Senha inválida' });
    }

    try {
        const empresaResult = await pool.query(
            'SELECT COD_EMP FROM EMPRESAS WHERE CNPJ = $1',
            [cnpjFormatado]
        );

        if (empresaResult.rows.length === 0) {
            return res.status(404).json({ erro: 'Empresa não encontrada' });
        }

        const codEmp = empresaResult.rows[0].cod_emp;

        const parcelasResult = await pool.query(
            `SELECT NUMERO_PARCELA, VALOR, DATA_VENCIMENTO, 
                    DATA_PAGAMENTO, PAGO, JUROS, MULTA, FORMA_PAGAMENTO
             FROM PARCELAS 
             WHERE COD_EMP = $1 
             ORDER BY NUMERO_PARCELA ASC`,
            [codEmp]
        );

        const parcelas = parcelasResult.rows.map(row => ({
            numero_parcela: row.numero_parcela,
            valor: parseFloat(row.valor),
            data_vencimento: row.data_vencimento ? new Date(row.data_vencimento).toISOString().split('T')[0] : null,
            data_pagamento: row.data_pagamento ? new Date(row.data_pagamento).toISOString().split('T')[0] : null,
            pago: row.pago,
            juros: parseFloat(row.juros) || 0,
            multa: parseFloat(row.multa) || 0,
            forma_pagamento: row.forma_pagamento || '-'
        }));

        res.json({ parcelas: parcelas });

    } catch (error) {
        console.error('Erro ao listar parcelas:', error);
        res.status(500).json({ erro: 'Erro ao listar parcelas' });
    }
});

// =============================================
// ROTA: DAR BAIXA EM UMA PARCELA ESPECÍFICA
// =============================================
app.post('/baixar-parcela/:cnpj/:numero', async (req, res) => {
    const senha = req.headers['x-senha'];
    const cnpj = limparCnpj(req.params.cnpj);
    const numero = parseInt(req.params.numero);
    const { forma_pagamento } = req.body;

    console.log(`📌 Requisição de baixa - CNPJ: ${cnpj}, Parcela: ${numero}, Forma: ${forma_pagamento}`);
    console.log(`🔑 Senha recebida: ${senha}`);

    if (senha !== SENHA_ADMIN) {
        console.log(`❌ Senha inválida: ${senha}`);
        return res.status(401).json({ erro: 'Senha inválida' });
    }

    try {
        const cnpjFormatado = formatarCnpj(cnpj);
        console.log(`🔍 Buscando empresa com CNPJ: ${cnpjFormatado}`);

        const empresaResult = await pool.query(
            'SELECT COD_EMP FROM EMPRESAS WHERE CNPJ = $1',
            [cnpjFormatado]
        );

        if (empresaResult.rows.length === 0) {
            console.log(`❌ Empresa não encontrada para o CNPJ: ${cnpjFormatado}`);
            return res.status(404).json({ erro: 'Empresa não encontrada' });
        }

        const codEmp = empresaResult.rows[0].cod_emp;
        console.log(`✅ Empresa encontrada - COD_EMP: ${codEmp}`);

        const updateResult = await pool.query(
            `UPDATE PARCELAS 
             SET PAGO = TRUE, DATA_PAGAMENTO = NOW(), FORMA_PAGAMENTO = $1 
             WHERE COD_EMP = $2 AND NUMERO_PARCELA = $3
             RETURNING *`,
            [forma_pagamento || 'BAIXA MANUAL', codEmp, numero]
        );

        if (updateResult.rowCount === 0) {
            console.log(`❌ Parcela ${numero} não encontrada para empresa ${codEmp}`);
            return res.status(404).json({ erro: 'Parcela não encontrada' });
        }

        console.log(`✅ Parcela ${numero} da empresa ${cnpj} recebeu baixa - Forma: ${forma_pagamento}`);
        res.json({ sucesso: true, mensagem: 'Baixa realizada com sucesso', parcela: updateResult.rows[0] });

    } catch (error) {
        console.error('❌ Erro ao dar baixa:', error);
        res.status(500).json({ erro: 'Erro ao dar baixa na parcela', detalhe: error.message });
    }
});

// =============================================
// ROTA: CANCELAR BAIXA DE UMA PARCELA
// =============================================
app.post('/cancelar-baixa-parcela/:cnpj/:numero', async (req, res) => {
    const senha = req.headers['x-senha'];
    const cnpj = limparCnpj(req.params.cnpj);
    const numero = parseInt(req.params.numero);

    console.log(`📌 Requisição de cancelamento - CNPJ: ${cnpj}, Parcela: ${numero}`);

    if (senha !== SENHA_ADMIN) {
        console.log(`❌ Senha inválida: ${senha}`);
        return res.status(401).json({ erro: 'Senha inválida' });
    }

    try {
        const cnpjFormatado = formatarCnpj(cnpj);

        const empresaResult = await pool.query(
            'SELECT COD_EMP FROM EMPRESAS WHERE CNPJ = $1',
            [cnpjFormatado]
        );

        if (empresaResult.rows.length === 0) {
            return res.status(404).json({ erro: 'Empresa não encontrada' });
        }

        const codEmp = empresaResult.rows[0].cod_emp;

        await pool.query(
            `UPDATE PARCELAS 
             SET PAGO = FALSE, DATA_PAGAMENTO = NULL, FORMA_PAGAMENTO = NULL 
             WHERE COD_EMP = $1 AND NUMERO_PARCELA = $2`,
            [codEmp, numero]
        );

        console.log(`✅ Baixa da parcela ${numero} da empresa ${cnpj} foi cancelada`);
        res.json({ sucesso: true, mensagem: 'Baixa cancelada com sucesso' });

    } catch (error) {
        console.error('❌ Erro ao cancelar baixa:', error);
        res.status(500).json({ erro: 'Erro ao cancelar baixa da parcela' });
    }
});

// ROTA: GERAR MÚLTIPLAS PARCELAS
app.post('/gerar-parcelas/:cnpj', async (req, res) => {
    const senha = req.headers['x-senha'];
    const cnpj = limparCnpj(req.params.cnpj);
    const { parcelas } = req.body;

    if (senha !== SENHA_ADMIN) {
        return res.status(401).json({ erro: 'Senha inválida' });
    }

    try {
        const cnpjFormatado = formatarCnpj(cnpj);

        const empresaResult = await pool.query(
            'SELECT COD_EMP FROM EMPRESAS WHERE CNPJ = $1',
            [cnpjFormatado]
        );

        if (empresaResult.rows.length === 0) {
            return res.status(404).json({ erro: 'Empresa não encontrada' });
        }

        const codEmp = empresaResult.rows[0].cod_emp;

        // Inserir as parcelas
        for (const parcela of parcelas) {
            await pool.query(
                `INSERT INTO PARCELAS (COD_EMP, NUMERO_PARCELA, VALOR, DATA_VENCIMENTO, PAGO) 
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (COD_EMP, NUMERO_PARCELA) DO UPDATE SET 
                 VALOR = EXCLUDED.VALOR, DATA_VENCIMENTO = EXCLUDED.DATA_VENCIMENTO`,
                [codEmp, parcela.numero_parcela, parcela.valor, parcela.data_vencimento, parcela.pago]
            );
        }

        console.log(`✅ Geradas ${parcelas.length} parcelas para empresa ${cnpj}`);
        res.json({ sucesso: true, mensagem: `${parcelas.length} parcelas geradas com sucesso` });

    } catch (error) {
        console.error('Erro ao gerar parcelas:', error);
        res.status(500).json({ erro: 'Erro ao gerar parcelas' });
    }
});

// Rota para remover liberação (bloquear novamente)
app.delete('/bloquear/:cnpj', async (req, res) => {
    const senha = req.headers['x-senha'];
    const cnpj = limparCnpj(req.params.cnpj);
    const cnpjFormatado = formatarCnpj(cnpj);

    if (senha !== SENHA_ADMIN) {
        return res.status(401).json({ erro: 'Senha inválida' });
    }

    try {
        const result = await pool.query(
            'UPDATE EMPRESAS SET BLOQUEADO = TRUE, MOTIVO_BLOQUEIO = "BLOQUEIO MANUAL" WHERE CNPJ = $1 RETURNING COD_EMP',
            [cnpjFormatado]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ erro: 'Empresa não encontrada' });
        }

        console.log(`🔒 Cliente bloqueado: ${cnpj}`);
        res.json({ bloqueado: true, cnpj: cnpj });

    } catch (error) {
        console.error('Erro ao bloquear:', error);
        res.status(500).json({ erro: 'Erro ao bloquear empresa' });
    }
});

// =============================================
// ROTA INICIAL
// =============================================
app.get('/', (req, res) => {
    res.json({
        api: "API Desbloqueio - Funcionando com PostgreSQL!",
        status: "online",
        versao: "2.0.0"
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 API rodando na porta ${PORT}`);
    console.log(`📋 Endpoints disponíveis:`);
    console.log(`   POST /registrar - Cadastrar empresa`);
    console.log(`   GET  /verificar/:cnpj`);
    console.log(`   POST /liberar/:cnpj`);
    console.log(`   GET  /empresas - Listar todas`);
    console.log(`   GET  /`);
});